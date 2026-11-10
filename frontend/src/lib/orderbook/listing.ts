// Order book markets in PFWA's market lists: which ones are listed (the creator's liquidity is locked), and the
// card shape the main grid (api/markets/live, components/MarketCard) and the market page share. Client and server.
import type { PublicClient } from 'viem';
import { marketKindOf, marketTypeLabel } from '@/lib/marketTypes';
import { MIN_LOCKED_RAW } from './liquidity';
import { obLockerAbi } from './abi';
import { MULTICALL3, OB } from './config';
import { bookMarketIds, loadBookMarkets, type BookMarket } from './read';
import { fmtUsdg } from './math';

type Client = Pick<PublicClient, 'multicall' | 'readContract'>;

/** The bonding curve markets' outcome colours, in the same order, so both kinds of market look alike. */
export const CARD_COLORS = ['blue', 'purple', 'pink', 'green', 'orange', 'red'] as const;

/** PFWA lists an order book market only once its creator has locked at least MIN_CREATOR_LIQUIDITY_USDG in the
 *  LiquidityLocker (app rule; the contracts don't require it). Without a locker configured, every market shows. */
export async function withCreatorLiquidity(client: Client, markets: BookMarket[]): Promise<BookMarket[]> {
  if (!OB.locker || markets.length === 0) return markets;
  const locked = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: markets.map((m) => ({ address: OB.locker!, abi: obLockerAbi, functionName: 'lockedUsdg', args: [BigInt(m.id), m.creator] }) as const),
  });
  return markets.filter((_, i) => locked[i].status === 'success' && (locked[i].result as bigint) >= MIN_LOCKED_RAW);
}

/** Every listed order book market, newest first. */
export async function listedBookMarkets(client: Client): Promise<BookMarket[]> {
  const ids = await bookMarketIds(client);
  const markets = await loadBookMarkets(client, ids);
  return (await withCreatorLiquidity(client, markets)).sort((a, b) => b.id - a.id);
}

function endsOn(endOfTrading: number): string {
  const diff = endOfTrading * 1000 - Date.now();
  if (diff < 0) return 'Expired';
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} Days`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Outcomes as MarketCard draws them: chance is the outcome token's price (1 USDG pays out), in percent. */
export const cardOutcomes = (m: BookMarket) =>
  m.outcomes.map((o, i) => ({ label: o.name, tokenAddress: o.token, chance: Math.round(o.price * 100), color: CARD_COLORS[i % CARD_COLORS.length] }));

/**
 * One order book market in the live markets list's shape (api/markets/live), so the grid, search and landing show it
 * next to bonding curve markets. `pricing: 'book'` and `href` send clicks to /book/<id>; the ETH fields are zero.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bookMarketCard(m: BookMarket, oracle: any | null, creatorUser?: unknown) {
  return {
    id: m.id,
    pricing: 'book' as const,
    href: `/book/${m.id}`,
    title: m.question,
    name: m.question,
    marketType: 0,
    expirationTime: String(m.endOfTrading),
    resolved: m.resolved,
    resolvedBy: oracle?.resolvedBy ?? null,
    creator: m.creator.toLowerCase(),
    creatorIsOnFraudWatch: false,
    winningOptionIndex: m.resolved ? m.winningOutcome : 0,
    optionCount: m.outcomes.length,
    options: m.outcomes.map((o) => ({ name: o.name, tokenAddress: o.token, optionId: String(o.index) })),
    ethBalances: m.outcomes.map(() => '0'),
    totalETH: '0',
    bonusPot: '0',
    tradesCount: 0,
    category: oracle ? marketTypeLabel(oracle) : 'Custom',
    kind: oracle ? marketKindOf(oracle) : null,
    endsOn: endsOn(m.endOfTrading),
    volume: `${fmtUsdg(m.collateral)} USDG`,
    outcomes: cardOutcomes(m),
    image: oracle?.imageUrl || '/default-avatar.png',
    image2: oracle?.imageUrl2,
    creatorUser,
    oracleData: oracle,
  };
}
