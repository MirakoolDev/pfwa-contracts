"use client";
// Order book markets: the list. Each card shows what the market is about (the coin, match or metric behind it, from
// its setup row), the leading chance, and one-click buttons into the market page with that outcome picked.
import Link from "next/link";
import { ArrowRight, Globe, Loader2, Plus, Tag, Target, Trophy } from "lucide-react";
import { OB_ENABLED } from "@/lib/orderbook/config";
import { fmtUsdg } from "@/lib/orderbook/math";
import { marketPhase, type BookMarket } from "@/lib/orderbook/read";
import { useBookMarkets } from "@/hooks/useBook";
import { formatMarketType, useOracleRow } from "@/components/book/BookOracleCard";
import { OUTCOME_COLORS, PhasePill, utc, PreviewNotice } from "@/components/book/ui";

const FACTS = [
  { icon: Target, text: "The price is the chance: 0.62 = 62%" },
  { icon: Trophy, text: "Every winning share pays 1 USDG" },
  { icon: Tag, text: "Name your price with limit orders" },
  { icon: Globe, text: "Pay from any chain with NEAR Intents" },
];

export default function BookMarketsPage() {
  const { data, isLoading, isError } = useBookMarkets();
  const markets = [...(data ?? [])].sort((a, b) => rank(a) - rank(b) || (b.collateral > a.collateral ? 1 : b.collateral < a.collateral ? -1 : 0));

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <PreviewNotice />
        <header className="space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-5">
            <div className="space-y-2 max-w-2xl">
              <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">Prediction markets · USDG · Robinhood Chain</p>
              <h1 className="font-heading text-3xl sm:text-4xl font-bold text-black dark:text-white tracking-tight leading-tight [text-wrap:balance]">
                Order book markets
              </h1>
              <p className="font-mono text-sm text-neutral-500 leading-relaxed">
                Back an outcome, sell any time before the end, and get 1 USDG a share if you&apos;re right.
              </p>
            </div>
            {OB_ENABLED && (
              <div className="flex flex-col items-start sm:items-end gap-2">
                <Link href="/book/create" className="inline-flex items-center gap-1.5 px-5 py-3 bg-[#00ff87] text-black font-heading font-bold text-sm hover:opacity-90 transition-opacity">
                  <Plus className="w-4 h-4" /> Create a market
                </Link>
                {/* Coin, football and DeFi markets keep their oracle setup in pfwa.fun's database, so they're made there. */}
                <a href="https://pfwa.fun/create?pricing=book" target="_blank" rel="noreferrer" className="font-mono text-[11px] text-neutral-500 hover:text-black dark:hover:text-white underline underline-offset-2">
                  Coin, football or DeFi market? Make it on pfwa.fun
                </a>
              </div>
            )}
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-neutral-200 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800">
            {FACTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-2.5 px-4 py-3 bg-white dark:bg-black font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
                <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[#00cc6a] dark:text-[#00ff87]" />
                <span className="min-w-0">{text}</span>
              </li>
            ))}
          </ul>
        </header>

        {!OB_ENABLED ? (
          <p className="font-mono text-sm text-neutral-500">Order book markets aren&apos;t live yet.</p>
        ) : isLoading ? (
          <p className="font-mono text-xs text-neutral-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Reading markets from chain…</p>
        ) : isError ? (
          <p className="font-mono text-xs text-red-500">Couldn&apos;t read the markets. Retrying…</p>
        ) : markets.length === 0 ? (
          <p className="font-mono text-sm text-neutral-500">No markets yet. Create the first one.</p>
        ) : (
          <section className="space-y-3">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">{markets.length} market{markets.length === 1 ? "" : "s"}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {markets.map((m) => <Card key={m.id} m={m} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Trading markets first, then ones waiting on a result, then finished ones. */
function rank(m: BookMarket) {
  const p = marketPhase(m);
  return p === "trading" ? 0 : p === "final" ? 2 : 1;
}

function timeLeft(sec: number) {
  const s = sec - Date.now() / 1000;
  if (s <= 0) return null;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function Card({ m }: { m: BookMarket }) {
  const phase = marketPhase(m);
  const { data: oracle } = useOracleRow(m.id);
  const image: string | null = oracle?.imageUrl ?? null;
  const subject: string | null = oracle ? oracle.displayName ?? (oracle.marketType ? `${formatMarketType(oracle.marketType)} target` : null) : "Custom market";
  const total = m.outcomes.reduce((a, o) => a + o.price, 0) || 1;
  const leader = m.outcomes.reduce((a, o) => (o.price > a.price ? o : a), m.outcomes[0]);
  const binary = m.outcomes.length === 2;
  const left = timeLeft(m.endOfTrading);
  const href = `/book/${m.id}`;
  const color = (i: number) => OUTCOME_COLORS[i % OUTCOME_COLORS.length];

  return (
    <article className="group flex flex-col bg-white dark:bg-black border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors">
      <Link href={href} className="flex flex-col gap-4 p-5 flex-1">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image || "/dither-logo.svg"} alt="" className="w-10 h-10 flex-shrink-0 rounded-full object-cover bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-heading font-bold text-[15px] text-black dark:text-white leading-snug [text-wrap:balance] group-hover:underline underline-offset-2 decoration-neutral-500/40">{m.question}</h3>
            {subject && <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500 truncate">{subject}</p>}
          </div>
        </div>

        {binary ? (
          <div className="space-y-2 mt-auto">
            <p className="font-heading font-bold text-3xl tabular-nums text-black dark:text-white">
              {Math.round((leader.price / total) * 100)}%
              <span className="ml-2 font-mono text-xs font-normal text-neutral-500">chance of {leader.name}</span>
            </p>
            <div className="flex h-1.5 overflow-hidden bg-neutral-100 dark:bg-neutral-900">
              {m.outcomes.map((o) => (
                <div key={o.token} style={{ width: `${(o.price / total) * 100}%`, backgroundColor: color(o.index) }} />
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5 mt-auto">
            {[...m.outcomes].sort((a, b) => b.price - a.price).slice(0, 3).map((o) => (
              <li key={o.token} className="flex items-center gap-2 font-mono text-xs">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color(o.index) }} />
                <span className="flex-1 min-w-0 truncate text-black dark:text-neutral-300">{o.name}</span>
                <span className="tabular-nums font-bold text-black dark:text-white">{Math.round(o.price * 100)}%</span>
              </li>
            ))}
            {m.outcomes.length > 3 && <li className="font-mono text-[10px] text-neutral-500">+{m.outcomes.length - 3} more</li>}
          </ul>
        )}
      </Link>

      {phase === "trading" && (
        <div className={`grid gap-2 px-5 ${binary ? "grid-cols-2" : "grid-cols-1"}`}>
          {(binary ? m.outcomes : [leader]).map((o) => (
            <Link
              key={o.token}
              href={`${href}?outcome=${encodeURIComponent(o.name)}`}
              className="flex items-center justify-between px-3 py-2 border font-mono text-xs hover:brightness-125 transition"
              style={{ borderColor: `${color(o.index)}55`, color: color(o.index), backgroundColor: `${color(o.index)}12` }}
            >
              <span className="font-bold">Buy {o.name}</span>
              <span className="tabular-nums">{Math.round(o.price * 100)}¢</span>
            </Link>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mx-5 mt-4 py-3 border-t border-neutral-100 dark:border-neutral-800/60 font-mono text-[10px] text-neutral-500">
        <span className="flex items-center gap-2 min-w-0">
          <PhasePill phase={phase} />
          <span className="truncate">{fmtUsdg(m.collateral, 0)} USDG in play</span>
        </span>
        <Link href={href} title={utc(m.endOfTrading)} className="flex items-center gap-1 flex-shrink-0 hover:text-black dark:hover:text-white">
          {phase === "trading" ? left ?? "Ending" : phase === "final" ? "Resolved" : "Trading ended"}
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </article>
  );
}
