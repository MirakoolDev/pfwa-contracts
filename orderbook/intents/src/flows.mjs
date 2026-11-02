// The two cross-chain flows and the keeper.
//
// Buy from any chain:
//   1. A dry 1Click quote prices the origin asset in USDG on Robinhood Chain.
//   2. The V4 Quoter prices that USDG in outcome tokens; minus slippage, that's the order's minOut.
//   3. The order (user, market, outcome, minOut, deadline, nonce) fixes a deposit address on Robinhood Chain
//      (ForwarderFactory.depositAddress, CREATE2).
//   4. A real 1Click quote delivers USDG to that address and gives the user a deposit address on their chain.
//   5. Once the USDG lands, the keeper calls ForwarderFactory.execute(order): the outcome tokens go to the user.
//      If the price moved past minOut the keeper keeps trying until the deadline, then refunds the USDG to the
//      user on Robinhood Chain (the user can refund themselves any time).
// Withdraw to any chain: a 1Click quote from USDG on Robinhood Chain to the asset the user wants; the user sends
// USDG to the deposit address it gives.
import { FINAL_STATUSES, buyQuoteRequest, withdrawQuoteRequest } from './oneclick.mjs';
import { applySlippage, depositAddressOf, forwarderAbi, makeOrder, quoteOutcome, randomNonce, usdgBalance } from './chain.mjs';

export const QUOTE_TTL = 60 * 60; // the 1Click deposit address takes funds for an hour
export const ORDER_TTL = 3 * 60 * 60; // the keeper may execute for three hours

const now = () => Math.floor(Date.now() / 1000);

/** Prices and, unless `dry`, opens a cross-chain buy. Returns everything the user and the keeper need. */
/// `local`: fix the order and its Robinhood deposit address but open no real 1Click deposit address (for a fork,
/// where the Robinhood address exists only locally: real funds sent to such a quote would be lost).
export async function planBuy({ oneclick, publicClient, config, user, marketId, outcome, originAsset, amount, refundTo, slippageBps = 100, dry = false, local = false }) {
  const t = now();
  const quoteDeadline = t + QUOTE_TTL;
  const priced = await oneclick.quote(buyQuoteRequest({ originAsset, amount, refundTo, recipient: user, deadline: quoteDeadline, slippageBps, dry: true }));
  const usdgMin = BigInt(priced.quote.minAmountOut);
  const result = {
    originAsset,
    amountIn: String(amount),
    usdgExpected: priced.quote.amountOut,
    usdgMin: String(usdgMin),
    secondsToDeliver: priced.quote.timeEstimate,
  };
  if (!config.factory) return { ...result, note: 'Set OB_FACTORY to price the outcome, and OB_FORWARDER to open the order.' };

  const outcomeExpected = await quoteOutcome(publicClient, { factory: config.factory, marketId, outcome, usdgIn: usdgMin, quoter: config.quoter });
  const minOut = applySlippage(outcomeExpected, slippageBps);
  Object.assign(result, { outcomeExpected: String(outcomeExpected), minOut: String(minOut) });
  if (dry || !config.forwarder) return result;

  const order = makeOrder({ user, marketId, outcome, minOut, deadline: t + ORDER_TTL, nonce: randomNonce() });
  const forwarderDeposit = await depositAddressOf(publicClient, config.forwarder, order);
  if (local) return { ...result, order, forwarderDeposit, depositAddress: null, depositMemo: null, quoteDeadline, local: true };
  const live = await oneclick.quote(buyQuoteRequest({ originAsset, amount, refundTo, recipient: forwarderDeposit, deadline: quoteDeadline, slippageBps, dry: false }));
  return {
    ...result,
    order,
    forwarderDeposit,
    depositAddress: live.quote.depositAddress,
    depositMemo: live.quote.depositMemo ?? null,
    quoteDeadline,
  };
}

/** Opens (or with `dry`, prices) a withdrawal of `amount` USDG units from Robinhood Chain to another chain. */
export async function planWithdraw({ oneclick, destinationAsset, amount, recipient, refundTo, slippageBps = 100, dry = false }) {
  const res = await oneclick.quote(withdrawQuoteRequest({ destinationAsset, amount, recipient, refundTo, deadline: now() + QUOTE_TTL, slippageBps, dry }));
  return {
    usdgIn: String(amount),
    destinationAsset,
    amountOut: res.quote.amountOut,
    amountOutFormatted: res.quote.amountOutFormatted,
    secondsToDeliver: res.quote.timeEstimate,
    depositAddress: res.quote.depositAddress ?? null,
    depositMemo: res.quote.depositMemo ?? null,
  };
}

/**
 * What the keeper should do with one order. USDG sitting at the order's deposit address is the source of truth:
 * once it's there, buy before the deadline and refund after it; without it, follow 1Click's status.
 */
export function decide({ status, usdgAtDeposit, depositUsed = false, now: t, deadline }) {
  if (usdgAtDeposit > 0n) return t <= Number(deadline) ? 'execute' : 'refund';
  if (status === 'REFUNDED') return 'refunded';
  if (status === 'FAILED') return 'failed';
  // Delivered and already spent: execute or refund deployed the deposit clone. Without the clone the USDG just
  // isn't visible yet (an RPC behind 1Click), so wait.
  if (status === 'SUCCESS') return depositUsed ? 'done' : 'wait';
  if (t > Number(deadline) + QUOTE_TTL && !FINAL_STATUSES.includes(status)) return 'expired';
  return 'wait';
}

/** One keeper pass over the stored orders. Returns a line per order that changed. */
export async function keeperPass({ oneclick, publicClient, walletClient, config, store, log = console.log }) {
  const events = [];
  for (const rec of store.open()) {
    let status = rec.status;
    if (rec.depositAddress) {
      try {
        status = (await oneclick.status(rec.depositAddress, rec.depositMemo ?? undefined)).status;
      } catch (e) {
        log(`status ${rec.depositAddress}: ${e.message}`);
      }
    }
    const usdgAtDeposit = await usdgBalance(publicClient, rec.forwarderDeposit);
    const code = await publicClient.getCode({ address: rec.forwarderDeposit });
    const action = decide({ status, usdgAtDeposit, depositUsed: Boolean(code && code !== '0x'), now: now(), deadline: rec.order.deadline });
    if (action === 'wait') {
      if (status !== rec.status) store.update(rec.id, { status });
      continue;
    }
    if (action === 'execute' || action === 'refund') {
      if (!walletClient) {
        events.push(`${rec.id}: ready to ${action}, but no KEEPER_PRIVATE_KEY is set`);
        continue;
      }
      try {
        const { request } = await publicClient.simulateContract({
          account: walletClient.account,
          address: config.forwarder,
          abi: forwarderAbi,
          functionName: action,
          args: [rec.order],
        });
        const hash = await walletClient.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const done = receipt.status === 'success';
        store.update(rec.id, { status, state: done ? (action === 'execute' ? 'executed' : 'refunded_onchain') : rec.state, tx: hash });
        events.push(`${rec.id}: ${action} ${done ? 'done' : 'reverted'} ${hash}`);
      } catch (e) {
        // InsufficientOutput: the price moved past minOut. Try again next pass until the deadline, then refund.
        store.update(rec.id, { status, lastError: e.shortMessage ?? e.message });
        events.push(`${rec.id}: ${action} not possible now (${e.shortMessage ?? e.message})`);
      }
      continue;
    }
    store.update(rec.id, { status, state: action });
    events.push(`${rec.id}: ${action}`);
  }
  return events;
}
