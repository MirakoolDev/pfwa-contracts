"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog, keccak256, toBytes, type PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { MULTICALL3, OB, OB_ENABLED, USDG } from "@/lib/orderbook/config";
import { obFactoryAbi } from "@/lib/orderbook/abi";
import { fmtAmount } from "@/lib/orderbook/math";
import { ActionButton, Label, Panel, Seg, PreviewNotice } from "@/components/book/ui";
import { approveStep, useTxFlow, type FlowStep } from "@/components/book/useTxFlow";
import { lockedSeedSteps } from "@/components/book/lockerSteps";
import { AmountInput, parseAmount } from "@/components/book/ui";
import { CREATOR_BAND, MIN_CREATOR_LIQUIDITY_USDG } from "@/lib/orderbook/liquidity";

const FEES = ["0", "0.5", "1"] as const;
const MAX_OUTCOMES = 10;

/** A week from now, rounded to the hour, as a datetime-local value read as UTC. */
function defaultEnd(): string {
  const d = new Date(Date.now() + 7 * 86400_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 16);
}

export default function CreateBookMarketPage() {
  const router = useRouter();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow();

  const [question, setQuestion] = useState("");
  const [rules, setRules] = useState("");
  const [names, setNames] = useState<string[]>(["YES", "NO"]);
  const [chances, setChances] = useState<string[]>(["50", "50"]);
  const [end, setEnd] = useState(defaultEnd);
  const [fee, setFee] = useState<(typeof FEES)[number]>("1");
  const [openedAt] = useState(() => Date.now());
  // The creator's liquidity: at least MIN_CREATOR_LIQUIDITY_USDG, locked while the market trades (LiquidityLocker).
  const [liquidity, setLiquidity] = useState(String(MIN_CREATOR_LIQUIDITY_USDG));
  const liquidityRaw = parseAmount(liquidity);

  const factory = useQuery({
    queryKey: ["book", "factory"],
    enabled: OB_ENABLED && !!client,
    queryFn: async () => {
      const [creationFee, defaultBond, depositCap, protocolFeeBps, creationPaused] = await client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: false,
        contracts: (["creationFee", "defaultBond", "depositCap", "protocolFeeBps", "creationPaused"] as const).map(
          (functionName) => ({ address: OB.factory!, abi: obFactoryAbi, functionName }) as const,
        ),
      });
      return {
        creationFee: creationFee as bigint,
        defaultBond: defaultBond as bigint,
        depositCap: depositCap as bigint,
        protocolFeeBps: Number(protocolFeeBps),
        creationPaused: creationPaused as boolean,
      };
    },
  });

  const setName = (i: number, v: string) => setNames((n) => n.map((x, j) => (j === i ? v.slice(0, 32) : x)));
  const setChance = (i: number, v: string) => {
    const clean = v.replace(/[^0-9.]/g, "");
    setChances((c) => {
      const next = c.map((x, j) => (j === i ? clean : x));
      // Two outcomes: the other side follows, so they add up to 100%.
      if (next.length === 2 && Number(clean) > 0 && Number(clean) < 100) next[1 - i] = String(+(100 - Number(clean)).toFixed(1));
      return next;
    });
  };
  const evenSplit = (n: number) => Array.from({ length: n }, () => String(+(100 / n).toFixed(1)));
  const addOutcome = () => {
    if (names.length >= MAX_OUTCOMES) return;
    setNames((n) => [...n, `Outcome ${n.length + 1}`]);
    setChances(evenSplit(names.length + 1));
  };
  const removeOutcome = (i: number) => {
    if (names.length <= 2) return;
    setNames((n) => n.filter((_, j) => j !== i));
    setChances(evenSplit(names.length - 1));
  };

  const endSec = Math.floor(Date.parse(`${end}:00Z`) / 1000);
  const chanceSum = chances.reduce((s, c) => s + Number(c || 0), 0);
  const problems = useMemo(() => {
    const p: string[] = [];
    if (question.trim().length < 10) p.push("Write the question (at least 10 characters).");
    const trimmed = names.map((n) => n.trim());
    if (trimmed.some((n) => !n)) p.push("Every outcome needs a name.");
    if (new Set(trimmed.map((n) => n.toLowerCase())).size !== trimmed.length) p.push("Outcome names must differ.");
    if (chances.some((c) => !(Number(c) >= 0.1 && Number(c) <= 99.9))) p.push("Each opening chance must be between 0.1% and 99.9%.");
    if (!Number.isFinite(endSec) || endSec < openedAt / 1000 + 3600) p.push("Trading must end at least an hour from now.");
    if (!rules.trim()) p.push("Say how the outcome is decided, and from what source.");
    else if (new TextEncoder().encode(rules.trim()).length > 2000) p.push("The rules can be at most 2,000 bytes.");
    if (!OB.locker) p.push("Liquidity locking isn't set up yet.");
    else if (liquidityRaw < BigInt(MIN_CREATOR_LIQUIDITY_USDG) * BigInt(1_000_000)) p.push(`Add at least ${MIN_CREATOR_LIQUIDITY_USDG} USDG of liquidity.`);
    return p;
  }, [question, names, chances, endSec, rules, openedAt, liquidityRaw]);

  const submit = () => {
    if (!address || problems.length || !factory.data) return;
    const outcomeNames = names.map((n) => n.trim());
    const setup = { question: question.trim(), outcomes: outcomeNames, rules: rules.trim(), endOfTrading: endSec };
    const params = {
      setupHash: keccak256(toBytes(JSON.stringify(setup))),
      question: setup.question,
      rules: setup.rules,
      outcomeNames,
      openingBps: chances.map((c) => Math.round(Number(c) * 100)),
      endOfTrading: BigInt(endSec),
      creatorFeeBps: Math.round(Number(fee) * 100),
    };
    let marketId: bigint | undefined;
    const steps: FlowStep[] = [];
    if (factory.data.creationFee > BigInt(0)) {
      steps.push(approveStep(client, writeContractAsync, { token: USDG, owner: address, spender: OB.factory!, amount: factory.data.creationFee, label: `Approve the ${fmtAmount(factory.data.creationFee)} USDG creation fee` }));
    }
    steps.push({
      id: "create",
      label: "Create the market",
      run: () => writeContractAsync({ address: OB.factory!, abi: obFactoryAbi, functionName: "createMarket", args: [params], chainId: TARGET_CHAIN_ID }),
      onReceipt: (receipt) => {
        for (const log of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: obFactoryAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "MarketCreated") marketId = ev.args.marketId;
          } catch { /* another contract's log */ }
        }
      },
    });
    steps.push(...lockedSeedSteps({ client, write: writeContractAsync, owner: address, marketId: () => (marketId === undefined ? undefined : Number(marketId)), usdg: liquidityRaw }));
    // Created but not seeded: the market page asks the creator to finish adding their liquidity.
    void start("Create an order book market", steps).then(() => {
      if (marketId !== undefined) router.push(`/book/${marketId}?new=1`);
    });
  };

  if (!OB_ENABLED) {
    return <Shell><p className="font-mono text-sm text-neutral-500">Order book markets aren&apos;t live yet.</p></Shell>;
  }

  const f = factory.data;
  return (
    <Shell>
      {modal}
      <header className="space-y-2 border-b border-neutral-200 dark:border-neutral-800 pb-5">
        <h1 className="font-heading text-2xl sm:text-3xl font-bold text-black dark:text-white tracking-tight">Custom market</h1>
        <p className="font-mono text-xs sm:text-sm text-neutral-500 leading-relaxed max-w-2xl">
          For questions PFWA&apos;s data sources don&apos;t cover. Coin, football and DeFi markets are made on <a href="https://pfwa.fun/create?pricing=book" target="_blank" rel="noreferrer" className="underline underline-offset-2">pfwa.fun</a> and resolve automatically. Here you write the rules yourself. Each outcome becomes a token backed by 1 USDG, with its own pool opening at the chance you set. You earn your fee on every trade. You post the outcome when it&apos;s known; anyone can dispute it within 2 hours with a {f ? fmtAmount(f.defaultBond) : "50"} USDG bond.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="space-y-6 min-w-0">
          <Panel title="Question">
            <div className="space-y-3">
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value.slice(0, 300))}
                rows={2}
                placeholder="Will $TOKEN reach a $20M market cap by Nov 30, 2026?"
                aria-label="Question"
                className="w-full bg-transparent border border-neutral-200 dark:border-neutral-800 p-3 font-heading font-bold text-lg text-black dark:text-white placeholder:text-neutral-300 dark:placeholder:text-neutral-700 resize-none"
              />
              <Label>How it&apos;s decided</Label>
              <textarea
                value={rules}
                onChange={(e) => setRules(e.target.value.slice(0, 1000))}
                rows={3}
                placeholder="YES if CoinGecko shows a market cap of $20,000,000 or more at any time before trading ends. Otherwise NO."
                aria-label="How the outcome is decided"
                className="w-full bg-transparent border border-neutral-200 dark:border-neutral-800 p-3 font-mono text-xs text-black dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-700 resize-none leading-relaxed"
              />
              <p className="font-mono text-[10px] text-neutral-500">Disputes are judged against these rules. They&apos;re stored onchain with the market, so they can&apos;t change later.</p>
            </div>
          </Panel>

          <Panel
            title="Outcomes and opening chances"
            right={
              names.length < MAX_OUTCOMES ? (
                <button type="button" onClick={addOutcome} className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-neutral-500 hover:text-black dark:hover:text-white">
                  <Plus className="w-3 h-3" /> Add outcome
                </button>
              ) : undefined
            }
          >
            <ul className="space-y-2">
              {names.map((n, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    value={n}
                    onChange={(e) => setName(i, e.target.value)}
                    aria-label={`Outcome ${i + 1} name`}
                    className="flex-1 min-w-0 bg-transparent border border-neutral-200 dark:border-neutral-800 px-3 py-2 font-heading font-bold text-sm text-black dark:text-white"
                  />
                  <div className="flex items-center border border-neutral-200 dark:border-neutral-800 w-24">
                    <input
                      value={chances[i]}
                      onChange={(e) => setChance(i, e.target.value)}
                      inputMode="decimal"
                      aria-label={`${n} opening chance in percent`}
                      className="w-full min-w-0 bg-transparent px-2 py-2 font-mono text-sm text-right tabular-nums text-black dark:text-white"
                    />
                    <span className="pr-2 font-mono text-xs text-neutral-500">%</span>
                  </div>
                  {names.length > 2 && (
                    <button type="button" onClick={() => removeOutcome(i)} aria-label={`Remove ${n}`} className="p-2 text-neutral-400 hover:text-black dark:hover:text-white">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {Math.abs(chanceSum - 100) > 0.5 && (
              <p className="mt-2 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                The chances add up to {+chanceSum.toFixed(1)}%. They don&apos;t have to be 100%, but traders will pull them toward it.
              </p>
            )}
          </Panel>
        </div>

        <aside className="space-y-6 min-w-0">
          <Panel title="Trading">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Trading ends (UTC)</Label>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  aria-label="Trading ends, in UTC"
                  className="w-full bg-transparent border border-neutral-200 dark:border-neutral-800 px-3 py-2 font-mono text-sm text-black dark:text-white"
                />
                <p className="font-mono text-[10px] text-neutral-500">You can post the outcome earlier if it&apos;s already known. Posting it stops trading.</p>
              </div>
              <div className="space-y-1.5">
                <AmountInput label="Your liquidity" value={liquidity} onChange={setLiquidity} unit="USDG" />
                <p className="font-mono text-[10px] text-neutral-500">At least {MIN_CREATOR_LIQUIDITY_USDG} USDG, from {Math.round(CREATOR_BAND * 100)} points under to {Math.round(CREATOR_BAND * 100)} points over each opening chance. Locked until trading stops.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Your fee on each trade</Label>
                <Seg value={fee} onChange={setFee} options={FEES.map((v) => ({ value: v, label: `${v}%` }))} />
                {f && <p className="font-mono text-[10px] text-neutral-500">Plus PFWA&apos;s {f.protocolFeeBps / 100}%. Fees are fixed for the life of the market.</p>}
              </div>
              {f && (
                <dl className="font-mono text-[11px] space-y-1 border-t border-neutral-200 dark:border-neutral-800 pt-3">
                  <div className="flex justify-between"><dt className="text-neutral-500">Creation fee</dt><dd className="text-black dark:text-white">{f.creationFee > BigInt(0) ? `${fmtAmount(f.creationFee)} USDG` : "None"}</dd></div>
                  <div className="flex justify-between"><dt className="text-neutral-500">Dispute bond</dt><dd className="text-black dark:text-white">{fmtAmount(f.defaultBond)} USDG</dd></div>
                  {f.depositCap > BigInt(0) && <div className="flex justify-between"><dt className="text-neutral-500">Launch deposit cap</dt><dd className="text-black dark:text-white">{fmtAmount(f.depositCap)} USDG</dd></div>}
                </dl>
              )}
              {problems.length > 0 && (
                <ul className="font-mono text-[10px] text-neutral-500 space-y-0.5 list-disc pl-4">
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}
              {f?.creationPaused ? (
                <p className="font-mono text-xs text-amber-600 dark:text-amber-400">Creating markets is paused right now.</p>
              ) : (
                <ActionButton onClick={submit} disabled={running || problems.length > 0 || !f}>Create market</ActionButton>
              )}
              <p className="font-mono text-[10px] text-neutral-500 leading-relaxed">Creates the market and adds your liquidity in a few wallet steps.</p>
            </div>
          </Panel>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <Link href="/book" className="inline-flex items-center gap-1.5 font-mono text-xs text-neutral-500 hover:text-black dark:hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Order book markets
        </Link>
        <PreviewNotice />
        {children}
      </div>
    </div>
  );
}
