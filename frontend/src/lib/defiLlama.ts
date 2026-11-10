/**
 * DefiLlama — the data source for onchain-metric markets ("Will X's TVL pass
 * $50M?"). Free public API, no key: https://api-docs.defillama.com/
 *
 * These markets ride the RWA pipeline (isRwa, polled hourly by the resolver,
 * counted once a value holds on two readings) with an asset slug of
 * `llama:<protocol slug>` — the same way TouchGrass uses `tg:` — and a metric
 * of TVL or FEES_24H (a day's fees — see MIN_DAILY_FEES_HOURS), so they need no schema change.
 */

export const LLAMA_API = 'https://api.llama.fi';
export const LLAMA_PREFIX = 'llama:';
/** DefiLlama's name for our chain in `chains` and `chainTvls`. */
export const LLAMA_CHAIN = 'Robinhood Chain';

export const LLAMA_METRICS = ['TVL', 'FEES_24H'] as const;
export type LlamaMetric = (typeof LLAMA_METRICS)[number];

export const isLlamaMetric = (m: unknown): m is LlamaMetric => LLAMA_METRICS.includes(m as LlamaMetric);
export const isLlamaSlug = (slug: unknown): slug is string => typeof slug === 'string' && slug.startsWith(LLAMA_PREFIX);
export const llamaProtocolSlug = (slug: string) => slug.slice(LLAMA_PREFIX.length);
export const llamaProtocolUrl = (slug: string) => `https://defillama.com/protocol/${isLlamaSlug(slug) ? llamaProtocolSlug(slug) : slug}`;

export const llamaMetricLabel = (metric: string | null | undefined) => (metric === 'FEES_24H' ? 'daily fees' : 'TVL');

/**
 * DefiLlama's "24h fees" is the total for the last completed day, updated about
 * once a day (and a day later for some protocols) — so a fees market needs at
 * least two days for a new figure to land before its deadline.
 */
export const MIN_DAILY_FEES_HOURS = 48;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The live value of one metric for a protocol, in USD, or null if DefiLlama
 * doesn't have it or can't be reached. TVL is the protocol's total across all
 * chains (DefiLlama's headline number); fees are the last 24 hours.
 */
export async function fetchLlamaMetric(slug: string, metric: LlamaMetric, init?: RequestInit): Promise<number | null> {
  const protocol = encodeURIComponent(isLlamaSlug(slug) ? llamaProtocolSlug(slug) : slug);
  try {
    if (metric === 'TVL') {
      const res = await fetch(`${LLAMA_API}/tvl/${protocol}`, { headers: { Accept: 'application/json' }, ...init });
      if (!res.ok) return null;
      return num(await res.json());
    }
    const res = await fetch(
      `${LLAMA_API}/summary/fees/${protocol}?dataType=dailyFees&excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
      { headers: { Accept: 'application/json' }, ...init },
    );
    if (!res.ok) return null;
    return num((await res.json())?.total24h);
  } catch {
    return null;
  }
}

export type LlamaProtocol = {
  slug: string;
  name: string;
  logo: string | null;
  category: string | null;
  /** Total TVL across all chains, USD. */
  tvl: number;
  /** TVL on Robinhood Chain, USD. */
  chainTvl: number;
  /** True when Robinhood Chain is the protocol's only chain. */
  native: boolean;
};

/** The fields we read from DefiLlama's /protocols list. */
type RawProtocol = {
  slug?: unknown;
  name?: unknown;
  logo?: unknown;
  category?: unknown;
  tvl?: unknown;
  chains?: unknown;
  chainTvls?: Record<string, unknown>;
};

/** Protocols DefiLlama tracks on Robinhood Chain, biggest there first. */
export async function fetchLlamaProtocols(init?: RequestInit): Promise<LlamaProtocol[] | null> {
  try {
    const res = await fetch(`${LLAMA_API}/protocols`, { headers: { Accept: 'application/json' }, ...init });
    if (!res.ok) return null;
    const all: unknown = await res.json();
    if (!Array.isArray(all)) return null;
    return (all as RawProtocol[])
      .filter((p): p is RawProtocol & { slug: string; chains: string[] } =>
        typeof p?.slug === 'string' && Array.isArray(p.chains) && p.chains.includes(LLAMA_CHAIN))
      .map((p): LlamaProtocol => ({
        slug: p.slug,
        name: String(p.name ?? p.slug),
        logo: typeof p.logo === 'string' ? p.logo : null,
        category: typeof p.category === 'string' ? p.category : null,
        tvl: num(p.tvl) ?? 0,
        chainTvl: num(p.chainTvls?.[LLAMA_CHAIN]) ?? 0,
        native: p.chains.length === 1,
      }))
      .filter((p) => p.chainTvl > 0)
      .sort((a, b) => b.chainTvl - a.chainTvl);
  } catch {
    return null;
  }
}
