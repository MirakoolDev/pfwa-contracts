// Limit orders, read from PFWALimitOrders' events and state: the open book for one outcome, and a trader's orders.
import { encodeAbiParameters, keccak256, type Address, type PublicClient } from 'viem';
import { OB, MULTICALL3 } from './config';
import { obLimitOrdersAbi } from './abi';
import { stepAmount, tickToOutcomePrice, type PoolKey } from './math';
import type { BookMarket, BookOutcome } from './read';

const placedEvent = obLimitOrdersAbi.find((x) => x.type === 'event' && x.name === 'Placed')!;
const CHUNK = BigInt(1_000_000);

type Client = Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'multicall'>;

function slotOf(poolId: `0x${string}`, tickLower: number, zeroForOne: boolean) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'int24' }, { type: 'bool' }], [poolId, tickLower, zeroForOne]));
}

async function placedLogs(client: Client, args: { owner?: Address; poolId?: `0x${string}` | `0x${string}`[] }): Promise<Awaited<ReturnType<typeof placedLogsOne>>> {
  // Robinhood Chain's public RPC allows a block range over 100,000 only when each indexed topic has one value, so a
  // list of pools is one query per pool.
  if (Array.isArray(args.poolId)) return (await Promise.all(args.poolId.map((poolId) => placedLogsOne(client, { ...args, poolId })))).flat();
  return placedLogsOne(client, args as { owner?: Address; poolId?: `0x${string}` });
}

async function placedLogsOne(client: Client, args: { owner?: Address; poolId?: `0x${string}` }) {
  if (!OB.limitOrders) return [];
  // No cache: right after a transaction the cached block number can still be the one before it.
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const logs = [];
  for (let from = OB.deployBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK - BigInt(1) < latest ? from + CHUNK - BigInt(1) : latest;
    logs.push(...(await client.getLogs({ address: OB.limitOrders, event: placedEvent, args, fromBlock: from, toBlock: to })));
  }
  return logs;
}

/** Which way an order on this outcome's pool trades: buying the outcome pays USDG. */
const sideOf = (o: BookOutcome, zeroForOne: boolean): 'buy' | 'sell' => (zeroForOne === o.usdgIs0 ? 'buy' : 'sell');

export type BookLevel = {
  side: 'buy' | 'sell';
  price: number;
  /** USDG for a buy, outcome tokens for a sell. */
  size: number;
  tickLower: number;
};

/** Every open limit order on one outcome, one level per price step. */
export async function loadOrderBook(client: Client, outcome: BookOutcome): Promise<BookLevel[]> {
  if (!OB.limitOrders) return [];
  const logs = await placedLogs(client, { poolId: outcome.poolId });
  const steps = new Map<string, { tickLower: number; zeroForOne: boolean }>();
  for (const l of logs) {
    const { tickLower, zeroForOne } = l.args as { tickLower: number; zeroForOne: boolean };
    steps.set(`${tickLower}:${zeroForOne}`, { tickLower, zeroForOne });
  }
  const list = [...steps.values()];
  if (list.length === 0) return [];
  const lo = OB.limitOrders;
  const epochs = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: list.map((s) => ({ address: lo, abi: obLimitOrdersAbi, functionName: 'epochOf', args: [slotOf(outcome.poolId, s.tickLower, s.zeroForOne)] }) as const),
  });
  const infos = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: epochs.map((e) => ({ address: lo, abi: obLimitOrdersAbi, functionName: 'epochInfo', args: [e] }) as const),
  });
  const levels: BookLevel[] = [];
  list.forEach((s, i) => {
    if (epochs[i] === BigInt(0)) return;
    const [filled, liquidityTotal] = infos[i];
    if (filled || liquidityTotal === BigInt(0)) return;
    levels.push({
      side: sideOf(outcome, s.zeroForOne),
      price: tickToOutcomePrice(s.tickLower + outcome.key.tickSpacing / 2, outcome.usdgIs0),
      size: stepAmount(liquidityTotal, s.tickLower, s.zeroForOne) / 1e6,
      tickLower: s.tickLower,
    });
  });
  return levels.sort((a, b) => b.price - a.price);
}

export type MyOrder = {
  epoch: bigint;
  outcome: BookOutcome;
  side: 'buy' | 'sell';
  price: number;
  tickLower: number;
  zeroForOne: boolean;
  key: PoolKey;
  /** What was put in: USDG for a buy, outcome tokens for a sell (whole units). */
  amountIn: number;
  status: 'open' | 'filled';
  /** For a filled order: what it can withdraw now, in whole units (outcome tokens for a buy, USDG for a sell). */
  proceeds: number;
};

/** A trader's limit orders in one market that still hold something: open ones, and filled ones not yet withdrawn. */
export async function loadMyOrders(client: Client, owner: Address, market: BookMarket): Promise<MyOrder[]> {
  if (!OB.limitOrders) return [];
  const byPool = new Map(market.outcomes.map((o) => [o.poolId.toLowerCase(), o]));
  const logs = await placedLogs(client, { owner, poolId: market.outcomes.map((o) => o.poolId) });
  const byEpoch = new Map<bigint, { outcome: BookOutcome; tickLower: number; zeroForOne: boolean; amountIn: bigint }>();
  for (const l of logs) {
    const a = l.args as { epoch: bigint; poolId: `0x${string}`; tickLower: number; zeroForOne: boolean; amountIn: bigint };
    const outcome = byPool.get(a.poolId.toLowerCase());
    if (!outcome) continue;
    const prev = byEpoch.get(a.epoch);
    byEpoch.set(a.epoch, { outcome, tickLower: a.tickLower, zeroForOne: a.zeroForOne, amountIn: (prev?.amountIn ?? BigInt(0)) + a.amountIn });
  }
  const epochs = [...byEpoch.keys()];
  if (epochs.length === 0) return [];
  const lo = OB.limitOrders;
  const reads = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: epochs.flatMap((e) => [
      { address: lo, abi: obLimitOrdersAbi, functionName: 'liquidityOf', args: [e, owner] } as const,
      { address: lo, abi: obLimitOrdersAbi, functionName: 'epochInfo', args: [e] } as const,
    ]),
  });
  const orders: MyOrder[] = [];
  epochs.forEach((epoch, i) => {
    const mine = reads[i * 2] as bigint;
    const [filled, liquidityTotal, token0Total, token1Total] = reads[i * 2 + 1] as readonly [boolean, bigint, bigint, bigint];
    if (mine === BigInt(0)) return;
    const o = byEpoch.get(epoch)!;
    const side = sideOf(o.outcome, o.zeroForOne);
    // A filled buy turned into outcome tokens, a filled sell into USDG: the order's output currency.
    const outIs0 = !o.zeroForOne;
    const total = outIs0 ? token0Total : token1Total;
    const proceeds = filled && liquidityTotal > BigInt(0) ? Number((total * mine) / liquidityTotal) / 1e6 : 0;
    orders.push({
      epoch,
      outcome: o.outcome,
      side,
      price: tickToOutcomePrice(o.tickLower + o.outcome.key.tickSpacing / 2, o.outcome.usdgIs0),
      tickLower: o.tickLower,
      zeroForOne: o.zeroForOne,
      key: o.outcome.key,
      amountIn: Number(o.amountIn) / 1e6,
      status: filled ? 'filled' : 'open',
      proceeds,
    });
  });
  return orders.sort((a, b) => Number(b.epoch - a.epoch));
}
