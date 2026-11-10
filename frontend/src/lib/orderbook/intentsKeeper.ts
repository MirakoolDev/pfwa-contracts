// Pay from any chain: the keeper, used by the page's poll (api/intents/order): an order is executed when its USDG
// lands, or refunded after its deadline. The order is its own proof: its deposit address is CREATE2 of the order, so a
// posted order that wasn't paid for moves nothing. This standalone app keeps open orders in memory; pfwa.fun keeps
// them in its database and also runs the keeper from a cron every minute, so closing the tab doesn't stop an order.
import type { Address } from 'viem';
import { OB } from './config';
import { decide, forwarderAbi, keeperClient, orderFromJson, publicClient, status as oneclickStatus, usdgAt, type Action, type OrderJson } from './intents';

/** Open orders kept at once. */
const MAX_OPEN = 500;

export type StoredOrder = { order: OrderJson; deposit: Address; depositAddress: string | null; depositMemo: string | null; createdAt: number };

const store = new Map<string, StoredOrder>();

/** Keeps an order the server just issued. */
export async function saveOpenOrder(o: Omit<StoredOrder, 'createdAt'>) {
  if (store.size >= MAX_OPEN) return;
  store.set(o.deposit.toLowerCase(), { ...o, createdAt: Date.now() });
}

export async function openOrders(): Promise<StoredOrder[]> {
  return [...store.values()];
}

export const forgetOrder = async (deposit: string) => { store.delete(deposit.toLowerCase()); };

/** Nothing more will happen to an order in these states: the cron drops it. */
export const FINISHED: string[] = ['done', 'refunded', 'failed', 'expired', 'refunded_onchain'];

// One send per deposit at a time, per server instance; and the last transaction sent for it, so a poll that lands
// while it confirms reports it instead of sending again.
const lastRun = new Map<string, number>();
const sentTx = new Map<string, `0x${string}`>();

export type Processed = { status: string | null; deposit: Address; usdgAtDeposit: string; action: Action | 'refunded_onchain'; tx?: string; reverted?: boolean; note?: string };

/** Looks at an order and, if its USDG is waiting, executes it (before the deadline) or refunds it (after). */
export async function processOrder(json: OrderJson, depositAddress?: string | null, depositMemo?: string | null): Promise<Processed> {
  const order = orderFromJson(json);
  const client = publicClient();
  const deposit = await client.readContract({ address: OB.forwarder!, abi: forwarderAbi, functionName: 'depositAddress', args: [order] });
  let status: string | null = null;
  if (depositAddress) {
    try { status = (await withTimeout(oneclickStatus(depositAddress, depositMemo), 8_000)).status; } catch { /* 1Click slow or unreachable: decide from the chain */ }
  }
  const [usdgAtDeposit, code] = await Promise.all([usdgAt(client, deposit), client.getCode({ address: deposit })]);
  const action = decide({ status, usdgAtDeposit, depositUsed: Boolean(code && code !== '0x'), now: Math.floor(Date.now() / 1000), deadline: order.deadline });
  const out: Processed = { status, deposit, usdgAtDeposit: usdgAtDeposit.toString(), action, tx: sentTx.get(deposit) };
  if (action !== 'execute' && action !== 'refund') return out;

  const last = lastRun.get(deposit) ?? 0;
  if (Date.now() - last < 20_000) return { ...out, note: sentTx.has(deposit) ? 'Sent; waiting for Robinhood Chain to confirm it' : 'Sending the transaction' };
  lastRun.set(deposit, Date.now());
  try {
    // Inside the try: a bad key must report an error and free the slot, not leave the order 'sending' forever.
    const keeper = keeperClient();
    if (!keeper) { lastRun.delete(deposit); return { ...out, note: 'No keeper key on the server; finish it from your wallet' }; }
    const { request } = await client.simulateContract({ account: keeper.account, address: OB.forwarder!, abi: forwarderAbi, functionName: action, args: [order] });
    const hash = await keeper.writeContract(request);
    sentTx.set(deposit, hash);
    console.log(`[intents] ${action} ${deposit} sent ${hash}`);
    try {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
      const ok = receipt.status === 'success';
      if (!ok) { sentTx.delete(deposit); lastRun.delete(deposit); }
      return { ...out, action: ok ? (action === 'execute' ? 'done' : 'refunded_onchain') : action, tx: hash, reverted: !ok };
    } catch {
      // Not confirmed yet: the next poll sees the order's address used (done) or tries again.
      return { ...out, tx: hash, note: 'Sent; waiting for Robinhood Chain to confirm it' };
    }
  } catch (e) {
    lastRun.delete(deposit);
    // InsufficientOutput: the price moved past the order's minimum. Try again next time until the deadline.
    const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
    console.error(`[intents] ${action} ${deposit} failed: ${msg}`);
    return { ...out, note: /InsufficientOutput/.test(msg) ? 'The price moved past your minimum; retrying until the deadline, then refunding' : `Couldn't send: ${msg.slice(0, 160)}` };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
