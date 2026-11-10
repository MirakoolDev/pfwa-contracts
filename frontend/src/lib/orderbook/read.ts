// Reads order book markets straight from the chain in two multicalls: the factory and resolver first, then each
// market's state, its pools' prices and its outcome tokens. Shared by the pages (and later the markets API).
import { erc20Abi, type Address, type PublicClient } from 'viem';
import { OB, MULTICALL3, STATE_VIEW, USDG, INVALID_OUTCOME, FIRST_MARKET_ID } from './config';
import { obFactoryAbi, obHookAbi, obMarketAbi, obResolverAbi, stateViewAbi } from './abi';
import { outcomePrice, poolIdOf, type PoolKey } from './math';

export type ResolutionState = 'open' | 'pending' | 'disputed' | 'final';
const STATES: ResolutionState[] = ['open', 'open', 'pending', 'disputed', 'final'];

export type BookOutcome = {
  index: number;
  name: string;
  token: Address;
  key: PoolKey;
  poolId: `0x${string}`;
  usdgIs0: boolean;
  sqrtPriceX96: bigint;
  tick: number;
  /** USDG per token, 0.001–0.999. */
  price: number;
  boundLower: number;
  boundUpper: number;
  supply: bigint;
};

export type BookMarket = {
  id: number;
  market: Address;
  creator: Address;
  question: string;
  /** How the outcome is decided, stored onchain with the market: what disputes are judged against. */
  rules: string;
  setupHash: `0x${string}`;
  endOfTrading: number;
  depositCap: bigint;
  halted: boolean;
  resolved: boolean;
  winningOutcome: number;
  tradingOpen: boolean;
  /** USDG held: every outcome's supply equals it before resolution. */
  collateral: bigint;
  creatorFeeBps: number;
  protocolFeeBps: number;
  outcomes: BookOutcome[];
  resolution: {
    state: ResolutionState;
    outcome: number;
    disputeEnds: number;
    bond: bigint;
    disputer: Address;
  };
};

type Client = Pick<PublicClient, 'multicall' | 'readContract'>;

export async function bookMarketIds(client: Client): Promise<number[]> {
  if (!OB.factory) return [];
  const next = await client.readContract({ address: OB.factory, abi: obFactoryAbi, functionName: 'nextMarketId' });
  const ids: number[] = [];
  for (let id = FIRST_MARKET_ID; id < Number(next); id++) ids.push(id);
  return ids;
}

