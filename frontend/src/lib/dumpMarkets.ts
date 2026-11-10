/**
 * Dump markets: the Target template turned around — how far does a token's
 * price fall from where it was when the market opened?
 *
 * - PRICE_DOWN: YES/NO, "does it fall `targetValue`% or more before the deadline?"
 * - PRICE_DOWN_TIERS: one outcome per range of the deepest fall before the
 *   deadline (DUMP_TIERS). The ranges don't overlap, so exactly one wins.
 *
 * The fall is measured from the token's last traded price at or before the
 * market opened, to the lowest hourly close after it (lib/geckoPeak.ts). Hourly
 * closes, not wicks: one thin-pool trade can print a near-zero low that the
 * price never actually sat at.
 */

export const DUMP_TYPES = ['PRICE_DOWN', 'PRICE_DOWN_TIERS'] as const;
export type DumpType = (typeof DUMP_TYPES)[number];

export const isDumpType = (t: string | null | undefined): t is DumpType => DUMP_TYPES.includes(t as DumpType);

/** Where the tiered market's ranges split, in % below the opening price. */
export const DUMP_TIERS = [50, 80, 90] as const;

/** Presets for the YES/NO version. */
export const DUMP_THRESHOLDS = [30, 50, 80, 90] as const;

/** Tiered outcomes, in onchain option order: "Under 50%", "50–80%", "80–90%", "90%+". */
export function dumpTierNames(): string[] {
  const t = DUMP_TIERS;
  return [`Under ${t[0]}%`, ...t.slice(1).map((v, i) => `${t[i]}–${v}%`), `${t[t.length - 1]}%+`];
}

/** The tiered outcome a fall of `pct`% lands in. */
export function dumpTierIndex(pct: number): number {
  const i = DUMP_TIERS.findIndex((t) => pct < t);
  return i === -1 ? DUMP_TIERS.length : i;
}

/** How far `low` is below `start`, in % (0 when it never went below). */
export function fallPct(start: number, low: number): number {
  return start > 0 ? Math.max(0, (1 - low / start) * 100) : 0;
}

/** "fall 80% or more", for questions and rules. */
export const dumpThresholdText = (pct: number) => `fall ${pct}% or more`;
