// Pay from any chain (server side): NEAR Intents' 1Click API turns the user's coin on its own chain into USDG on
// Robinhood Chain, delivered to a deposit address the IntentForwarder derives from the order; then anyone (our
// relayer) calls execute(order) and the outcome tokens go to the user. Ported from MirakoolDev/pfwa-contracts
// orderbook/intents/src. The partner key (ONECLICK_API_KEY) stays on the server; without it every quote carries
// an extra 0.25%.
//
// Stateless keeper: the order itself is the record. Its deposit address is CREATE2 of the order's hash, so a forged
// order points at an empty address and nothing happens; execute and refund only move USDG that was sent for it.
import { createPublicClient, createWalletClient, fallback, http, parseAbi, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PUBLIC_RPC_URL, robinhoodChain, SERVER_RPC_URL } from '@/lib/config';
import { OB, USDG, V4_QUOTER } from './config';

export const ONECLICK_URL = 'https://1click.chaindefuser.com';
/** USDG on Robinhood Chain, as NEAR Intents names it. */
export const USDG_ON_HOOD = 'nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near';
export const FINAL_STATUSES = ['SUCCESS', 'REFUNDED', 'FAILED'];
/** The 1Click deposit address takes funds for an hour; the order can be executed for three. */
export const QUOTE_TTL = 60 * 60;
export const ORDER_TTL = 3 * 60 * 60;
/** Local chain mode (INTENTS_LOCAL=1): the order is fixed on the local chain, but no real 1Click deposit address
 *  is opened, since real funds sent to an address that only exists locally would be lost. */
export const INTENTS_LOCAL = process.env.INTENTS_LOCAL === '1';

export type Order = { user: Address; marketId: bigint; outcome: number; minOut: bigint; deadline: bigint; nonce: bigint };
export type OrderJson = { user: string; marketId: string; outcome: number; minOut: string; deadline: string; nonce: string };

const ORDER = 'address user; uint256 marketId; uint8 outcome; uint256 minOut; uint64 deadline; uint256 nonce';
const POOL_KEY = 'address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks';
export const forwarderAbi = parseAbi([
  `struct Order { ${ORDER}; }`,
  'function depositAddress(Order o) view returns (address)',
  'function execute(Order o) returns (uint256 tokensOut)',
  'function refund(Order o)',
  'error Expired()',
  'error NothingDeposited()',
  'error NotYet()',
  'error InsufficientOutput(uint256 out, uint256 minOut)',
]);
const factoryAbi = parseAbi([`struct PoolKey { ${POOL_KEY}; }`, 'function getPools(uint256 marketId) view returns (PoolKey[])']);
const quoterAbi = parseAbi([
  `struct PoolKey { ${POOL_KEY}; }`,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export class OneClickError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`1Click ${status}: ${(body as { message?: string })?.message ?? JSON.stringify(body)}`);
  }
}

async function oneclick<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = process.env.ONECLICK_API_KEY;
  const res = await fetch(`${ONECLICK_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) throw new OneClickError(res.status, data);
  return data as T;
}

export type OneClickToken = { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number; contractAddress?: string | null };
export const tokens = () => oneclick<OneClickToken[]>('GET', '/v0/tokens');

type Quote = { quote: { amountIn: string; amountOut: string; minAmountOut: string; amountOutFormatted?: string; timeEstimate?: number; depositAddress?: string; depositMemo?: string } };

function quoteRequest(p: { originAsset: string; amount: bigint; refundTo: string; recipient: string; deadline: number; slippageBps: number; dry: boolean }) {
  return {
    dry: p.dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: p.slippageBps,
    originAsset: p.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDG_ON_HOOD,
    amount: p.amount.toString(),
    // A price check has no refund address yet: it names the user's NEAR Intents account (their EVM address), which
    // 1Click accepts for any origin chain. A real order refunds to the user's address on the chain they pay from.
    refundTo: p.dry ? p.recipient.toLowerCase() : p.refundTo,
    refundType: p.dry ? 'INTENTS' : 'ORIGIN_CHAIN',
    recipient: p.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(p.deadline * 1000).toISOString(),
  };
}

/** Tells 1Click about a deposit the page sent from the user's wallet, so it doesn't wait to notice it. */
export const submitDeposit = (txHash: string, depositAddress: string, memo?: string | null) =>
  oneclick<unknown>('POST', '/v0/deposit/submit', { txHash, depositAddress, ...(memo ? { memo } : {}) });

export const status = (depositAddress: string, memo?: string | null) =>
  oneclick<{ status: string }>('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ''}`);

export function publicClient(): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(SERVER_RPC_URL) }) as PublicClient;
}

/** The relayer that executes and refunds orders (INTENTS_KEEPER_PRIVATE_KEY). Optional: without it the buyer finishes
 * the order from their own wallet (execute and refund are open to anyone). */
