"use client";

/**
 * A target market's progress, drawn from where the market opened to its target
 * rather than from zero: a price that has to go from $228 to $251 is 0% of the way
 * there, not 91%. The fill follows the live value; the tick marks the peak, which
 * is what the resolver decides on. Dump markets pass percentages fallen instead.
 */
export default function TargetTrack({
  start,
  now,
  peak,
  target,
  format,
  hit,
  startLabel = "Start",
  peakLabel = "Peak",
  nowLabel = "Now",
  ticks = [],
  compact = false,
}: {
  /** Value when the market opened; null falls back to a 0 → target scale. */
  start: number | null;
  now: number | null;
  peak: number | null;
  target: number;
  format: (v: number) => string;
  /** The target was reached (by the peak, or however the market decides). */
  hit: boolean;
  startLabel?: string;
  /** What the tick marks: the peak, or for a dump market the lowest close. */
  peakLabel?: string;
  /** What the dot marks: the live value, or the peak once the deadline has passed. */
  nowLabel?: string;
  /** Extra marks along the scale, e.g. dump tiers. */
  ticks?: { value: number; label: string }[];
  compact?: boolean;
}) {
  const lo = start !== null && start < target ? start : 0;
  const span = target - lo;
  const at = (v: number | null) => (v === null || span <= 0 ? null : Math.min(1, Math.max(0, (v - lo) / span)) * 100);
  const nowAt = at(now);
  const peakAt = at(peak);
  const fill = hit ? 100 : nowAt ?? 0;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <div className={`relative ${compact ? "h-1.5" : "h-2"} rounded-full bg-neutral-200 dark:bg-neutral-800`}>
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${hit ? "bg-[#00ff87] shadow-[0_0_12px_rgba(0,255,135,0.45)]" : "bg-gradient-to-r from-indigo-500 to-violet-400"}`}
          style={{ width: `${fill}%` }}
        />
        {ticks.map((t) => {
          const x = at(t.value);
          return x === null || x >= 100 ? null : (
            <span key={t.label} title={t.label} className="absolute -top-0.5 -bottom-0.5 w-px bg-neutral-400/70 dark:bg-neutral-500" style={{ left: `${x}%` }} />
          );
        })}
        {!hit && peakAt !== null && peakAt > 0 && (
          <span title={`${peakLabel} ${format(peak!)}`} className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded bg-black dark:bg-white" style={{ left: `${peakAt}%` }} />
        )}
        {!hit && nowAt !== null && (
          <span
            title={`${nowLabel} ${format(now!)}`}
            className={`absolute top-1/2 ${compact ? "w-2.5 h-2.5" : "w-3 h-3"} -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-indigo-500 shadow`}
            style={{ left: `${nowAt}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 font-mono text-[10px] text-neutral-400">
        <span>{lo === 0 && start === null ? "0" : `${startLabel ? `${startLabel} ` : ""}${format(lo)}`}</span>
        {!compact && !hit && (
          <span className="hidden sm:flex items-center gap-3">
            {now !== null && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-white ring-2 ring-indigo-500" />{nowLabel}</span>}
            {peak !== null && peakAt !== null && peakAt > 0 && <span className="flex items-center gap-1"><span className="w-0.5 h-2.5 rounded bg-black dark:bg-white" />{peakLabel}</span>}
          </span>
        )}
        <span className={hit ? "text-[#00ff87]" : ""}>Target {format(target)}</span>
      </div>
    </div>
  );
}
