// Seeding a market: mint M complete sets, then put M of each outcome plus the matching USDG into each outcome's pool
// as one position across the whole allowed range (0.001–0.999), at the pool's current price. Positions go through
// Uniswap's v4 PositionManager; they earn no swap fee (the hook takes the market's fee for the creator and PFWA).
import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address, type PublicClient } from 'viem';
import { decodePositionInfo, modifyLiquidityEvent, sqrtPriceAtTick } from './v4';
import { MULTICALL3, OB, POOL_MANAGER, POSITION_MANAGER, TICK_SPACING } from './config';
import type { BookMarket, BookOutcome } from './read';
import { outcomePriceToTick, type PoolKey } from './math';

export const positionManagerAbi = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'error MinimumAmountInsufficient(uint128 minimumAmount, uint128 amountReceived)',
  'error NotApproved(address caller)',
]);

const Q96 = BigInt(1) << BigInt(96);
const SCALE = BigInt(10) ** BigInt(18);
const DECREASE_LIQUIDITY = 0x01;
const MINT_POSITION = 0x02;
const BURN_POSITION = 0x03;
const TAKE_PAIR = 0x11;
const SETTLE_PAIR = 0x0d;
const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';

export function amountsFor(liquidity: bigint, tickLower: number, tickUpper: number, sqrtP: bigint) {
  const a = sqrtPriceAtTick(tickLower);
  const b = sqrtPriceAtTick(tickUpper);
  const s = sqrtP < a ? a : sqrtP > b ? b : sqrtP;
  const amount0 = s < b ? (liquidity * Q96 * (b - s)) / b / s : BigInt(0);
  const amount1 = s > a ? (liquidity * (s - a)) / Q96 : BigInt(0);
  return { amount0, amount1 };
}

export type SeedPosition = {
  outcome: BookOutcome;
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  usdg: bigint;
  tokens: bigint;
};

export type SeedPlan = { sets: bigint; usdgToPools: bigint; positions: SeedPosition[] };

/** The tick range for a position from `price − band` to `price + band` (USDG per token), inside the pool's bounds. */
export function bandTicks(o: BookOutcome, band: number): { tickLower: number; tickUpper: number } {
  const lo = Math.max(0.001, o.price - band);
  const hi = Math.min(0.999, o.price + band);
  const a = outcomePriceToTick(lo, o.usdgIs0);
  const b = outcomePriceToTick(hi, o.usdgIs0);
  const minTick = Math.ceil(o.boundLower / TICK_SPACING) * TICK_SPACING;
  const maxTick = Math.floor(o.boundUpper / TICK_SPACING) * TICK_SPACING;
  let tickLower = Math.max(minTick, Math.floor(Math.min(a, b) / TICK_SPACING) * TICK_SPACING);
  let tickUpper = Math.min(maxTick, Math.ceil(Math.max(a, b) / TICK_SPACING) * TICK_SPACING);
  // The pool's price must sit inside the range, so the position holds both the outcome and USDG.
  if (tickLower > o.tick) tickLower = Math.max(minTick, Math.floor(o.tick / TICK_SPACING) * TICK_SPACING - TICK_SPACING);
  if (tickUpper <= o.tick) tickUpper = Math.min(maxTick, Math.ceil(o.tick / TICK_SPACING) * TICK_SPACING + TICK_SPACING);
  return { tickLower, tickUpper };
}

/** Creator liquidity on PFWA: at least this much USDG, locked while the market trades (LiquidityLocker). */
export const MIN_CREATOR_LIQUIDITY_USDG = 100;
/** What the locker must hold for a market to be listed: seeding keeps up to 1.5% back for rounding and returns it,
 *  so 100 USDG in locks about 98.4. (6 decimals.) */
export const MIN_LOCKED_RAW = (BigInt(MIN_CREATOR_LIQUIDITY_USDG) * BigInt(1_000_000) * BigInt(97)) / BigInt(100);
/** Creator liquidity sits from the opening chance minus to plus this (in USDG per token, i.e. 20 points). */
export const CREATOR_BAND = 0.2;