export async function loadBookMarkets(client: Client, ids: number[]): Promise<BookMarket[]> {
  if (!OB.factory || !OB.resolver || ids.length === 0) return [];
  const factory = OB.factory;
  const resolver = OB.resolver;

  const first = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { address: factory, abi: obFactoryAbi, functionName: 'getMarket', args: [BigInt(id)] } as const,
      { address: factory, abi: obFactoryAbi, functionName: 'getPools', args: [BigInt(id)] } as const,
      { address: resolver, abi: obResolverAbi, functionName: 'resolutions', args: [BigInt(id)] } as const,
    ]),
  });

  const base = ids.flatMap((id, i) => {
    const info = first[i * 3];
    const pools = first[i * 3 + 1];
    const res = first[i * 3 + 2];
    if (info.status !== 'success' || pools.status !== 'success' || res.status !== 'success') return [];
    const keys = (pools.result as readonly PoolKey[]).map((k) => ({ ...k }));
    const market = info.result as { market: Address; creator: Address; setupHash: `0x${string}`; question: string; rules: string };
    const resolution = res.result as readonly [Address, Address, bigint, bigint, number, number, bigint, Address];
    return [{ id, info: market, keys, res: resolution }];
  });

  const perMarket = 7;
  const perOutcome = 4;
  const second = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: base.flatMap(({ info, keys }) => [
      { address: info.market, abi: obMarketAbi, functionName: 'endOfTrading' } as const,
      { address: info.market, abi: obMarketAbi, functionName: 'depositCap' } as const,
      { address: info.market, abi: obMarketAbi, functionName: 'halted' } as const,
      { address: info.market, abi: obMarketAbi, functionName: 'resolved' } as const,
      { address: info.market, abi: obMarketAbi, functionName: 'winningOutcome' } as const,
      { address: info.market, abi: obMarketAbi, functionName: 'tradingOpen' } as const,
      { address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [info.market] } as const,
      ...keys.flatMap((key) => {
        const token = outcomeToken(key);
        const id = poolIdOf(key);
        return [
          { address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [id] } as const,
          { address: key.hooks, abi: obHookAbi, functionName: 'pools', args: [id] } as const,
          { address: token, abi: erc20Abi, functionName: 'name' } as const,
          { address: token, abi: erc20Abi, functionName: 'totalSupply' } as const,
        ];
      }),
    ]),
  });

  const out: BookMarket[] = [];
  let at = 0;
  for (const { id, info, keys, res } of base) {
    const r = second.slice(at, at + perMarket + keys.length * perOutcome);
    at += perMarket + keys.length * perOutcome;
    const val = <T,>(i: number, fallback: T): T => (r[i]?.status === 'success' ? (r[i].result as T) : fallback);

    let creatorFeeBps = 0;
    let protocolFeeBps = 0;
    const outcomes: BookOutcome[] = keys.map((key, i) => {
      const o = perMarket + i * perOutcome;
      const slot0 = val<readonly [bigint, number, number, number]>(o, [0n, 0, 0, 0]);
      const cfg = val<readonly [Address, boolean, number, number, Address, number, number, boolean]>(
        o + 1,
        ['0x0000000000000000000000000000000000000000', false, 0, 0, '0x0000000000000000000000000000000000000000', 0, 0, false],
      );
      if (i === 0) {
        creatorFeeBps = cfg[5];
        protocolFeeBps = cfg[6];
      }
      const usdgIs0 = key.currency0.toLowerCase() === USDG.toLowerCase();
      return {
        index: i,
        name: val<string>(o + 2, `Outcome ${i + 1}`),
        token: outcomeToken(key),
        key,
        poolId: poolIdOf(key),
        usdgIs0,
        sqrtPriceX96: slot0[0],
        tick: slot0[1],
        price: outcomePrice(slot0[0], usdgIs0),
        boundLower: cfg[2],
        boundUpper: cfg[3],
        supply: val<bigint>(o + 3, 0n),
      };
    });

    const [, , , disputeEnds, state, outcome, bond, disputer] = res;
    out.push({
      id,
      market: info.market,
      creator: info.creator,
      question: info.question,
      rules: info.rules,
      setupHash: info.setupHash,
      endOfTrading: Number(val<bigint>(0, 0n)),
      depositCap: val<bigint>(1, 0n),
      halted: val<boolean>(2, false),
      resolved: val<boolean>(3, false),
      winningOutcome: val<number>(4, 0),
      tradingOpen: val<boolean>(5, false),
      collateral: val<bigint>(6, 0n),
      creatorFeeBps,
      protocolFeeBps,
      outcomes,
      resolution: { state: STATES[state] ?? 'open', outcome, disputeEnds: Number(disputeEnds), bond, disputer },
    });
  }
  return out;
}

export function outcomeToken(key: PoolKey): Address {
  return key.currency0.toLowerCase() === USDG.toLowerCase() ? key.currency1 : key.currency0;
}

export function outcomeLabel(m: BookMarket, index: number): string {
  if (index === INVALID_OUTCOME) return 'Invalid (every outcome pays 1/N)';
  return m.outcomes[index]?.name ?? `Outcome ${index + 1}`;
}

export type MarketPhase = 'trading' | 'ended' | 'pending' | 'disputed' | 'final';

/** Where the market is: trading, past its end awaiting a result, result posted, disputed, or final. */
export function marketPhase(m: BookMarket, nowSec = Math.floor(Date.now() / 1000)): MarketPhase {
  if (m.resolution.state === 'final' || m.resolved) return 'final';
  if (m.resolution.state === 'disputed') return 'disputed';
  if (m.resolution.state === 'pending') return 'pending';
  return nowSec >= m.endOfTrading ? 'ended' : 'trading';
}
