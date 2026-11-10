"use client";
// Oracle data for an order book market: the same card the bonding curve market page shows (app/market/[id]), read
// from the market's setup row (LiveOracleMarket) and the same oracle routes the resolver bot uses.
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import TargetTrack from "@/components/market/TargetTrack";
import { describeMetricMarket } from "@/lib/metricMarkets";
import { isLlamaSlug, llamaProtocolSlug } from "@/lib/defiLlama";
import { DUMP_TIERS, dumpTierNames, isDumpType } from "@/lib/dumpMarkets";
import { FOOTBALL_BASIS_TAG, footballBasisOf, footballCompetitionLabel, footballCompetitionOf, footballKickoffMs, footballMatchId, isFootballMarket, isFootballSlug } from "@/lib/football";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OracleRow = any;

export const formatCompactUSD = (val: number) =>
  val < 10
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(val)
    : new Intl.NumberFormat("en-US", { notation: "compact", style: "currency", currency: "USD" }).format(val);

export const formatMarketType = (type: string) =>
  ({ PRICE_UP: "Price", MARKET_CAP_UP: "Market Cap", VOLUME_UP: "24h Volume", PRICE_DOWN: "Price Fall", PRICE_DOWN_TIERS: "Price Fall" } as Record<string, string>)[type] ??
  type.replace("_UP", "");

const dumpRuleTitle = (o: { marketType: string; targetValue: number }) =>
  o.marketType === "PRICE_DOWN_TIERS"
    ? `Dump: how far the price falls from the opening price (${dumpTierNames().join(" / ")})`
    : `Dump: price falls ${o.targetValue}% or more from the opening price`;

const fmtFall = (v: number) => (v <= 0 ? "0%" : `−${v.toFixed(v < 10 ? 1 : 0)}%`);

const formatUtcDateTime = (date: string | Date) =>
  new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

/** The market's setup row, or null for a custom market (no data source). */
export function useOracleRow(marketId: number) {
  return useQuery({
    queryKey: ["book", "oracle", marketId],
    staleTime: 60_000,
    queryFn: async (): Promise<OracleRow | null> => {
      const res = await fetch(`/api/market/${marketId}/oracle`);
      if (res.status === 404) return null;
      const data = await res.json();
      return data.success ? data.oracleData : null;
    },
  });
}

type Live = {
  live: number | null;
  peak: number | null;
  start: number | null;
  name: string | null;
  symbol: string | null;
  dump: { start: number; low: number | null; fallPct: number | null } | null;
  match: { status: string; score: { home: number | null; away: number | null } } | null;
};

/** Live readings from the same routes the bonding curve page uses. */
function useLive(o: OracleRow | null) {
  return useQuery({
    queryKey: ["book", "oracle-live", o?.id],
    enabled: !!o,
    refetchInterval: 60_000,
    queryFn: async (): Promise<Live> => {
      const out: Live = { live: null, peak: null, start: null, name: null, symbol: null, dump: null, match: null };
      if (isFootballMarket(o)) {
        if (isFootballSlug(o.tokenAddress) && Date.now() >= footballKickoffMs(o.endTime)) {
          const json = await (await fetch(`/api/oracle/football?id=${footballMatchId(o.tokenAddress)}&network=${encodeURIComponent(o.network || "")}`)).json();
          if (json.ok) out.match = json.match;
        }
      } else if (o.isRwa && isLlamaSlug(o.rwaSlug)) {
        const json = await (await fetch(`/api/oracle/defillama?slug=${encodeURIComponent(llamaProtocolSlug(o.rwaSlug))}&metric=${o.rwaMetric}`)).json();
        if (json.ok && typeof json.value === "number") out.live = json.value;
      } else if (o.isRwa && o.rwaSlug?.startsWith("tg:")) {
        const json = await (await fetch(`/api/oracle/rwa?slug=${encodeURIComponent(o.rwaSlug)}`)).json();
        if (json.ok) out.live = json.priceUsd ?? json.navPerToken ?? null;
      } else if (!o.isVersus) {
        const p = await (await fetch(`/api/oracle/historical-peak?ca=${o.tokenAddress}&marketType=${o.marketType}&createdAt=${o.createdAt}&endTime=${o.endTime}&network=${o.network}`)).json();
        out.start = p?.startValue ?? null;
        out.name = p?.name ?? null;
        out.symbol = p?.symbol ?? null;
        out.live = p?.currentValue ?? null;
        if (isDumpType(o.marketType)) {
          if (p?.startValue != null) out.dump = { start: p.startValue, low: p.lowValue, fallPct: p.fallPct };
        } else out.peak = p?.peakValue ?? null;
      }
      return out;
    },
  });
}