/** How `usdgTotal` splits into complete sets and each pool's USDG side, at the pools' current prices. With `band`,
 *  each position covers price ± band instead of the pool's whole range (0.001–0.999). */
export function seedPlan(m: BookMarket, usdgTotal: bigint, band?: number): SeedPlan | null {
  if (usdgTotal <= BigInt(0)) return null;
  const pools = m.outcomes.map((o) => {
    const { tickLower, tickUpper } = band
      ? bandTicks(o, band)
      : { tickLower: Math.ceil(o.boundLower / TICK_SPACING) * TICK_SPACING, tickUpper: Math.floor(o.boundUpper / TICK_SPACING) * TICK_SPACING };
    const unit = amountsFor(SCALE, tickLower, tickUpper, o.sqrtPriceX96);
    const tokenPerL = o.usdgIs0 ? unit.amount1 : unit.amount0;
    const usdgPerL = o.usdgIs0 ? unit.amount0 : unit.amount1;
    return { o, tickLower, tickUpper, tokenPerL, usdgPerL };
  });
  if (pools.some((p) => p.tokenPerL === BigInt(0))) return null;
  // M sets cost M USDG, and pool i needs M × (usdg per token) more. Keep 1.5% back for rounding.
  const ratio = pools.reduce((s, p) => s + Number(p.usdgPerL) / Number(p.tokenPerL), 0);
  const sets = BigInt(Math.floor((Number(usdgTotal) * 0.985) / (1 + ratio)));
  if (sets <= BigInt(0)) return null;
  const positions = pools.map((p) => {
    // 0.1% under the sets, so rounding never needs more of an outcome than was minted.
    const liquidity = (sets * SCALE * BigInt(999)) / (p.tokenPerL * BigInt(1000));
    const { amount0, amount1 } = amountsFor(liquidity, p.tickLower, p.tickUpper, p.o.sqrtPriceX96);
    const pad = (x: bigint) => x + x / BigInt(200) + BigInt(1);
    const amount0Max = pad(amount0);
    const amount1Max = pad(amount1);
    return {
      outcome: p.o,
      key: p.o.key,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      usdg: p.o.usdgIs0 ? amount0Max : amount1Max,
      tokens: p.o.usdgIs0 ? amount1Max : amount0Max,
    };
  });
  // Never ask for more of an outcome than the sets mint.
  for (const pos of positions) {
    if (pos.tokens > sets) {
      if (pos.outcome.usdgIs0) pos.amount1Max = sets;
      else pos.amount0Max = sets;
      pos.tokens = sets;
    }
  }
  const usdgToPools = positions.reduce((s, p) => s + p.usdg, BigInt(0));
  return { sets, usdgToPools, positions };
}

