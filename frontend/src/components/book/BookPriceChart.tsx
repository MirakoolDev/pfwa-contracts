"use client";
// Price history for an order book market, drawn like the bonding curve page's chart: one line per outcome, its
// chance in percent (the outcome token's price in USDG), from every swap in the market's pools.
import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, type ChartConfig } from "@/components/dither-kit";
import { usePriceHistory } from "@/hooks/useBook";
import { CARD_COLORS } from "@/lib/orderbook/listing";
import type { BookMarket } from "@/lib/orderbook/read";

const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ");

export default function BookPriceChart({ market }: { market: BookMarket }) {
  const { data: history, isLoading } = usePriceHistory(market);
  const data = history?.points;
  const config = useMemo(
    () => market.outcomes.reduce((acc, o, i) => { acc[o.name] = { label: o.name, color: CARD_COLORS[i % CARD_COLORS.length] }; return acc; }, {} as ChartConfig),
    [market.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rows = useMemo(() => (data ?? []).map(({ swap: _swap, ...p }) => ({ ...p, time: `${hhmm(p.t)} UTC` })), [data]); // eslint-disable-line @typescript-eslint/no-unused-vars
  const swaps = (data ?? []).filter((p) => p.swap === 1).length;

  return (
    <div className="w-full h-80 bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 relative flex flex-col p-4">
      <div className="flex justify-between items-center">
        <span className="font-mono text-xs text-neutral-500">Price History (chance, %)</span>
        <span className="font-mono text-[10px] text-neutral-500">{isLoading ? "" : `${swaps} trade${swaps === 1 ? "" : "s"} · 1 USDG = 100%`}</span>
      </div>
      <div className="flex-1 mt-4 overflow-visible relative min-h-[200px]">
        {isLoading || !data ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-neutral-500">Loading price history…</div>
        ) : (
          <LineChart data={rows} config={config} margins={{ left: 40, top: 10, bottom: 20, right: 10 }} interactive bloom="low" yMax={100}>
            <XAxis dataKey="time" hide />
            <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
            <Tooltip valueFormatter={(v: number) => `${v.toFixed(1)}%`} />
            {market.outcomes.map((o) => <Line key={o.name} dataKey={o.name} />)}
          </LineChart>
        )}
      </div>
    </div>
  );
}
