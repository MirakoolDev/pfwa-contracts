// An order book market's price history: every swap in its outcomes' Uniswap v4 pools (PoolManager's Swap event,
// which carries the pool's price after the swap), turned into one point per swap with every outcome's latest price.
import { decodeFunctionData, parseAbi, type Address, type PublicClient } from 'viem';
import { forwarderAbi } from './intents';
import { OB, POOL_MANAGER } from './config';
import { poolManagerSwapEvent } from './abi';
import { outcomePrice } from './math';
import type { BookMarket } from './read';

type Client = Pick<PublicClient, 'getLogs' | 'getBlockNumber' | 'getBlock' | 'getTransaction'>;

const CHUNK = BigInt(1_000_000);
/** Most block timestamps fetched per load; other swaps get a time from their block number between known ones. */
const MAX_BLOCK_READS = 60;

const initializeEvent = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])[0];

/** One chart point (the market opening, then one per swap): unix seconds, and each outcome's price in percent (keyed by outcome name). */
export type PricePoint = { t: number; swap: number } & Record<string, number>;

/** One swap in an outcome's pool: who traded (the transaction's sender), which way, how much, at what price. */
export type Trade = { t: number; outcome: number; isBuy: boolean; usdg: bigint; tokens: bigint; price: number; tx: `0x${string}`; trader: Address | null; via?: string };

/** Traders are read for the most recent swaps only (one transaction lookup each). */
const MAX_TRADER_READS = 50;