export function keeperClient() {
  // Stored with or without 0x (the relayer key is kept without it); normalized the way every other relayer user does.
  const raw = (process.env.INTENTS_KEEPER_PRIVATE_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  // Short timeouts and the chain's public RPC as a backup, so a slow or failing RPC can't hold a send past the
  // function's time limit (which would leave the order waiting with nothing sent and no error).
  const rpc = (url: string) => http(url, { timeout: 8_000, retryCount: 1 });
  const transport = SERVER_RPC_URL === PUBLIC_RPC_URL ? rpc(PUBLIC_RPC_URL) : fallback([rpc(SERVER_RPC_URL), rpc(PUBLIC_RPC_URL)]);
  return createWalletClient({ chain: robinhoodChain, transport, account: privateKeyToAccount(pk) });
}

export const orderToJson = (o: Order): OrderJson => ({ user: o.user, marketId: o.marketId.toString(), outcome: o.outcome, minOut: o.minOut.toString(), deadline: o.deadline.toString(), nonce: o.nonce.toString() });
export function orderFromJson(j: OrderJson): Order {
  if (!/^0x[0-9a-fA-F]{40}$/.test(j.user)) throw new Error('Bad user address');
  const outcome = Number(j.outcome);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new Error('Bad outcome');
  return { user: j.user as Address, marketId: BigInt(j.marketId), outcome, minOut: BigInt(j.minOut), deadline: BigInt(j.deadline), nonce: BigInt(j.nonce) };
}

function randomNonce(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
}

/** Outcome tokens `usdgIn` buys right now on the outcome's pool, after the market's fee. */
async function quoteOutcome(client: PublicClient, marketId: bigint, outcome: number, usdgIn: bigint): Promise<bigint> {
  const pools = await client.readContract({ address: OB.factory!, abi: factoryAbi, functionName: 'getPools', args: [marketId] });
  const key = pools[outcome];
  if (!key) throw new Error(`Market ${marketId} has no outcome ${outcome}`);
  const zeroForOne = key.currency0.toLowerCase() === USDG.toLowerCase();
  try {
    const { result } = await client.simulateContract({
      address: V4_QUOTER,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: usdgIn, hookData: '0x' }],
    });
    return result[0];
  } catch {
    // The quoter reverts when the buy would push the price past the pool's limit: more than this market can fill.
    throw new Error('This market can’t fill that much in one buy. Try a smaller amount.');
  }
}

export type BuyPlan = {
  usdgExpected: string;
  usdgMin: string;
  secondsToDeliver: number | null;
  outcomeExpected?: string;
  minOut?: string;
  order?: OrderJson;
  forwarderDeposit?: Address;
  depositAddress?: string | null;
  depositMemo?: string | null;
  quoteDeadline?: number;
  local?: boolean;
};

/**
 * Prices (dry) or opens a buy: `amount` of `originAsset` on its own chain becomes USDG on Robinhood Chain, then the
 * outcome tokens. The order's minOut is the outcome tokens the guaranteed USDG buys now, less `slippageBps`.
 */
export async function planBuy(p: { user: Address; marketId: bigint; outcome: number; originAsset: string; amount: bigint; refundTo: string; slippageBps: number; dry: boolean }): Promise<BuyPlan> {
  const client = publicClient();
  const t = Math.floor(Date.now() / 1000);
  const quoteDeadline = t + QUOTE_TTL;
  const priced = await oneclick<Quote>('POST', '/v0/quote', quoteRequest({ ...p, recipient: p.user, deadline: quoteDeadline, dry: true }));
  const usdgMin = BigInt(priced.quote.minAmountOut);
  const plan: BuyPlan = { usdgExpected: priced.quote.amountOut, usdgMin: usdgMin.toString(), secondsToDeliver: priced.quote.timeEstimate ?? null };
  if (!OB.factory) return plan;
  const outcomeExpected = await quoteOutcome(client, p.marketId, p.outcome, usdgMin);
  const minOut = (outcomeExpected * BigInt(10_000 - p.slippageBps)) / BigInt(10_000);
  Object.assign(plan, { outcomeExpected: outcomeExpected.toString(), minOut: minOut.toString() });
  if (p.dry || !OB.forwarder) return plan;

  const order: Order = { user: p.user, marketId: p.marketId, outcome: p.outcome, minOut, deadline: BigInt(t + ORDER_TTL), nonce: randomNonce() };
  const forwarderDeposit = await client.readContract({ address: OB.forwarder, abi: forwarderAbi, functionName: 'depositAddress', args: [order] });
  if (INTENTS_LOCAL) return { ...plan, order: orderToJson(order), forwarderDeposit, depositAddress: null, depositMemo: null, quoteDeadline, local: true };
  const live = await oneclick<Quote>('POST', '/v0/quote', quoteRequest({ ...p, recipient: forwarderDeposit, deadline: quoteDeadline, dry: false }));
  return {
    ...plan,
    order: orderToJson(order),
    forwarderDeposit,
    depositAddress: live.quote.depositAddress ?? null,
    depositMemo: live.quote.depositMemo ?? null,
    quoteDeadline,
  };
}

export type Action = 'wait' | 'execute' | 'refund' | 'done' | 'refunded' | 'failed' | 'expired';

/** What to do with an order. USDG at its deposit address is the source of truth; without it, follow 1Click. */
export function decide(s: { status: string | null; usdgAtDeposit: bigint; depositUsed: boolean; now: number; deadline: bigint }): Action {
  if (s.usdgAtDeposit > BigInt(0)) return s.now <= Number(s.deadline) ? 'execute' : 'refund';
  if (s.depositUsed) return 'done';
  if (s.status === 'REFUNDED') return 'refunded';
  if (s.status === 'FAILED') return 'failed';
  if (s.now > Number(s.deadline) + QUOTE_TTL && !FINAL_STATUSES.includes(s.status ?? '')) return 'expired';
  return 'wait';
}

export async function usdgAt(client: PublicClient, who: Address) {
  return client.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}
