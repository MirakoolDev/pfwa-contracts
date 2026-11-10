"use client";
// Trade History and Holders for an order book market, laid out like the bonding curve market page's tabs: every
// buy and sell in the outcomes' pools (read from the chain), and who holds each outcome now.
import { useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink } from "lucide-react";
import { useHolders, usePriceHistory } from "@/hooks/useBook";
import { robinhoodChain } from "@/lib/config";
import { CARD_COLORS } from "@/lib/orderbook/listing";
import { fmtAmount } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";

const EXPLORER = robinhoodChain.blockExplorers.default.url;
/** Short labels for known wallets in the trade list: NEXT_PUBLIC_WALLET_LABELS, e.g. "0xabc…=Market maker,0xdef…=Relayer". */
const LABELS: Record<string, string> = Object.fromEntries(
  (process.env.NEXT_PUBLIC_WALLET_LABELS ?? "").split(",").map((p) => p.split("=")).filter(([a, l]) => /^0x[0-9a-fA-F]{40}$/.test(a?.trim() ?? "") && l?.trim()).map(([a, l]) => [a.trim().toLowerCase(), l.trim()]),
);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (t: number) => new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";

const th = "p-3 font-medium";
const td = "p-3 whitespace-nowrap";

export default function BookActivity({ market }: { market: BookMarket }) {
  const { address } = useAccount();
  const [tab, setTab] = useState<"trades" | "holders">("trades");
  const { data: history, isLoading } = usePriceHistory(market);
  const holders = useHolders(tab === "holders" ? market : null);
  const trades = history?.trades ?? [];
  const me = address?.toLowerCase();

  const Who = ({ a }: { a: string | null }) => !a ? <>—</> : (
    <span className="flex items-center gap-2">
      <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer" className="hover:text-black dark:hover:text-white">{LABELS[a.toLowerCase()] ?? short(a)}</a>
      {me === a.toLowerCase() && <span className="px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-800 text-[10px] rounded text-neutral-600 dark:text-neutral-400">You</span>}
    </span>
  );
  const Outcome = ({ i }: { i: number }) => (
    <span className="flex items-center gap-2">
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: CARD_COLORS[i % CARD_COLORS.length] }} />
      {market.outcomes[i]?.name ?? `Outcome ${i + 1}`}
    </span>
  );
  const Tab = ({ id, children }: { id: "trades" | "holders"; children: React.ReactNode }) => (
    <button type="button" onClick={() => setTab(id)} className={`pb-2 font-heading font-600 text-sm transition-colors ${tab === id ? "text-black dark:text-white border-b-2 border-black dark:border-white" : "text-neutral-500 hover:text-black dark:hover:text-white"}`}>
      {children}
    </button>
  );
  const Empty = ({ cols, children }: { cols: number; children: React.ReactNode }) => (
    <tr><td colSpan={cols} className="p-4 text-center text-xs font-mono text-neutral-500">{children}</td></tr>
  );

  return (
    <div className="w-full flex flex-col">
      <div className="flex gap-4 mb-4 border-b border-neutral-200 dark:border-neutral-800">
        <Tab id="trades">Trade History</Tab>
        <Tab id="holders">Holders</Tab>
      </div>
      <div className="border border-neutral-200 dark:border-neutral-800 overflow-x-auto bg-white dark:bg-[#0a0a0a]">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 text-xs font-mono text-neutral-500 uppercase tracking-widest">
              {tab === "trades" ? (
                <><th className={th}>Time</th><th className={th}>Trader</th><th className={th}>Outcome</th><th className={th}>Type</th><th className={th}>Shares</th><th className={th}>USDG</th><th className={th}>Price</th><th className={`${th} text-right`}>Tx</th></>
              ) : (
                <><th className={th}>Holder</th><th className={th}>Outcome</th><th className={th}>Shares</th><th className={`${th} text-right`}>{market.resolved ? "Value" : "Pays if it wins"}</th></>
              )}
            </tr>
          </thead>
          <tbody className="font-mono text-xs text-black dark:text-neutral-300">
            {tab === "trades" ? (
              isLoading ? <Empty cols={8}>Loading trades…</Empty> : trades.length === 0 ? <Empty cols={8}>No trades yet.</Empty> : trades.map((t) => (
                <tr key={`${t.tx}-${t.outcome}`} className="border-b border-neutral-100 dark:border-neutral-800/50 hover:bg-neutral-50 dark:hover:bg-neutral-900/30">
                  <td className={td}>{when(t.t)}</td>
                  <td className={`${td} text-neutral-400`}>
                    <Who a={t.trader} />
                    {t.via && <span className="block text-[10px] text-neutral-500 mt-0.5" title="Paid from another chain; PFWA's relayer sent the buy for this wallet">via {t.via}</span>}
                  </td>
                  <td className={td}><Outcome i={t.outcome} /></td>
                  <td className={`${td} font-bold ${t.isBuy ? "text-[#00cc6a] dark:text-[#00ff87]" : "text-red-400"}`}>{t.isBuy ? "Buy" : "Sell"}</td>
                  <td className={`${td} tabular-nums`}>{fmtAmount(t.tokens)}</td>
                  <td className={`${td} tabular-nums`}>{fmtAmount(t.usdg)}</td>
                  <td className={`${td} tabular-nums`}>{(t.price * 100).toFixed(1)}¢</td>
                  <td className={`${td} text-right`}>
                    <a href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-neutral-400 hover:text-black dark:hover:text-white">
                      {short(t.tx)} <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))
            ) : holders.isLoading || !holders.data ? <Empty cols={4}>Loading holders…</Empty> : holders.data.length === 0 ? <Empty cols={4}>No holders yet.</Empty> : holders.data.map((h) => (
              <tr key={`${h.holder}-${h.outcome}`} className="border-b border-neutral-100 dark:border-neutral-800/50 hover:bg-neutral-50 dark:hover:bg-neutral-900/30">
                <td className={`${td} text-neutral-400`}><Who a={h.holder} /></td>
                <td className={td}><Outcome i={h.outcome} /></td>
                <td className={`${td} tabular-nums`}>{fmtAmount(h.balance)}</td>
                <td className={`${td} text-right tabular-nums`}>
                  {market.resolved ? (h.outcome === market.winningOutcome ? `${fmtAmount(h.balance)} USDG` : "0 USDG") : `${fmtAmount(h.balance)} USDG`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
