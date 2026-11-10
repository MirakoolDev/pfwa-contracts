import { isLlamaSlug } from '@/lib/defiLlama';
import { footballBasisOf, footballCompetitionLabel, footballCompetitionOf, isFootballMarket } from '@/lib/football';

/**
 * A market's template, from its oracle row — for labels on cards and the market
 * page, and for the home page filters. (Market names alone can't tell templates
 * apart, and RWA/Onchain rows store marketType PRICE_UP internally.)
 */

export type MarketKind = 'challenge' | 'target' | 'versus' | 'rwa' | 'onchain' | 'football';

type OracleLike = {
  isChallenge?: boolean | null;
  isRwa?: boolean | null;
  isVersus?: boolean | null;
  rwaSlug?: string | null;
  rwaMetric?: string | null;
  marketType?: string | null;
  network?: string | null;
};

export function marketKindOf(o: OracleLike): MarketKind {
  if (o.isChallenge) return 'challenge';
  if (isFootballMarket(o)) return 'football';
  if (o.isRwa) return isLlamaSlug(o.rwaSlug) ? 'onchain' : 'rwa';
  if (o.isVersus) return 'versus';
  return 'target';
}

const METRIC: Record<string, string> = {
  PRICE_UP: 'Price',
  MARKET_CAP_UP: 'Market cap',
  VOLUME_UP: 'Volume',
  PRICE_DOWN: 'Dump',
  PRICE_DOWN_TIERS: 'Dump',
  CHALLENGE_24H_PNL: '24h PnL',
  CHALLENGE_7D_PNL: '7D PnL',
  CHALLENGE_30D_PNL: '30D PnL',
  WALLET_BALANCE: 'Portfolio',
};

/** "Target · Market cap", "Onchain · Daily fees", "Challenge · 7D PnL", … */
export function marketTypeLabel(o: OracleLike): string {
  const kind = marketKindOf(o);
  const metric = METRIC[o.marketType ?? ''] ?? '';
  switch (kind) {
    case 'challenge':
      return `Challenge · ${metric || 'PnL'}`;
    case 'football': {
      // "Premier League · Match", "La Liga · Match", "Champions League · 90 min", "Champions League · Full time"
      const c = footballCompetitionOf(o);
      const basis = footballBasisOf(o);
      return `${footballCompetitionLabel(o)} · ${basis === 'FULL_TIME' ? 'Full time' : c?.knockouts ? '90 min' : 'Match'}`;
    }
    case 'onchain':
      return `Onchain · ${o.rwaMetric === 'FEES_24H' ? 'Daily fees' : 'TVL'}`;
    case 'rwa':
      return o.rwaSlug?.startsWith('tg:') ? 'RWA · Vault balance' : `RWA · ${o.rwaMetric === 'YIELD_APY' ? 'Yield' : 'Price'}`;
    case 'versus':
      return `VS · ${metric || 'Market cap'}`;
    default:
      return `Target · ${metric || 'Price'}`;
  }
}

// ─── FOMO trader (Challenge) markets: retired for new markets ────────────────
// Markets on a FOMO trader's PnL or wallet balance can't be created any more:
// the create page doesn't offer them and the setup and registration routes
// refuse them (lib/bindMarketSetup.ts, api/markets/pending). Markets that
// already exist keep their oracle row, so they still trade, resolve, pay out
// and show on their pages exactly as before.

/** The marketType values only FOMO trader markets use. */
export const FOMO_MARKET_TYPES: readonly string[] = ['CHALLENGE_24H_PNL', 'CHALLENGE_7D_PNL', 'CHALLENGE_30D_PNL', 'WALLET_BALANCE'];

export const FOMO_RETIRED = 'FOMO trader (Challenge) markets can no longer be created';

/** Is this market setup (create-page payload or oracle row data) a FOMO trader market? */
export function isFomoSetup(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    !!d.isChallenge ||
    FOMO_MARKET_TYPES.includes(String(d.marketType ?? '')) ||
    (typeof d.fomoHandle === 'string' && d.fomoHandle.trim() !== '') ||
    d.network === 'multi'
  );
}