export async function loadPriceHistory(client: Client, m: BookMarket): Promise<{ points: PricePoint[]; trades: Trade[] }> {
  const byPool = new Map(m.outcomes.map((o) => [o.poolId.toLowerCase(), o]));
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const logs = [];
  for (let from = OB.deployBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK - BigInt(1) < latest ? from + CHUNK - BigInt(1) : latest;
    // One query per pool: the public RPC allows over 100,000 blocks only with one value per indexed topic.
    for (const o of m.outcomes) {
      logs.push(...(await client.getLogs({ address: POOL_MANAGER, event: poolManagerSwapEvent, args: { id: o.poolId }, fromBlock: from, toBlock: to })));
      // The pool's opening price, so the chart starts where the market opened.
      logs.push(...(await client.getLogs({ address: POOL_MANAGER, event: initializeEvent, args: { id: o.poolId }, fromBlock: from, toBlock: to })));
    }
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1));

  // Timestamps: read a spread of the swap blocks plus the latest, and place the rest between them by block number.
  const blocks = [...new Set(logs.map((l) => l.blockNumber!))];
  const step = Math.max(1, Math.ceil(blocks.length / MAX_BLOCK_READS));
  const sample = blocks.filter((_, i) => i % step === 0 || i === blocks.length - 1);
  const known = new Map<bigint, number>();
  await Promise.all([...sample, latest].map(async (n) => { known.set(n, Number((await client.getBlock({ blockNumber: n })).timestamp)); }));
  const anchors = [...known.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const timeOf = (n: bigint) => {
    const hit = known.get(n);
    if (hit !== undefined) return hit;
    const j = anchors.findIndex(([b]) => b > n);
    if (j <= 0) return anchors[0][1];
    const [b0, t0] = anchors[j - 1], [b1, t1] = anchors[j];
    return t0 + ((t1 - t0) * Number(n - b0)) / Number(b1 - b0);
  };

  // Every outcome starts at its pool's opening price (its first event is the pool's Initialize), or at its current
  // price if that wasn't found.
  const price: Record<string, number> = {};
  for (const o of m.outcomes) {
    const first = logs.find((l) => l.args.id!.toLowerCase() === o.poolId.toLowerCase());
    price[o.name] = Math.round((first ? outcomePrice(first.args.sqrtPriceX96!, o.usdgIs0) : o.price) * 1000) / 10;
  }
  const points: PricePoint[] = [];
  for (const l of logs) {
    const o = byPool.get(l.args.id!.toLowerCase());
    if (!o) continue;
    price[o.name] = Math.round(outcomePrice(l.args.sqrtPriceX96!, o.usdgIs0) * 1000) / 10;
    points.push({ t: Math.round(timeOf(l.blockNumber!)), swap: l.eventName === 'Swap' ? 1 : 0, ...price } as PricePoint);
  }
  // Ends on the prices right now.
  for (const o of m.outcomes) price[o.name] = Math.round(o.price * 1000) / 10;
  points.push({ t: known.get(latest) ?? Math.floor(Date.now() / 1000), swap: 0, ...price } as PricePoint);
  if (points.length === 1) points.unshift({ ...points[0], t: points[0].t - 60 });

  // Trades, newest first. A Swap's amounts are the swapper's: negative is what it paid in.
  const trades: Trade[] = [];
  for (const l of logs) {
    if (l.eventName !== 'Swap') continue;
    const o = byPool.get(l.args.id!.toLowerCase());
    if (!o) continue;
    const a0 = l.args.amount0!, a1 = l.args.amount1!;
    const usdgD = o.usdgIs0 ? a0 : a1, tokD = o.usdgIs0 ? a1 : a0;
    const usdg = usdgD < BigInt(0) ? -usdgD : usdgD, tokens = tokD < BigInt(0) ? -tokD : tokD;
    if (tokens === BigInt(0)) continue;
    trades.push({ t: Math.round(timeOf(l.blockNumber!)), outcome: o.index, isBuy: usdgD < BigInt(0), usdg, tokens, price: Number(usdg) / Number(tokens), tx: l.transactionHash!, trader: null });
  }
  trades.reverse();
  // The trader is the transaction's sender, except a Pay from any chain order: whoever sent it (usually our relayer)
  // bought for the wallet named in the order, so that wallet is the trader.
  const senders = new Map<string, { trader: Address | null; via?: string }>();
  await Promise.all([...new Set(trades.slice(0, MAX_TRADER_READS).map((t) => t.tx))].map(async (h) => {
    try {
      const tx = await client.getTransaction({ hash: h });
      let who: { trader: Address | null; via?: string } = { trader: tx.from };
      if (OB.forwarder && tx.to?.toLowerCase() === OB.forwarder.toLowerCase()) {
        try {
          const call = decodeFunctionData({ abi: forwarderAbi, data: tx.input });
          if (call.functionName === 'execute') who = { trader: (call.args[0] as { user: Address }).user, via: 'NEAR Intents' };
        } catch { /* not an execute call */ }
      }
      senders.set(h, who);
    } catch { senders.set(h, { trader: null }); }
  }));
  for (const t of trades) Object.assign(t, senders.get(t.tx) ?? { trader: null });
  return { points, trades };
}

const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0];

export type Holder = { holder: Address; outcome: number; balance: bigint };

/** Who holds each outcome token, from its Transfer events. Contracts that only hold tokens in passing are skipped. */
export async function loadHolders(client: Client, m: BookMarket, skip: string[]): Promise<Holder[]> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const ignore = new Set(['0x0000000000000000000000000000000000000000', POOL_MANAGER.toLowerCase(), m.market.toLowerCase(), ...skip.map((a) => a.toLowerCase())]);
  const out: Holder[] = [];
  for (const o of m.outcomes) {
    const bal = new Map<string, bigint>();
    for (let from = OB.deployBlock; from <= latest; from += CHUNK) {
      const to = from + CHUNK - BigInt(1) < latest ? from + CHUNK - BigInt(1) : latest;
      for (const l of await client.getLogs({ address: o.token, event: transferEvent, fromBlock: from, toBlock: to })) {
        const f = l.args.from!.toLowerCase(), t = l.args.to!.toLowerCase(), v = l.args.value!;
        bal.set(f, (bal.get(f) ?? BigInt(0)) - v);
        bal.set(t, (bal.get(t) ?? BigInt(0)) + v);
      }
    }
    for (const [h, b] of bal) if (b > BigInt(0) && !ignore.has(h)) out.push({ holder: h as Address, outcome: o.index, balance: b });
  }
  return out.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
}
