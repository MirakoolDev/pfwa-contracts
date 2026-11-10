// Prices, ticks and limit-order steps for order book pools. Outcome tokens and USDG both have 6 decimals, so a
// pool's raw price is its human price. A pool's price is currency1 per currency0: an outcome's price in USDG is that
// price when the outcome is currency0, and its inverse when USDG is currency0.
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { TICK_SPACING } from './config';

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export function poolIdOf(key: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const Q96 = 2 ** 96;
const LOG_BASE = Math.log(1.0001);

/** USDG per outcome token at this pool price. */
export function outcomePrice(sqrtPriceX96: bigint, usdgIs0: boolean): number {
  const p = (Number(sqrtPriceX96) / Q96) ** 2;
  if (!p) return 0;
  return usdgIs0 ? 1 / p : p;
}

export function tickToOutcomePrice(tick: number, usdgIs0: boolean): number {
  const p = 1.0001 ** tick;
  return usdgIs0 ? 1 / p : p;
}

export function outcomePriceToTick(price: number, usdgIs0: boolean): number {
  return Math.log(usdgIs0 ? 1 / price : price) / LOG_BASE;
}

/** The limit-order step for buying or selling an outcome at about `price`. */
export type LimitStep = {
  tickLower: number;
  /** PFWALimitOrders' direction: true sells currency0. */
  zeroForOne: boolean;
  /** The step's average price: what the order fills at, in USDG per outcome. */
  fillPrice: number;
  error?: string;
};

/**
 * A buy pays USDG and sits below the current price; a sell pays outcome tokens and sits above it. The order is one
 * tick-spacing step wide and fills once a swap moves the price all the way through it.
 */
export function limitStep(
  side: 'buy' | 'sell',
  price: number,
  pool: { usdgIs0: boolean; tick: number; boundLower: number; boundUpper: number },
): LimitStep {
  const zeroForOne = (side === 'buy') === pool.usdgIs0;
  const t = outcomePriceToTick(price, pool.usdgIs0);
  const tickLower = Math.floor(t / TICK_SPACING) * TICK_SPACING;
  const fillPrice = tickToOutcomePrice(tickLower + TICK_SPACING / 2, pool.usdgIs0);
  const step: LimitStep = { tickLower, zeroForOne, fillPrice };
  if (!Number.isFinite(t)) return { ...step, error: 'Enter a price.' };
  if (tickLower < pool.boundLower || tickLower + TICK_SPACING > pool.boundUpper) {
    return { ...step, error: 'Prices stay between 0.001 and 0.999 USDG.' };
  }
  const farSide = zeroForOne ? tickLower > pool.tick : tickLower + TICK_SPACING <= pool.tick;
  if (!farSide) {
    return {
      ...step,
      error: side === 'buy'
        ? 'A limit buy must be below the current price. To buy now, use a market order.'
        : 'A limit sell must be above the current price. To sell now, use a market order.',
    };
  }
  return step;
}

/** What a filled order turns into: outcome tokens for a buy, USDG for a sell (both as numbers of whole tokens). */
export function limitProceeds(side: 'buy' | 'sell', amountIn: number, fillPrice: number): number {
  if (!fillPrice) return 0;
  return side === 'buy' ? amountIn / fillPrice : amountIn * fillPrice;
}

/** The input amount (raw units) a step of `liquidity` holds while unfilled. */
export function stepAmount(liquidity: bigint, tickLower: number, zeroForOne: boolean): number {
  const a = 1.0001 ** (tickLower / 2);
  const b = 1.0001 ** ((tickLower + TICK_SPACING) / 2);
  const L = Number(liquidity);
  return zeroForOne ? (L * (b - a)) / (a * b) : L * (b - a);
}

export const fmtUsdg = (raw: bigint | number, digits = 2): string => {
  const n = typeof raw === 'bigint' ? Number(raw) / 1e6 : raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const fmtAmount = (raw: bigint | number, digits = 2): string => {
  const n = typeof raw === 'bigint' ? Number(raw) / 1e6 : raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

export const fmtPrice = (p: number): string => p.toFixed(p >= 0.1 ? 2 : 3);
