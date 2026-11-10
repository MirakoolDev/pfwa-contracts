"use client";
// The open limit orders on one outcome: sells above the current price, buys below. Clicking a level fills the trade
// panel with a limit order on the other side at that price.
import { Loader2 } from "lucide-react";
import { useOrderBook } from "@/hooks/useBook";
import { fmtAmount, fmtPrice } from "@/lib/orderbook/math";
import type { BookOutcome } from "@/lib/orderbook/read";
import type { BookLevel } from "@/lib/orderbook/orders";
import { Panel } from "./ui";
import type { LimitPick } from "./TradePanel";

export default function OrderBookView({ outcome, onPick, outcomes, onOutcome }: {
  outcome: BookOutcome; onPick: (p: LimitPick) => void; outcomes?: BookOutcome[]; onOutcome?: (i: number) => void;
}) {
  const { data, isLoading, isError } = useOrderBook(outcome);
  const levels = data ?? [];
  // Size in outcome tokens for both sides, so the bars compare.
  const tokens = (l: BookLevel) => (l.side === "buy" ? l.size / l.price : l.size);
  const max = Math.max(1, ...levels.map(tokens));
  const asks = levels.filter((l) => l.side === "sell");
  const bids = levels.filter((l) => l.side === "buy");

  return (
    <Panel
      title={`Order book · ${outcome.name}`}
      right={outcomes && onOutcome && outcomes.length > 1 ? (
        // Switch the outcome here (it also switches the trade panel), so there's no scrolling back up to see the other side.
        <div role="radiogroup" aria-label="Outcome" className="flex border border-neutral-200 dark:border-neutral-800 font-mono text-[11px]">
          {outcomes.map((o) => (
            <button
              key={o.index}
              type="button"
              role="radio"
              aria-checked={o.index === outcome.index}
              onClick={() => onOutcome(o.index)}
              className={`px-2.5 py-1 transition-colors ${o.index === outcome.index ? "bg-black text-white dark:bg-white dark:text-black font-bold" : "text-neutral-500 hover:text-black dark:hover:text-white"}`}
            >
              {o.name} <span className="tabular-nums opacity-70">{Math.round(o.price * 100)}%</span>
            </button>
          ))}
        </div>
      ) : <span className="font-mono text-[10px] text-neutral-500">Limit orders</span>}
    >
      <div className="font-mono text-xs">
        <div className="grid grid-cols-3 gap-2 pb-2 text-[10px] uppercase tracking-widest text-neutral-500">
          <span>Price</span>
          <span className="text-right">{outcome.name}</span>
          <span className="text-right">USDG</span>
        </div>
        {isLoading ? (
          <p className="py-6 text-center text-neutral-500 flex items-center justify-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Reading orders…</p>
        ) : isError ? (
          <p className="py-6 text-center text-red-500">Couldn&apos;t read the order book. Retrying…</p>
        ) : (
          <>
            {asks.length === 0 && <p className="py-2 text-center text-neutral-500">No sell orders</p>}
            {asks.map((l) => <LevelRow key={`a${l.tickLower}`} l={l} width={tokens(l) / max} onPick={() => onPick({ side: "buy", price: l.price })} />)}
            <div className="my-1.5 py-1.5 border-y border-neutral-200 dark:border-neutral-800 flex justify-between">
              <span className="font-bold text-black dark:text-white tabular-nums">{fmtPrice(outcome.price)}</span>
              <span className="text-neutral-500">Current price · {Math.round(outcome.price * 100)}% chance</span>
            </div>
            {bids.map((l) => <LevelRow key={`b${l.tickLower}`} l={l} width={tokens(l) / max} onPick={() => onPick({ side: "sell", price: l.price })} />)}
            {bids.length === 0 && <p className="py-2 text-center text-neutral-500">No buy orders</p>}
          </>
        )}
        <p className="pt-3 text-[10px] text-neutral-500 leading-relaxed">
          Market orders also trade against the pool&apos;s own liquidity, so they can fill between these levels.
        </p>
      </div>
    </Panel>
  );
}

function LevelRow({ l, width, onPick }: { l: BookLevel; width: number; onPick: () => void }) {
  const tokens = l.side === "buy" ? l.size / l.price : l.size;
  const usdg = l.side === "buy" ? l.size : l.size * l.price;
  const sell = l.side === "sell";
  return (
    <button
      type="button"
      onClick={onPick}
      title={sell ? "Buy at this price" : "Sell at this price"}
      className="relative w-full grid grid-cols-3 gap-2 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 right-0 ${sell ? "bg-red-500/10" : "bg-[#00ff87]/10"}`}
        style={{ width: `${Math.max(2, width * 100)}%` }}
      />
      <span className={`relative tabular-nums font-bold ${sell ? "text-red-500" : "text-[#00cc6a] dark:text-[#00ff87]"}`}>{fmtPrice(l.price)}</span>
      <span className="relative tabular-nums text-right text-black dark:text-neutral-300">{fmtAmount(tokens)}</span>
      <span className="relative tabular-nums text-right text-neutral-500">{fmtAmount(usdg)}</span>
    </button>
  );
}
