"use client";
// Buy and sell an outcome: market orders through the Universal Router (priced by the V4 Quoter, fee included), or
// limit orders on PFWALimitOrders that fill when a swap moves the price through them.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { OB, UNIVERSAL_ROUTER, USDG, V4_QUOTER } from "@/lib/orderbook/config";
import { obLimitOrdersAbi, universalRouterAbi, v4QuoterAbi } from "@/lib/orderbook/abi";
import { encodeV4Swap } from "@/lib/orderbook/swap";
import { bestSplit, obSetRouterAbi } from "@/lib/orderbook/splitBuy";
import { fmtAmount, fmtPrice, limitProceeds, limitStep } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import type { BookUser } from "@/hooks/useBook";
import { ActionButton, AmountInput, Label, OUTCOME_COLORS, Panel, Seg, parseAmount, toInput } from "./ui";
import { approveStep, permit2Steps, useTxFlow, type FlowStep } from "./useTxFlow";

const SLIPPAGE_BPS = BigInt(100); // 1%

export type LimitPick = { side: "buy" | "sell"; price: number } | null;

/** The buy router's USDG allowance, at least (USDG has 6 decimals). */
const ROUTER_ALLOWANCE = BigInt(10_000) * BigInt(1_000_000);

export default function TradePanel({
  market, outcomeIndex, onOutcome, user, pick, onDone,
}: {
  market: BookMarket;
  outcomeIndex: number;
  onOutcome: (i: number) => void;
  user: BookUser | undefined;
  /** A price picked from the order book: switches to a limit order at it. */
  pick: LimitPick;
  onDone: () => void;
}) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);

  const [mode, setMode] = useState<"market" | "limit">("market");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("10");
  const [price, setPrice] = useState("");
  const [debounced, setDebounced] = useState(amount);
  // How a market buy fills: "sets" lets PFWA's buy router use full sets when that gets more; "pool" buys from the
  // outcome's pool only. The buyer picks.
  const [route, setRoute] = useState<"sets" | "pool">("sets");

  const outcome = market.outcomes[outcomeIndex];
  const amountRaw = parseAmount(amount);
  const fee = (market.creatorFeeBps + market.protocolFeeBps) / 100;
  const balance = side === "buy" ? user?.usdg : user?.balances[outcomeIndex];
  const inputUnit = side === "buy" ? "USDG" : outcome.name;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(amount), 350);
    return () => clearTimeout(t);
  }, [amount]);

  // A price picked from the order book switches to a limit order at it (once per pick).
  const [appliedPick, setAppliedPick] = useState<LimitPick>(null);
  if (pick && pick !== appliedPick) {
    setAppliedPick(pick);
    setMode("limit");
    setSide(pick.side);
    setPrice(fmtPrice(pick.price));
  }

  // Market orders: what the amount gets right now.
  const zeroForOneSwap = side === "buy" ? outcome.usdgIs0 : !outcome.usdgIs0;
  const debouncedRaw = parseAmount(debounced);
  const quote = useQuery({
    queryKey: ["book", "quote", outcome.poolId, side, debouncedRaw.toString()],
    enabled: mode === "market" && market.tradingOpen && debouncedRaw > BigInt(0) && !!client,
    staleTime: 10_000,
    retry: false,
    queryFn: async () => {
      const { result } = await client.simulateContract({
        address: V4_QUOTER,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: outcome.key, zeroForOne: zeroForOneSwap, exactAmount: debouncedRaw, hookData: "0x" }],
      });
      return result[0];
    },
  });
  // Buys: also price buying through full sets (OBSetRouter), and use it when it gets more.
  const split = useQuery({
    queryKey: ["book", "split", market.id, outcome.index, debouncedRaw.toString(), market.outcomes.map((o) => o.price).join(",")],
    enabled: mode === "market" && side === "buy" && !!OB.setRouter && market.tradingOpen && debouncedRaw > BigInt(0) && !!client,
    staleTime: 10_000,
    retry: false,
    queryFn: () => bestSplit(client, market, outcome.index, debouncedRaw),
  });
  // The full-sets route, when it gets more than the pool alone; used only if the buyer keeps that route.
  const better = side === "buy" && split.data && split.data.sets > BigInt(0) && split.data.tokensOut > (quote.data ?? BigInt(0)) ? split.data : null;
  const plan = route === "sets" ? better : null;
  const out = plan ? plan.tokensOut : quote.data;
  const gain = better && better.plainOut > BigInt(0) ? (Number(better.tokensOut) / Number(better.plainOut) - 1) * 100 : null;
  const others = market.outcomes.filter((o) => o.index !== outcome.index).map((o) => o.name).join(", ");
  const avgPrice = out && debouncedRaw > BigInt(0) ? (side === "buy" ? Number(debouncedRaw) / Number(out) : Number(out) / Number(debouncedRaw)) : 0;

  // Limit orders: the price step the order sits in.
  const priceNum = Number(price);
  const step = useMemo(
    () => (mode === "limit" && priceNum > 0 ? limitStep(side, priceNum, outcome) : null),
    [mode, side, priceNum, outcome],
  );

  const switchMode = (m: "market" | "limit") => {
    setMode(m);
    if (m === "limit" && !price) {
      const p = side === "buy" ? Math.max(0.01, outcome.price - 0.05) : Math.min(0.99, outcome.price + 0.05);
      setPrice(fmtPrice(p));
    }
  };

  const tooMuch = balance !== undefined && amountRaw > balance;
  const inputToken = side === "buy" ? USDG : outcome.token;

  const submitMarket = () => {
    if (!address || !out) return;
    if (plan && OB.setRouter) {
      const router = OB.setRouter;
      // A capped allowance, not unlimited (wallets warn on unlimited approvals to a new contract): 10,000 USDG, or 10x
      // this buy when that's more, so one approval still covers almost every later buy.
      const routerAllowance = amountRaw * BigInt(10) > ROUTER_ALLOWANCE ? amountRaw * BigInt(10) : ROUTER_ALLOWANCE;
      const minOut = (plan.tokensOut * (BigInt(10_000) - SLIPPAGE_BPS)) / BigInt(10_000);
      void start(`Buy ${outcome.name}`, [
        approveStep(client, writeContractAsync, { token: USDG, owner: address, spender: router, amount: amountRaw, approveAmount: routerAllowance, label: `Approve ${fmtAmount(routerAllowance)} USDG for PFWA's buy router` }),
        {
          id: "split-buy",
          label: `Buy ${outcome.name} with ${fmtAmount(amountRaw)} USDG`,
          run: () => writeContractAsync({
            address: router, abi: obSetRouterAbi, functionName: "buy",
            args: [BigInt(market.id), outcome.index, plan.sets, plan.usdgDirect, amountRaw, minOut, address], chainId: TARGET_CHAIN_ID,
          }),
        },
      ]);
      return;
    }
    const minOut = (out * (BigInt(10_000) - SLIPPAGE_BPS)) / BigInt(10_000);
    const { commands, inputs } = encodeV4Swap({ key: outcome.key, zeroForOne: zeroForOneSwap, amountIn: amountRaw, minOut });
    const steps: FlowStep[] = [
      ...permit2Steps(client, writeContractAsync, {
        token: inputToken, symbol: inputUnit, owner: address, spender: UNIVERSAL_ROUTER, spenderName: "Uniswap's router", amount: amountRaw,
      }),
      {
        id: "swap",
        label: side === "buy" ? `Buy ${outcome.name} with ${fmtAmount(amountRaw)} USDG` : `Sell ${fmtAmount(amountRaw)} ${outcome.name}`,
        run: () =>
          writeContractAsync({
            address: UNIVERSAL_ROUTER,
            abi: universalRouterAbi,
            functionName: "execute",
            args: [commands, inputs, BigInt(Math.floor(Date.now() / 1000) + 1200)],
            chainId: TARGET_CHAIN_ID,
          }),
      },
    ];
    void start(side === "buy" ? `Buy ${outcome.name}` : `Sell ${outcome.name}`, steps);
  };

  const submitLimit = () => {
    if (!address || !step || step.error || !OB.limitOrders) return;
    const lo = OB.limitOrders;
    const steps: FlowStep[] = [
      approveStep(client, writeContractAsync, {
        token: inputToken, owner: address, spender: lo, amount: amountRaw, label: `Approve ${inputUnit} for limit orders`,
      }),
      {
        id: "place",
        label: `Place: ${side} ${outcome.name} at ${fmtPrice(step.fillPrice)}`,
        run: () =>
          writeContractAsync({
            address: lo,
            abi: obLimitOrdersAbi,
            functionName: "place",
            args: [outcome.key, step.tickLower, step.zeroForOne, amountRaw],
            chainId: TARGET_CHAIN_ID,
          }),
      },
    ];
    void start("Place a limit order", steps);
  };

  const closed = !market.tradingOpen;

  return (
    <Panel title="Trade">
      {modal}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {market.outcomes.map((o, i) => (
            <button
              key={o.token}
              type="button"
              onClick={() => onOutcome(i)}
              aria-pressed={i === outcomeIndex}
              className={`p-2.5 border text-left transition-colors ${
                i === outcomeIndex ? "border-black dark:border-white bg-neutral-50 dark:bg-neutral-900" : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600"
              }`}
            >
              <span className="flex items-center gap-1.5 font-heading font-bold text-sm text-black dark:text-white truncate">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }} />
                {o.name}
              </span>
              <span className="font-mono text-xs text-neutral-500 tabular-nums">{fmtPrice(o.price)} USDG</span>
            </button>
          ))}
        </div>

        {closed ? (
          <p className="border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
            {market.halted || market.resolved
              ? "Trading stopped when the outcome was posted."
              : "Trading has ended. The outcome is posted next, then there are 2 hours to dispute it."}
          </p>
        ) : (
          <>
            <Seg value={mode} onChange={switchMode} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} />
            <Seg value={side} onChange={setSide} options={[{ value: "buy", label: `Buy ${outcome.name}` }, { value: "sell", label: `Sell ${outcome.name}` }]} />

            <AmountInput
              label={side === "buy" ? "You pay" : "You sell"}
              value={amount}
              onChange={setAmount}
              unit={inputUnit}
              balance={balance !== undefined ? fmtAmount(balance) : undefined}
              onMax={balance !== undefined ? () => setAmount(toInput(balance)) : undefined}
            />

            {mode === "limit" && (
              <div className="bg-white dark:bg-[#0a0a0a] p-3 border border-neutral-200 dark:border-neutral-800">
                <div className="flex justify-between items-center mb-1">
                  <Label>Limit price</Label>
                  <span className="font-mono text-[10px] text-neutral-500">Now {fmtPrice(outcome.price)}</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder={fmtPrice(outcome.price)}
                    aria-label="Limit price in USDG"
                    className="w-full min-w-0 bg-transparent outline-none font-heading font-bold text-2xl text-black dark:text-white placeholder:text-neutral-300 dark:placeholder:text-neutral-800"
                  />
                  <span className="font-mono text-xs text-neutral-500 flex-shrink-0">USDG</span>
                </div>
              </div>
            )}

            {mode === "market" && better && (
              <div className="space-y-1.5">
                <Label>How to buy</Label>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to buy">
                  {([
                    ["sets", "Best price", gain !== null && gain >= 0.1 ? `${gain.toFixed(1)}% more ${outcome.name}` : "Through full sets"],
                    ["pool", "Pool only", quote.data ? `≈ ${fmtAmount(quote.data)} ${outcome.name}` : "Can't fill this size"],
                  ] as const).map(([k, title, sub]) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={route === k}
                      onClick={() => setRoute(k)}
                      className={`p-2 border text-left transition-colors ${
                        route === k ? "border-black dark:border-white bg-neutral-50 dark:bg-neutral-900" : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600"
                      }`}
                    >
                      <span className="block font-heading font-bold text-xs text-black dark:text-white">{title}</span>
                      <span className="block font-mono text-[10px] text-neutral-500 tabular-nums">{sub}</span>
                    </button>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-neutral-500 leading-relaxed">
                  {route === "sets"
                    ? `Part of your USDG makes full sets (1 USDG = one of every outcome). PFWA's router sells the ${others} back to ${others.includes(",") ? "their pools" : "its pool"} and buys more ${outcome.name} with it, in one transaction. You end up holding only ${outcome.name}.`
                    : `Buys ${outcome.name} from its own pool, nothing else.`}
                </p>
              </div>
            )}

            <div className="font-mono text-[11px] space-y-1.5 text-neutral-500">
              {mode === "market" ? (
                (quote.isFetching || (side === "buy" && split.isFetching)) && !out ? (
                  <p>Pricing…</p>
                ) : quote.isError && !plan ? (
                  <p className="text-red-500">
                    {better ? "The pool alone can't fill this size. Use the full sets route, try a smaller amount, or place a limit order." : "Not enough liquidity to fill this size. Try a smaller amount, or place a limit order."}
                  </p>
                ) : out ? (
                  <>
                    <Row k="You get" v={`≈ ${fmtAmount(out)} ${side === "buy" ? outcome.name : "USDG"}`} strong />
                    <Row k="Average price" v={`${fmtPrice(avgPrice)} USDG`} />
                    {side === "buy" && <Row k="Pays if it wins" v={`${fmtAmount(out)} USDG`} />}
                    <Row k="Fee (included)" v={`${fee}%`} />
                    <Row k="Slippage limit" v="1%" />
                  </>
                ) : null
              ) : step ? (
                step.error ? (
                  <p className="text-red-500">{step.error}</p>
                ) : (
                  <>
                    <Row k="Fills at" v={`≈ ${fmtPrice(step.fillPrice)} USDG`} strong />
                    <Row
                      k="You get when filled"
                      v={`≈ ${fmtAmount(limitProceeds(side, Number(amountRaw) / 1e6, step.fillPrice))} ${side === "buy" ? outcome.name : "USDG"}`}
                    />
                    <Row k="Maker fee" v="None" />
                    <p className="leading-relaxed pt-1">The order fills when trading moves the price through it. Cancel any time before then.</p>
                  </>
                )
              ) : null}
            </div>

            <ActionButton
              onClick={mode === "market" ? submitMarket : submitLimit}
              disabled={running || amountRaw === BigInt(0) || tooMuch || (mode === "market" ? !out || quote.isFetching || (side === "buy" && split.isFetching) : !step || !!step.error)}
            >
              {tooMuch
                ? `Not enough ${inputUnit}`
                : mode === "market"
                  ? side === "buy" ? `Buy ${outcome.name}` : `Sell ${outcome.name}`
                  : `Place limit ${side}`}
            </ActionButton>
          </>
        )}
      </div>
    </Panel>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{k}</span>
      <span className={`tabular-nums text-right ${strong ? "text-black dark:text-white font-bold" : "text-neutral-700 dark:text-neutral-300"}`}>{v}</span>
    </div>
  );
}
