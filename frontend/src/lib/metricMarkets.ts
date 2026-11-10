import { isLlamaSlug, llamaMetricLabel, llamaProtocolSlug, llamaProtocolUrl } from '@/lib/defiLlama';

/**
 * How to present a polled-metric market (isRwa: TouchGrass vault balances,
 * DefiLlama protocol metrics) — one place for the labels, units and links the
 * market page shows, instead of a source check at every spot.
 *
 * 'retired' covers the two resolved markets on a data source that's since been
 * removed: they keep their description, without links.
 */

export type MetricSource = 'touchgrass' | 'defillama' | 'retired';

/** Same formatting the market page uses for USD targets. */
const compactUsd = (v: number) =>
  v < 10
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(v)
    : new Intl.NumberFormat('en-US', { notation: 'compact', style: 'currency', currency: 'USD' }).format(v);

const titleCase = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function describeMetricMarket(o: { rwaSlug?: string | null; rwaMetric?: string | null; displayName?: string | null }) {
  const slug = o.rwaSlug ?? '';
  const source: MetricSource = slug.startsWith('tg:') ? 'touchgrass' : isLlamaSlug(slug) ? 'defillama' : 'retired';
  const isYield = o.rwaMetric === 'YIELD_APY';

  if (source === 'touchgrass') {
    const symbol = slug.replace('tg:balance_', '');
    return {
      source,
      name: o.displayName || symbol,
      sourceName: 'TouchGrass',
      sourceHome: 'https://www.touchgrass.family/docs#reserves' as string | null,
      assetUrl: 'https://www.touchgrass.family/docs#reserves' as string | null,
      badge: 'Vault Balance',
      currentLabel: 'Current Balance',
      format: (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 6 })} shares`,
      targetTitle: (t: number) => `Vault Balance Target: ${t} shares`,
      targetText: (t: number) => `${t} shares`,
      subject: `the TouchGrass vault's ${symbol} balance`,
      plural: false,
    };
  }

  if (source === 'defillama') {
    const metric = llamaMetricLabel(o.rwaMetric);
    const name = o.displayName || titleCase(llamaProtocolSlug(slug));
    return {
      source,
      name,
      sourceName: 'DefiLlama',
      sourceHome: 'https://defillama.com',
      assetUrl: llamaProtocolUrl(slug),
      badge: o.rwaMetric === 'FEES_24H' ? 'Daily Fees' : 'TVL',
      currentLabel: o.rwaMetric === 'FEES_24H' ? 'Last Day' : 'Current TVL',
      format: compactUsd,
      targetTitle: (t: number) => `${o.rwaMetric === 'FEES_24H' ? 'Daily Fees' : 'TVL'} Target: > ${compactUsd(t)}`,
      targetText: compactUsd,
      subject: `${/s$/i.test(name) ? `${name}'` : `${name}'s`} ${metric}`,
      plural: o.rwaMetric === 'FEES_24H',
    };
  }

  const name = o.displayName || titleCase(slug);
  return {
    source,
    name,
    sourceName: 'its original data source (retired)',
    sourceHome: null,
    assetUrl: null,
    badge: isYield ? 'Yield APY' : 'Price Target',
    currentLabel: isYield ? 'Current APY' : 'Current Price',
    format: (v: number) => (isYield ? `${v.toFixed(2)}%` : compactUsd(v)),
    targetTitle: (t: number) => `RWA Target: ${isYield ? 'Yield APY' : 'Price'} > ${isYield ? `${t}%` : compactUsd(t)}`,
    targetText: (t: number) => (isYield ? `${t}%` : compactUsd(t)),
    subject: `the ${isYield ? 'yield (APY)' : 'price'} of ${titleCase(slug)}`,
    plural: false,
  };
}