/** modifyLiquidities' unlock data: open every position, settling each pool's two currencies after its mint. */
export function seedUnlockData(plan: SeedPlan, owner: Address): `0x${string}` {
  const actions: number[] = [];
  const params: `0x${string}`[] = [];
  for (const p of plan.positions) {
    actions.push(MINT_POSITION, SETTLE_PAIR);
    params.push(
      encodeAbiParameters(
        parseAbiParameters(`${POOL_KEY} poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData`),
        [p.key, p.tickLower, p.tickUpper, p.liquidity, p.amount0Max, p.amount1Max, owner, '0x'],
      ),
      encodeAbiParameters(parseAbiParameters('address currency0, address currency1'), [p.key.currency0, p.key.currency1]),
    );
  }
  const actionsHex = `0x${actions.map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  return encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [actionsHex, params]);
}

// ── Taking liquidity out ─────────────────────────────────────────────────────

export type LpPosition = {
  tokenId: bigint;
  outcome: BookOutcome;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** What the position holds at the pool's current price. */
  usdg: bigint;
  tokens: bigint;
};

const CHUNK = BigInt(1_000_000);
type Client = Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'multicall'>;

/**
 * `owner`'s open positions in this market's pools. PositionManager positions show up in the PoolManager's
 * ModifyLiquidity events with the token id as the salt; the ones `owner` still holds with liquidity left are theirs.
 */
export async function loadPositions(client: Client, m: BookMarket, owner: Address): Promise<LpPosition[]> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const found = new Map<bigint, BookOutcome>();
  const byPool = new Map(m.outcomes.map((o) => [o.poolId.toLowerCase(), o]));
  for (let from = OB.deployBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK - BigInt(1) < latest ? from + CHUNK - BigInt(1) : latest;
    // One query per pool: the public RPC allows over 100,000 blocks only with one value per indexed topic.
    const logs = (await Promise.all(m.outcomes.map((o) => client.getLogs({
      address: POOL_MANAGER,
      event: modifyLiquidityEvent,
      args: { id: o.poolId, sender: POSITION_MANAGER },
      fromBlock: from,
      toBlock: to,
    })))).flat();
    for (const l of logs) {
      const o = l.args.id && byPool.get(l.args.id.toLowerCase());
      if (o && l.args.salt) found.set(BigInt(l.args.salt), o);
    }
  }
  const ids = [...found.keys()];
  if (ids.length === 0) return [];
  const r = (await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'ownerOf', args: [id] } as const,
      { address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [id] } as const,
      { address: POSITION_MANAGER, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [id] } as const,
    ]),
  })) as { status: string; result?: unknown }[];
  const out: LpPosition[] = [];
  ids.forEach((tokenId, i) => {
    const [own, liq, info] = r.slice(i * 3, i * 3 + 3);
    // A burned position's ownerOf reverts.
    if (own.status !== 'success' || liq.status !== 'success' || info.status !== 'success') return;
    if ((own.result as Address).toLowerCase() !== owner.toLowerCase()) return;
    const liquidity = liq.result as bigint;
    if (liquidity === BigInt(0)) return;
    const outcome = found.get(tokenId)!;
    const { tickLower, tickUpper } = decodePositionInfo((info.result as readonly [unknown, bigint])[1]);
    const { amount0, amount1 } = amountsFor(liquidity, tickLower, tickUpper, outcome.sqrtPriceX96);
    out.push({
      tokenId,
      outcome,
      tickLower,
      tickUpper,
      liquidity,
      usdg: outcome.usdgIs0 ? amount0 : amount1,
      tokens: outcome.usdgIs0 ? amount1 : amount0,
    });
  });
  return out.sort((a, b) => a.outcome.index - b.outcome.index || Number(a.tokenId - b.tokenId));
}

/**
 * modifyLiquidities' unlock data for taking `pct`% out of each position (100 burns the NFT), each pool's two
 * currencies sent to `to`. Each minimum is the expected amount less `slackBps`, so a trade landing first can't
 * make it pay out much less than shown.
 */
export function withdrawUnlockData(positions: LpPosition[], pct: number, to: Address, slackBps = 200): `0x${string}` {
  const actions: number[] = [];
  const params: `0x${string}`[] = [];
  const keep = (x: bigint) => (x * BigInt(10_000 - slackBps)) / BigInt(10_000);
  for (const p of positions) {
    const liquidity = pct >= 100 ? p.liquidity : (p.liquidity * BigInt(pct)) / BigInt(100);
    const { amount0, amount1 } = amountsFor(liquidity, p.tickLower, p.tickUpper, p.outcome.sqrtPriceX96);
    if (pct >= 100) {
      actions.push(BURN_POSITION);
      params.push(
        encodeAbiParameters(parseAbiParameters('uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData'), [p.tokenId, keep(amount0), keep(amount1), '0x']),
      );
    } else {
      actions.push(DECREASE_LIQUIDITY);
      params.push(
        encodeAbiParameters(parseAbiParameters('uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData'), [
          p.tokenId, liquidity, keep(amount0), keep(amount1), '0x',
        ]),
      );
    }
    actions.push(TAKE_PAIR);
    params.push(encodeAbiParameters(parseAbiParameters('address currency0, address currency1, address recipient'), [p.outcome.key.currency0, p.outcome.key.currency1, to]));
  }
  const actionsHex = `0x${actions.map((x) => x.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  return encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [actionsHex, params]);
}
