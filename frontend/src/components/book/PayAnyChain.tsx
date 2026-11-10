"use client";
// Pay from any chain: buy an outcome with a coin on another chain (SOL, BTC, USDC on Base, ...) through NEAR Intents.
// 1Click turns the coin into USDG on Robinhood Chain and delivers it to this order's own deposit address; our relayer
// then executes the order and the outcome tokens land in the connected wallet. If the price moves past the order's
// minimum before it can execute, the USDG is refunded to the wallet on Robinhood Chain after the deadline.
import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, parseUnits, type Address, type EIP1193Provider } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { robinhoodChain, TARGET_CHAIN_ID } from "@/lib/config";
import { OB, USDG } from "@/lib/orderbook/config";
import { forwarderAbi, orderFromJson } from "@/lib/orderbook/intents";
import IntentProgress from "./IntentProgress";
import { fmtAmount } from "@/lib/orderbook/math";
import { marketPhase, type BookMarket } from "@/lib/orderbook/read";
import { ActionButton, Label, Panel } from "./ui";
import { connectSolana, isEvmChain, isSolana, reportDeposit, sendEvm, sendSolana, solanaWallets, walletErrorText, type SolWallet } from "@/lib/orderbook/walletPay";

type Token = { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number; contractAddress?: string | null };
type OrderJson = { user: string; marketId: string; outcome: number; minOut: string; deadline: string; nonce: string };
type Plan = {
  usdgExpected: string; usdgMin: string; secondsToDeliver: number | null; outcomeExpected?: string; minOut?: string;
  order?: OrderJson; forwarderDeposit?: `0x${string}`; depositAddress?: string | null; depositMemo?: string | null; quoteDeadline?: number; local?: boolean;
};
type Pending = Plan & { order: OrderJson; forwarderDeposit: `0x${string}`; token: Token; amountText: string; outcomeName: string; amountUnits?: string; action?: string; status?: string | null; tx?: string; note?: string; sentTx?: string; sentAt?: number; arrivedAt?: number; seen?: boolean };

const EXPLORER = robinhoodChain.blockExplorers.default.url;
const CHAIN_NAMES: Record<string, string> = {
  sol: "Solana", eth: "Ethereum", base: "Base", arb: "Arbitrum", btc: "Bitcoin", near: "NEAR", bsc: "BNB Chain", pol: "Polygon",
  op: "Optimism", avax: "Avalanche", ton: "TON", tron: "Tron", sui: "Sui", doge: "Dogecoin", xrp: "XRP Ledger", zec: "Zcash",
  gnosis: "Gnosis", bera: "Berachain", ltc: "Litecoin", aptos: "Aptos", cardano: "Cardano", stellar: "Stellar", monad: "Monad",
};
const chainName = (c: string) => CHAIN_NAMES[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
const FINAL = ["done", "refunded", "refunded_onchain", "failed", "expired"];
const storeKey = (marketId: number, user?: string) => `pfwa-intent-${marketId}-${(user ?? "").toLowerCase()}`;

function load(key: string): Pending | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as Pending) : null; } catch { return null; }
}
function save(key: string, p: Pending | null) {
  try { if (p) localStorage.setItem(key, JSON.stringify(p)); else localStorage.removeItem(key); } catch { /* storage blocked */ }
}

function stage(p: Pending): { text: string; busy: boolean } {
  if (p.action === "done") return { text: `Bought. Your ${p.outcomeName} tokens are in your wallet.`, busy: false };
  if (p.action === "refunded_onchain") return { text: "The price moved past your minimum, so the USDG was refunded to your wallet on Robinhood Chain.", busy: false };
  if (p.action === "refunded") return { text: `NEAR Intents refunded your ${p.token.symbol} on ${chainName(p.token.blockchain)}.`, busy: false };
  if (p.action === "failed") return { text: "NEAR Intents couldn't complete the swap; it refunds to your address on the chain you paid from.", busy: false };
  if (p.action === "expired") return { text: "The deposit address expired without a deposit. Start over for a new one.", busy: false };
  if (p.action === "execute" || p.action === "refund") return { text: "USDG arrived on Robinhood Chain. Buying your tokens…", busy: true };
  if (p.status === "KNOWN_DEPOSIT_TX" || p.status === "PROCESSING") return { text: "Deposit seen. NEAR Intents is turning it into USDG on Robinhood Chain…", busy: true };
  if (p.status === "SUCCESS") return { text: "USDG delivered. Waiting for Robinhood Chain to show it…", busy: true };
  if (p.status === "INCOMPLETE_DEPOSIT") return { text: "The deposit was less than the quote. Send the rest, or wait for the refund.", busy: true };
  return { text: p.local ? "Waiting for the USDG (local chain: use the button below)." : "Waiting for your deposit…", busy: true };
}

