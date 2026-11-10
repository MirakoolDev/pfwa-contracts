// The best way to spend a buy: part straight into the outcome's pool, part through full sets (mint a set of every
// outcome for 1 USDG, sell the other outcomes into their pools, keep the bought one). Each outcome trades in its own
// pool, so the two legs touch different pools and can be priced independently with the V4 Quoter. OBSetRouter
// (pfwa-contracts orderbook/src/OBSetRouter.sol) then does both in one transaction. Buying through sets also moves the
// other outcomes' prices down, which keeps the outcomes adding up to about 100%.
import { parseAbi, type PublicClient } from 'viem';
import { v4QuoterAbi } from './abi';
import { V4_QUOTER } from './config';
import type { BookMarket } from './read';

export const obSetRouterAbi = parseAbi([
  'function buy(uint256 marketId, uint8 outcome, uint256 sets, uint256 usdgDirect, uint256 maxUsdgIn, uint256 minOut, address to) returns (uint256 tokensOut, uint256 usdgPaid)',
  'error NotEnoughUsdg(uint256 have, uint256 need)',
  'error InsufficientOutput(uint256 out, uint256 minOut)',
]);

export type SplitPlan = {
  /** Full sets minted (in outcome token units, 6 decimals). 0 means a plain buy. */
  sets: bigint;
  /** USDG straight into the outcome's pool. */
  usdgDirect: bigint;
  /** Outcome tokens expected in total. */
  tokensOut: bigint;
  /** What a plain buy of the whole amount gets, to compare. */
  plainOut: bigint;
};

const ZERO = BigInt(0);
/** Kept back from the direct leg when sets are used, so the other outcomes' sales coming in a little lower than quoted
 * don't make the router revert. It isn't spent: the router returns unused USDG. */
const SALES_MARGIN_BPS = BigInt(150);

async function quote(client: PublicClient, m: BookMarket, i: number, buy: boolean, amount: bigint): Promise<bigint | null> {
  if (amount <= ZERO) return ZERO;
  const o = m.outcomes[i];
  try {
    const { result } = await client.simulateContract({
      address: V4_QUOTER,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: o.key, zeroForOne: buy ? o.usdgIs0 : !o.usdgIs0, exactAmount: amount, hookData: '0x' }],
    });
    return result[0];
  } catch {
    return null; // past the pool's price bound, or no liquidity that far
  }
}

/** Tokens a split gets for `budget` USDG with `sets` full sets, or null if the sets cost more than the budget. */
async function evaluate(client: PublicClient, m: BookMarket, outcome: number, budget: bigint, sets: bigint) {
  let proceeds = ZERO;
  if (sets > ZERO) {
    const sales = await Promise.all(m.outcomes.filter((o) => o.index !== outcome).map((o) => quote(client, m, o.index, false, sets)));
    if (sales.some((s) => s === null)) return null;
    proceeds = sales.reduce<bigint>((a, s) => a + (s as bigint), ZERO);
  }
  const setCost = sets - proceeds;
  if (setCost > budget) return null;
  const left = budget - (setCost > ZERO ? setCost : ZERO);
  const usdgDirect = sets > ZERO ? (left * (BigInt(10_000) - SALES_MARGIN_BPS)) / BigInt(10_000) : left;
  const direct = await quote(client, m, outcome, true, usdgDirect);
  if (direct === null) return null;
  return { sets, usdgDirect, tokensOut: sets + direct };
}

/** Searches the number of sets that gets the most tokens for `budget` USDG. */
export async function bestSplit(client: PublicClient, m: BookMarket, outcome: number, budget: bigint): Promise<SplitPlan | null> {
  // A plain buy can run past the pool's price bound (no quote); sets may still work then.
  const plain = await evaluate(client, m, outcome, budget, ZERO);
  // Sets cost about the outcome's price each, so the most worth trying is a little over budget / price.
  const price = Math.max(0.01, m.outcomes[outcome].price);
  const top = (BigInt(Math.round((Number(budget) / price) * 1000)) * BigInt(13)) / BigInt(10_000);
  let best = plain ?? { sets: ZERO, usdgDirect: ZERO, tokensOut: ZERO };
  let lo = ZERO, hi = top;
  for (let round = 0; round < 3 && hi > lo; round++) {
    const steps = 8;
    const pts = Array.from({ length: steps + 1 }, (_, k) => lo + ((hi - lo) * BigInt(k)) / BigInt(steps)).filter((s) => s > ZERO);
    const res = await Promise.all(pts.map((s) => evaluate(client, m, outcome, budget, s)));
    let bestK = -1;
    res.forEach((r, k) => { if (r && r.tokensOut > best.tokensOut) { best = r; bestK = k; } });
    if (bestK < 0) break;
    const width = (hi - lo) / BigInt(steps);
    const center = pts[bestK];
    lo = center > width ? center - width : ZERO;
    hi = center + width;
  }
  if (best.tokensOut === ZERO) return null;
  return { ...best, plainOut: plain?.tokensOut ?? ZERO };
}