const Badge = ({ children, tone = "violet" }: { children: React.ReactNode; tone?: "violet" | "green" }) => (
  <span
    className={`font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border ${
      tone === "green" ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-violet-500/10 text-violet-400 border-violet-500/20"
    }`}
  >
    {children}
  </span>
);

const Stat = ({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) => (
  <div className="flex flex-col gap-0.5 p-3 bg-neutral-50 dark:bg-neutral-900/60 rounded-lg border border-neutral-100 dark:border-neutral-800/60 min-w-0">
    <span className="text-[10px] text-neutral-400 uppercase tracking-widest truncate">{label}</span>
    <span className={`font-bold text-sm truncate ${accent ? "text-[#00ff87]" : "text-black dark:text-white"}`}>{value}</span>
  </div>
);

const SourceLink = ({ href, name }: { href: string; name: string }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest w-fit bg-blue-500/10 px-2 py-1 rounded">
    View on {name} <ExternalLink className="w-3 h-3" />
  </a>
);

const Dim = ({ children }: { children: React.ReactNode }) => <span className="text-neutral-400 font-normal">{children}</span>;

/**
 * What the oracle points to, by the resolver's rules: the outcome index (0 = YES, 1 = NO on target markets) once it's
 * settled, else null, with a one-line reason. Football and versus markets are read from the card, not settled here.
 */
export function useOracleVerdict(o: OracleRow | null, expired: boolean): { pick: number | null; text: string } | null {
  const { data: live } = useLive(o);
  if (!o) return null;
  if (!live) return { pick: null, text: "Reading the data source…" };
  if (isFootballMarket(o)) return { pick: null, text: live.match ? `Match ${live.match.status.replace(/_/g, " ").toLowerCase()}` : "Match not started" };
  if (o.isVersus) return { pick: null, text: "Compare the values at the deadline" };
  if (o.isRwa) {
    const hit = live.live !== null && live.live >= o.targetValue;
    return hit ? { pick: 0, text: "YES · target reached" } : expired ? { pick: 1, text: "NO · not reached by the deadline" } : { pick: null, text: "Not reached yet" };
  }
  if (isDumpType(o.marketType)) {
    if (o.marketType === "PRICE_DOWN_TIERS") return { pick: null, text: live.dump?.fallPct != null ? `Lowest close ${fmtFall(live.dump.fallPct)}` : "No hourly close yet" };
    const hit = live.dump?.fallPct != null && live.dump.fallPct >= o.targetValue;
    return hit ? { pick: 0, text: "YES · fell far enough" } : expired ? { pick: 1, text: "NO · didn't fall far enough" } : { pick: null, text: "Not yet" };
  }
  const hit = live.peak !== null && live.peak >= o.targetValue;
  return hit ? { pick: 0, text: "YES · target reached" } : expired ? { pick: 1, text: "NO · not reached by the deadline" } : { pick: null, text: "Not reached yet" };
}

export default function BookOracleCard({ oracle, resolved, expired, bare }: { oracle: OracleRow; resolved: boolean; expired: boolean; bare?: boolean }) {
  const { data: live } = useLive(oracle);
  const o = oracle;

  let body: React.ReactNode;
  if (isFootballMarket(o)) {
    const m = live?.match;
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-3 flex-shrink-0">
            {[o.imageUrl, o.imageUrl2].map((src: string | null, i: number) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src || "/default-avatar.png"} alt="" className="w-10 h-10 rounded-full object-contain bg-white ring-2 ring-white dark:ring-[#0a0a0a]" />
            ))}
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-heading font-bold text-base text-black dark:text-white block truncate">{o.displayName}</span>
            <span className="font-mono text-[10px] text-neutral-400 uppercase tracking-widest">
              {footballCompetitionLabel(o)}
              {footballBasisOf(o) === "FULL_TIME" ? ` · ${FOOTBALL_BASIS_TAG.FULL_TIME}` : footballCompetitionOf(o)?.knockouts ? ` · ${FOOTBALL_BASIS_TAG.NINETY}` : ""} · kickoff{" "}
              {formatUtcDateTime(new Date(footballKickoffMs(o.endTime)).toISOString())}
            </span>
          </div>
        </div>
        <p className="font-mono text-xs text-neutral-500">
          {m
            ? <>{m.status.replace(/_/g, " ").toLowerCase()}{m.score.home !== null && m.score.away !== null && <> · Score {m.score.home}–{m.score.away}</>}</>
            : expired ? "Match data loading…" : "Not started yet. Trading stays open during the match."}
        </p>
      </div>
    );
  } else if (o.isRwa) {
    const metric = describeMetricMarket(o);
    const v = live?.live ?? null;
    const pct = v !== null && o.targetValue > 0 ? Math.min(100, (v / o.targetValue) * 100) : null;
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={o.imageUrl || "/dither-logo.svg"} alt="" className="w-12 h-12 rounded-full object-cover border border-neutral-200 dark:border-neutral-800" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-heading font-bold text-base text-black dark:text-white">{metric.name}</span>
              <Badge>{metric.badge}</Badge>
              {!resolved && v !== null && v >= o.targetValue && <Badge tone="green">Target met · resolving soon</Badge>}
            </div>
            {o.createdAt && <p className="font-mono text-[10px] text-neutral-400 mt-0.5">Created {formatUtcDateTime(o.createdAt)}</p>}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 font-mono text-xs">
          <Stat label={metric.currentLabel} value={v !== null ? metric.format(v) : "—"} />
          <Stat label="Target" value={metric.targetText(o.targetValue)} />
          <Stat label="Progress" value={pct !== null ? `${pct.toFixed(1)}%` : "—"} accent={pct === 100} />
        </div>
        {metric.assetUrl && <SourceLink href={metric.assetUrl} name={metric.sourceName} />}
      </div>
    );
  } else if (o.isVersus) {
    body = (
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs text-neutral-500 leading-relaxed">
          Compares <strong className="text-black dark:text-white">{formatMarketType(o.marketType)}</strong> at the deadline ({formatUtcDateTime(o.endTime)}): the token with the strictly higher value wins.
        </p>
        {o.geckoTerminalUrl && <SourceLink href={o.geckoTerminalUrl} name="GeckoTerminal" />}
      </div>
    );
  } else {
    // Token target and dump markets: progress from the opening value to the target, by the resolver's rules.
    const type: string = o.marketType ?? "";
    const target: number = o.targetValue ?? 0;
    const dump = isDumpType(type);
    const tiered = type === "PRICE_DOWN_TIERS";
    const d = live?.dump ?? null;
    const now = live?.live ?? null;
    const peak = live?.peak ?? null;
    const fallTarget = tiered ? DUMP_TIERS[DUMP_TIERS.length - 1] : target;
    const fallNow = dump && d && now !== null ? Math.max(0, (1 - now / d.start) * 100) : null;
    const fallLow = d?.fallPct ?? null;
    const hit = dump ? fallLow !== null && fallLow >= fallTarget : peak !== null && peak >= target;
    const toGo = dump ? null : expired ? (peak ? (target / peak - 1) * 100 : null) : now ? (target / now - 1) * 100 : null;
    const rule = dump
      ? `${dumpRuleTitle(o)}, measured on hourly closes.`
      : type === "VOLUME_UP"
        ? `Resolves YES if trading volume over any 24 hours in a row reaches ${formatCompactUSD(target)} before the deadline.`
        : type === "MARKET_CAP_UP"
          ? `Resolves YES if the market cap (FDV) at any hourly high reaches ${formatCompactUSD(target)} before the deadline.`
          : `Resolves YES if any hourly high reaches ${formatCompactUSD(target)} before the deadline.`;
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={o.imageUrl || "/default-avatar.png"} alt="" className="w-12 h-12 rounded-full object-cover border border-neutral-200 dark:border-neutral-800 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-heading font-bold text-base text-black dark:text-white truncate">{live?.name ?? "Token"}</span>
              {live?.symbol && <span className="font-mono text-xs text-neutral-400">{live.symbol}</span>}
              <Badge>{dump ? (tiered ? "Dump · tiers" : "Dump") : `${formatMarketType(type)} target`}</Badge>
              {!resolved && hit && <Badge tone="green">Target hit · resolving soon</Badge>}
            </div>
            <p className="font-mono text-[10px] text-neutral-400 mt-0.5">
              {o.createdAt && <>Opened {formatUtcDateTime(o.createdAt)} · </>}Deadline {formatUtcDateTime(o.endTime)}
            </p>
          </div>
        </div>
        {dump ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
            <Stat label="Opened at" value={d ? formatCompactUSD(d.start) : "—"} />
            <Stat label="Now" value={now !== null ? <>{formatCompactUSD(now)}{fallNow !== null && <Dim> {fmtFall(fallNow)}</Dim>}</> : "—"} />
            <Stat label="Lowest close" value={d?.low != null && fallLow !== null ? <>{formatCompactUSD(d.low)}<Dim> {fmtFall(fallLow)}</Dim></> : <Dim>No hourly close yet</Dim>} />
            <Stat label="Target" value={tiered ? DUMP_TIERS.map((v) => `${v}%`).join(" / ") : fmtFall(target)} accent={hit} />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
            <Stat label="Now" value={now !== null ? formatCompactUSD(now) : "—"} />
            <Stat label={expired ? "Peak before deadline" : "Peak since open"} value={peak !== null ? formatCompactUSD(peak) : <Dim>None yet</Dim>} accent={hit} />
            <Stat label="Target" value={formatCompactUSD(target)} />
            <Stat label={expired && !hit ? "Missed by" : "To go"} value={hit ? "Hit" : toGo === null ? "—" : toGo <= 0 ? "At target" : `+${toGo.toFixed(toGo < 100 ? 1 : 0)}%`} accent={hit} />
          </div>
        )}
        {dump
          ? d && <TargetTrack compact={false} start={0} now={fallNow} peak={fallLow} target={fallTarget} format={fmtFall} hit={hit} startLabel="" peakLabel="Lowest close" ticks={tiered ? DUMP_TIERS.slice(0, -1).map((v) => ({ value: v, label: `${v}%` })) : []} />
          : live?.start != null && (expired
            ? <TargetTrack compact={false} start={live.start} now={peak} peak={null} target={target} format={formatCompactUSD} hit={hit} startLabel="Open" nowLabel="Peak" />
            : <TargetTrack compact={false} start={live.start} now={now} peak={peak} target={target} format={formatCompactUSD} hit={hit} startLabel="Open" />)}
        <p className="font-mono text-[10px] text-neutral-400 leading-relaxed">{rule} Read by the resolver from GeckoTerminal&apos;s hourly data.</p>
        {o.geckoTerminalUrl && <SourceLink href={o.geckoTerminalUrl} name="GeckoTerminal" />}
      </div>
    );
  }

  if (bare) return <>{body}</>;
  return (
    <section className="bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 p-4 sm:p-6">
      <h2 className="font-heading font-600 text-sm mb-4 flex items-center gap-2 text-black dark:text-white">
        <span className="w-2 h-2 rounded-full bg-blue-500" />
        Oracle Data
      </h2>
      {body}
    </section>
  );
}