export default function PayAnyChain({ market, outcomeIndex, onDone }: { market: BookMarket; outcomeIndex: number; onDone: () => void }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const outcome = market.outcomes[Math.min(outcomeIndex, market.outcomes.length - 1)];
  const key = storeKey(market.id, address);

  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [chain, setChain] = useState("sol");
  const [assetId, setAssetId] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [refundTo, setRefundTo] = useState("");
  const [priced, setPriced] = useState<{ key: string; plan: Plan } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [opening, setOpening] = useState(false);
  // The open order per wallet and market, kept in this browser so a reload picks it up again.
  const [opened, setOpened] = useState<Record<string, Pending | null>>({});
  const [copied, setCopied] = useState(false);
  const { connector } = useAccount();
  // Solana: the Wallet Standard wallet the user connected for this payment (Phantom, Solflare, Backpack, ...).
  const [solWallets, setSolWallets] = useState<SolWallet[]>([]);
  const [sol, setSol] = useState<{ wallet: SolWallet; account: Parameters<typeof sendSolana>[0]["account"] } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [refundEdited, setRefundEdited] = useState(false);
  useEffect(() => { setSolWallets(solanaWallets()); }, []);

  useEffect(() => {
    fetch("/api/intents/tokens").then((r) => r.json()).then((d) => (d.tokens ? setTokens(d.tokens) : setLoadErr(d.error ?? "Couldn't load coins"))).catch(() => setLoadErr("Couldn't reach NEAR Intents"));
  }, []);
  const pending: Pending | null = !address ? null : key in opened ? opened[key] : load(key);
  const setPending = (p: Pending | null) => setOpened((o) => ({ ...o, [key]: p }));
  // The latest order, for the poll (its effect outlives renders) so it never writes back an older copy.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // null: decide from the order (a finished order the buyer already closed, or one finished a while ago, stays shut).
  const [showProgress, setShowProgress] = useState<boolean | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishErr, setFinishErr] = useState<string | null>(null);

  const chains = useMemo(() => [...new Set((tokens ?? []).map((t) => t.blockchain))].sort((a, b) => chainName(a).localeCompare(chainName(b))), [tokens]);
  const coins = useMemo(() => (tokens ?? []).filter((t) => t.blockchain === chain), [tokens, chain]);
  const token = coins.find((t) => t.assetId === assetId) ?? coins.find((t) => t.symbol === (chain === "sol" ? "SOL" : chain === "btc" ? "BTC" : "USDC")) ?? coins[0];

  // Where a refund goes: the connected wallet's own address when it can pay on this chain (the same EVM address on
  // every EVM chain; the connected Solana account), unless the user typed one.
  const autoRefund = isEvmChain(chain) ? address ?? "" : isSolana(chain) ? sol?.account.address ?? "" : "";
  const refund = refundEdited ? refundTo : autoRefund || refundTo;
  // How this payment can be sent from a wallet, if at all.
  const walletRoute: "evm" | "sol" | null = isEvmChain(chain) && address && connector ? "evm" : isSolana(chain) && sol ? "sol" : null;
  const walletName = walletRoute === "sol" ? sol!.wallet.name : walletRoute === "evm" ? connector?.name ?? "your wallet" : "";

  let units: bigint | null = null;
  try { units = token && Number(amount) > 0 ? parseUnits(amount, token.decimals) : null; } catch { units = null; }

  // A dry price as the inputs change.
  const qkey = `${token?.assetId}|${units}|${outcome.index}|${address}`;
  const quote = priced?.key === qkey ? priced.plan : null;
  useEffect(() => {
    if (!token || !units || !address || pending) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setQuoting(true); setQuoteErr(null);
      try {
        const r = await fetch("/api/intents/quote", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: address, marketId: market.id, outcome: outcome.index, originAsset: token.assetId, amount: units.toString(), dry: true }) });
        const d = await r.json();
        if (!r.ok) setQuoteErr(d.error ?? "No quote"); else setPriced({ key: qkey, plan: d });
      } catch (e) { if ((e as Error).name !== "AbortError") setQuoteErr("Couldn't get a quote"); }
      finally { setQuoting(false); }
    }, 500);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [qkey, Boolean(pending)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow an open order until it settles; the server executes it once the USDG lands.
  const live = pending && !FINAL.includes(pending.action ?? "");
  useEffect(() => {
    if (!pending || !live) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/intents/order", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ order: pending.order, depositAddress: pending.depositAddress, depositMemo: pending.depositMemo }) });
        const d = await r.json();
        const cur = pendingRef.current;
        if (stop || !cur || cur.order.nonce !== pending.order.nonce) return;
        // The server couldn't check or send: say why instead of looking busy.
        if (!r.ok) { const next = { ...cur, note: `Couldn't send: ${String(d.error ?? r.status).slice(0, 160)}` }; setPending(next); save(key, next); return; }
        const arrived = ["execute", "refund", "done", "refunded_onchain"].includes(d.action);
        const next: Pending = { ...cur, action: d.action, status: d.status, tx: d.tx ?? cur.tx, note: d.note, arrivedAt: cur.arrivedAt ?? (arrived ? Date.now() : undefined) };
        setPending(next); save(key, next);
        if (d.action === "done" || d.action === "refunded_onchain") onDone();
      } catch { /* try again next tick */ }
    };
    const id = setInterval(tick, 4000);
    void tick();
    return () => { stop = true; clearInterval(id); };
  }, [pending?.order.nonce, live]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sends the deposit for an open order from the connected wallet. */
  const sendFromWallet = async (p: Pending) => {
    if (!p.depositAddress || !address) return;
    setSending(true); setSendErr(null);
    try {
      const amountUnits = BigInt(p.amountUnits ?? parseUnits(p.amountText, p.token.decimals).toString());
      let tx: string;
      if (isSolana(p.token.blockchain)) {
        if (!sol) throw new Error("Connect a Solana wallet first");
        tx = await sendSolana({ wallet: sol.wallet, account: sol.account, to: p.depositAddress, mint: p.token.contractAddress ?? null, amount: amountUnits, decimals: p.token.decimals });
      } else {
        if (!connector) throw new Error("Connect your wallet first");
        const provider = (await connector.getProvider()) as EIP1193Provider;
        tx = await sendEvm({ provider, blockchain: p.token.blockchain, from: address, to: p.depositAddress as Address, token: (p.token.contractAddress as Address | null) ?? null, amount: amountUnits, returnChainId: TARGET_CHAIN_ID });
      }
      reportDeposit(tx, p.depositAddress, p.depositMemo);
      const next = { ...p, sentTx: tx, sentAt: Date.now() };
      setPending(next); save(key, next);
    } catch (e) {
      setSendErr(walletErrorText(e));
    } finally {
      setSending(false);
    }
  };

  /** Finishes the order from the connected wallet: the forwarder's execute (or refund after the deadline) is open to anyone. */
  const finishFromWallet = async (p: Pending) => {
    if (!OB.forwarder) return;
    setFinishing(true); setFinishErr(null);
    try {
      const fn = p.action === "refund" ? "refund" : "execute";
      const hash = await writeContractAsync({ address: OB.forwarder, abi: forwarderAbi, functionName: fn, args: [orderFromJson(p.order)], chainId: TARGET_CHAIN_ID });
      const next = { ...(pendingRef.current ?? p), tx: hash, note: "Sent from your wallet; confirming" };
      setPending(next); save(key, next);
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      setFinishErr(/InsufficientOutput/.test(msg) ? "The price moved past your minimum. Try again, or wait for the deadline and refund." : /rejected|denied/i.test(msg) ? "Cancelled in your wallet." : msg.slice(0, 160));
    } finally {
      setFinishing(false);
    }
  };

  const connectSol = async (w: SolWallet) => {
    setSendErr(null);
    try { setSol({ wallet: w, account: await connectSolana(w) }); } catch (e) { setSendErr(walletErrorText(e)); }
  };

  const open = async (thenSend = false) => {
    if (!token || !units || !address) return;
    setOpening(true); setQuoteErr(null);
    try {
      const r = await fetch("/api/intents/quote", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: address, marketId: market.id, outcome: outcome.index, originAsset: token.assetId, amount: units.toString(), refundTo: refund.trim() }) });
      const d: Plan & { error?: string } = await r.json();
      if (!r.ok || !d.order || !d.forwarderDeposit) { setQuoteErr(d.error ?? "Couldn't open the order"); return; }
      const p: Pending = { ...d, order: d.order, forwarderDeposit: d.forwarderDeposit, token, amountText: amount, amountUnits: units.toString(), outcomeName: outcome.name };
      setPending(p); save(key, p); setShowProgress(null);
      if (thenSend && d.depositAddress) await sendFromWallet(p);
    } catch { setQuoteErr("Couldn't open the order"); }
    finally { setOpening(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  if (marketPhase(market) !== "trading" && !pending) return null;

  const inFlight = pending && (pending.sentTx || (pending.status && pending.status !== "PENDING_DEPOSIT") || pending.action === "execute" || pending.action === "refund" || pending.action === "done" || pending.action === "refunded_onchain");
  const settled = pending ? FINAL.includes(pending.action ?? "") : false;
  const stale = settled && (pending?.seen || (pending?.arrivedAt ?? pending?.sentAt ?? 0) < Date.now() - 10 * 60_000);
  const progress = pending && inFlight && (showProgress ?? !stale) ? (
    <IntentProgress
      v={{ outcomeName: pending.outcomeName, amountText: pending.amountText, symbol: pending.token.symbol, chain: chainName(pending.token.blockchain), sentTx: pending.sentTx, sentAt: pending.sentAt, status: pending.status, action: pending.action, tx: pending.tx, note: pending.note, arrivedAt: pending.arrivedAt, minOutText: fmtAmount(BigInt(pending.order.minOut)), usdgMinText: fmtAmount(BigInt(pending.usdgMin)), deposit: pending.forwarderDeposit }}
      onClose={() => { setShowProgress(false); if (settled && !pending.seen) { const next = { ...pending, seen: true }; setPending(next); save(key, next); } }}
      onFinish={() => void finishFromWallet(pending)}
      finishing={finishing}
      finishErr={finishErr}
      onStartOver={() => { save(key, null); setPending(null); }}
    />
  ) : null;

  return (
    <Panel title="Pay from any chain" right={<span className="font-mono text-[10px] text-neutral-500">NEAR Intents</span>}>
      {progress}
      {pending ? (
        <div className="space-y-3 font-mono text-xs">
          <p className="text-neutral-500">
            Buying <b className="text-black dark:text-white">{pending.outcomeName}</b> with {pending.amountText} {pending.token.symbol} on {chainName(pending.token.blockchain)}
          </p>
          {pending.depositAddress && !FINAL.includes(pending.action ?? "") && (
            <div className="space-y-1.5">
              <Label>Send exactly {pending.amountText} {pending.token.symbol} on {chainName(pending.token.blockchain)} to</Label>
              <button type="button" onClick={() => copy(pending.depositAddress!)} className="w-full flex items-center justify-between gap-2 p-2.5 border border-neutral-200 dark:border-neutral-800 text-left break-all text-black dark:text-white">
                <span className="min-w-0">{pending.depositAddress}</span>
                {copied ? <Check className="w-3.5 h-3.5 flex-shrink-0 text-[#00cc6a]" /> : <Copy className="w-3.5 h-3.5 flex-shrink-0 text-neutral-500" />}
              </button>
              {pending.depositMemo && <p className="text-amber-600 dark:text-amber-400">Include the memo: <b>{pending.depositMemo}</b></p>}
              {!pending.sentTx && !pending.depositMemo && (isEvmChain(pending.token.blockchain) ? !!connector : isSolana(pending.token.blockchain) && !!sol) && (!pending.status || pending.status === "PENDING_DEPOSIT") && (
                <ActionButton onClick={() => void sendFromWallet(pending)} disabled={sending}>
                  {sending ? "Confirm in your wallet…" : `Send ${pending.amountText} ${pending.token.symbol} with ${isSolana(pending.token.blockchain) ? sol!.wallet.name : connector?.name ?? "your wallet"}`}
                </ActionButton>
              )}
              {isSolana(pending.token.blockchain) && !sol && !pending.sentTx && solWallets.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {solWallets.map((w) => (
                    <button key={w.name} type="button" onClick={() => void connectSol(w)} className="flex items-center gap-1.5 px-2 py-1 border border-neutral-200 dark:border-neutral-800 text-[11px] hover:border-neutral-400">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={w.icon} alt="" className="w-3.5 h-3.5" /> Connect {w.name} to send
                    </button>
                  ))}
                </div>
              )}
              {pending.sentTx && <p className="text-[10px] text-neutral-500 break-all">Sent from your wallet: {pending.sentTx}</p>}
              {sendErr && <p className="text-[11px] text-red-500">{sendErr}</p>}
              {pending.quoteDeadline && <p className="text-[10px] text-neutral-500">This address takes a deposit until {new Date(pending.quoteDeadline * 1000).toISOString().slice(11, 16)} UTC.</p>}
            </div>
          )}
          <div className="flex items-start gap-2 p-2.5 bg-neutral-50 dark:bg-neutral-900/60">
            {stage(pending).busy ? <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin flex-shrink-0" /> : <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[#00cc6a]" />}
            <span className="text-neutral-700 dark:text-neutral-300">{stage(pending).text}</span>
          </div>
          {pending.note && <p className="text-[10px] text-neutral-500">{pending.note}</p>}
          {inFlight && !progress && (
            <button type="button" onClick={() => setShowProgress(true)} className="text-[11px] underline text-neutral-500 hover:text-black dark:hover:text-white">Show progress</button>
          )}
          <dl className="space-y-1 text-[11px] text-neutral-500">
            <div className="flex justify-between gap-3"><dt>USDG on Robinhood Chain</dt><dd className="tabular-nums">at least {fmtAmount(BigInt(pending.usdgMin))}</dd></div>
            <div className="flex justify-between gap-3"><dt>{pending.outcomeName} tokens</dt><dd className="tabular-nums">at least {fmtAmount(BigInt(pending.order.minOut))}</dd></div>
            <div className="flex justify-between gap-3"><dt>Order address</dt><dd><a className="underline" href={`${EXPLORER}/address/${pending.forwarderDeposit}`} target="_blank" rel="noreferrer">{pending.forwarderDeposit}</a></dd></div>
          </dl>
          {pending.local && !FINAL.includes(pending.action ?? "") && (
            <ActionButton onClick={() => void writeContractAsync({ address: USDG, abi: erc20Abi, functionName: "transfer", args: [pending.forwarderDeposit, BigInt(pending.usdgMin)], chainId: TARGET_CHAIN_ID })}>
              Local chain: deliver {fmtAmount(BigInt(pending.usdgMin))} USDG as NEAR Intents would
            </ActionButton>
          )}
          {pending.tx && (
            <a className="flex items-center justify-center gap-1.5 w-full py-2.5 border border-neutral-300 dark:border-neutral-700 text-black dark:text-white hover:border-black dark:hover:border-white transition-colors" href={`${EXPLORER}/tx/${pending.tx}`} target="_blank" rel="noreferrer">
              View transaction <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          {FINAL.includes(pending.action ?? "") ? (
            <ActionButton onClick={() => { save(key, null); setPending(null); }}>Buy again</ActionButton>
          ) : (pending.status === "PENDING_DEPOSIT" || !pending.status) && (
            <button type="button" onClick={() => { save(key, null); setPending(null); }} className="block text-[11px] underline text-neutral-500 hover:text-black dark:hover:text-white">
              Start over (only if you haven't sent anything)
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
            Pay with a coin on another chain. NEAR Intents turns it into USDG on Robinhood Chain and buys <b className="text-black dark:text-white">{outcome.name}</b> for your connected wallet.
          </p>
          {loadErr ? <p className="font-mono text-xs text-red-500">{loadErr}</p> : !tokens ? (
            <p className="font-mono text-xs text-neutral-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading coins…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 min-w-0">
                  <Label>Chain</Label>
                  <select value={chain} onChange={(e) => { setChain(e.target.value); setAssetId(""); setRefundEdited(false); setRefundTo(""); setSendErr(null); }} className="w-full p-2 bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 font-mono text-xs">
                    {chains.map((c) => <option key={c} value={c}>{chainName(c)}</option>)}
                  </select>
                </label>
                <label className="space-y-1 min-w-0">
                  <Label>Coin</Label>
                  <select value={token?.assetId ?? ""} onChange={(e) => setAssetId(e.target.value)} className="w-full p-2 bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 font-mono text-xs">
                    {coins.map((t) => <option key={t.assetId} value={t.assetId}>{t.symbol}</option>)}
                  </select>
                </label>
              </div>
              <label className="block space-y-1">
                <Label>Amount</Label>
                <div className="flex items-center gap-2 p-2 border border-neutral-200 dark:border-neutral-800">
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Amount" className="w-full min-w-0 bg-transparent outline-none font-heading font-bold text-xl text-black dark:text-white" />
                  <span className="font-mono text-xs text-neutral-500">{token?.symbol}</span>
                </div>
              </label>
              {isSolana(chain) && (
                <div className="space-y-1">
                  <Label>Solana wallet</Label>
                  {sol ? (
                    <div className="flex items-center justify-between gap-2 p-2 border border-neutral-200 dark:border-neutral-800 font-mono text-xs">
                      <span className="flex items-center gap-1.5 min-w-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={sol.wallet.icon} alt="" className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate text-black dark:text-white">{sol.wallet.name} · {sol.account.address.slice(0, 4)}…{sol.account.address.slice(-4)}</span>
                      </span>
                      <button type="button" onClick={() => setSol(null)} className="text-[10px] underline text-neutral-500">Change</button>
                    </div>
                  ) : solWallets.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {solWallets.map((w) => (
                        <button key={w.name} type="button" onClick={() => void connectSol(w)} className="flex items-center gap-1.5 px-2.5 py-1.5 border border-neutral-200 dark:border-neutral-800 font-mono text-[11px] text-black dark:text-white hover:border-neutral-400 dark:hover:border-neutral-600">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={w.icon} alt="" className="w-4 h-4" /> Connect {w.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="font-mono text-[10px] text-neutral-500">No Solana wallet found in this browser. You can still pay to a deposit address.</p>
                  )}
                </div>
              )}
              <label className="block space-y-1">
                <Label>Your {chainName(chain)} address, for refunds</Label>
                <input value={refund} onChange={(e) => { setRefundTo(e.target.value); setRefundEdited(true); }} placeholder={`Where a refund goes on ${chainName(chain)}`} spellCheck={false} className="w-full p-2 bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 font-mono text-xs" />
                {!refundEdited && autoRefund && <span className="block font-mono text-[10px] text-neutral-500">Your connected wallet. Edit it to send refunds elsewhere.</span>}
              </label>
              <dl className="font-mono text-[11px] text-neutral-500 space-y-1 min-h-[3.2rem]">
                {quoting && <div className="flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Pricing…</div>}
                {!quoting && quote && (
                  <>
                    <div className="flex justify-between gap-3"><dt>USDG on Robinhood Chain</dt><dd className="tabular-nums text-neutral-700 dark:text-neutral-300">≈ {fmtAmount(BigInt(quote.usdgExpected))}</dd></div>
                    {quote.outcomeExpected && <div className="flex justify-between gap-3"><dt>{outcome.name} tokens</dt><dd className="tabular-nums text-black dark:text-white font-bold">≈ {fmtAmount(BigInt(quote.outcomeExpected))}</dd></div>}
                    {quote.secondsToDeliver != null && <div className="flex justify-between gap-3"><dt>Arrives in</dt><dd>about {Math.max(1, Math.round(quote.secondsToDeliver / 60))} min</dd></div>}
                  </>
                )}
                {!quoting && quoteErr && <div className="text-red-500">{quoteErr}</div>}
              </dl>
              {sendErr && <p className="font-mono text-[11px] text-red-500">{sendErr}</p>}
              {walletRoute ? (
                <>
                  <ActionButton onClick={() => void open(true)} disabled={!quote || opening || sending || refund.trim().length < 20}>
                    {opening ? "Opening…" : sending ? "Confirm in your wallet…" : `Pay ${amount} ${token?.symbol ?? ""} with ${walletName}`}
                  </ActionButton>
                  <button type="button" onClick={() => void open()} disabled={!quote || opening || refund.trim().length < 20} className="w-full font-mono text-[11px] underline text-neutral-500 hover:text-black dark:hover:text-white disabled:opacity-40">
                    Or get a deposit address to pay from anywhere
                  </button>
                </>
              ) : (
                <ActionButton onClick={() => void open()} disabled={!quote || opening || refund.trim().length < 20}>
                  {opening ? "Opening…" : "Get a deposit address"}
                </ActionButton>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
