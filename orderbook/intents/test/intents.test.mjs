import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USDG_ON_HOOD, buyQuoteRequest, createOneClick, fromBaseUnits, toBaseUnits, withdrawQuoteRequest } from '../src/oneclick.mjs';
import { USDG, applySlippage, makeOrder } from '../src/chain.mjs';
import { ORDER_TTL, decide, keeperPass, planBuy, planWithdraw } from '../src/flows.mjs';
import { openStore } from '../src/store.mjs';

const USER = '0x00000000000000000000000000000000000000a1';
const FORWARDER = '0x00000000000000000000000000000000000000f0';
const FACTORY = '0x00000000000000000000000000000000000000fa';
const DEPOSIT = '0x00000000000000000000000000000000000000d0';
const OUTCOME = '0x00000000000000000000000000000000000000c1';

test('amounts convert to and from base units exactly', () => {
  assert.equal(toBaseUnits('1.5', 6), 1_500_000n);
  assert.equal(toBaseUnits('0.1', 9), 100_000_000n);
  assert.equal(toBaseUnits('7', 6), 7_000_000n);
  assert.throws(() => toBaseUnits('0.0000001', 6));
  assert.throws(() => toBaseUnits('-1', 6));
  assert.equal(fromBaseUnits(9_046_643n, 6), '9.046643');
  assert.equal(fromBaseUnits(10_000_000n, 6), '10');
});

test('a buy quote delivers USDG on Robinhood Chain to the recipient and refunds on the origin chain', () => {
  const r = buyQuoteRequest({ originAsset: 'nep141:sol.omft.near', amount: 100n, refundTo: 'SoLaddr', recipient: DEPOSIT, deadline: 1_800_000_000, slippageBps: 50 });
  assert.equal(r.destinationAsset, USDG_ON_HOOD);
  assert.equal(r.recipient, DEPOSIT);
  assert.equal(r.recipientType, 'DESTINATION_CHAIN');
  assert.equal(r.refundTo, 'SoLaddr');
  assert.equal(r.refundType, 'ORIGIN_CHAIN');
  assert.equal(r.depositType, 'ORIGIN_CHAIN');
  assert.equal(r.swapType, 'EXACT_INPUT');
  assert.equal(r.amount, '100');
  assert.equal(r.slippageTolerance, 50);
  assert.equal(r.deadline, new Date(1_800_000_000_000).toISOString());
  assert.equal(r.dry, false);
  const w = withdrawQuoteRequest({ destinationAsset: 'nep141:sol.omft.near', amount: 5n, recipient: 'SoLaddr', refundTo: USER, deadline: 1_800_000_000 });
  assert.equal(w.originAsset, USDG_ON_HOOD);
  assert.equal(w.refundTo, USER);
});

test('the 1Click client sends the partner key only when there is one, and surfaces errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: url.endsWith('/v0/tokens'), status: 400, text: async () => (url.endsWith('/v0/tokens') ? '[]' : '{"message":"refundTo is not valid"}') };
  };
  const keyed = createOneClick({ apiKey: 'k', fetchImpl });
  await keyed.tokens();
  assert.equal(calls[0].init.headers['x-api-key'], 'k');
  const open = createOneClick({ apiKey: '', fetchImpl });
  await assert.rejects(open.quote({}), /refundTo is not valid/);
  assert.equal(calls[1].init.headers['x-api-key'], undefined);
});

/** 1Click and the chain, stood in for: records the quotes asked for and answers like the live services. */
function fakes({ outcomeOut = 15_000_000n } = {}) {
  const quotes = [];
  const oneclick = {
    quote: async (req) => {
      quotes.push(req);
      return { quote: { amountOut: '9138024', minAmountOut: '9046643', timeEstimate: 19, ...(req.dry ? {} : { depositAddress: 'So1DepositAddr' }) } };
    },
  };
  const publicClient = {
    readContract: async ({ functionName }) => {
      if (functionName === 'getPools') return [{ currency0: USDG, currency1: OUTCOME, fee: 0, tickSpacing: 10, hooks: FORWARDER }];
      if (functionName === 'depositAddress') return DEPOSIT;
      throw new Error(functionName);
    },
    simulateContract: async () => ({ result: [outcomeOut, 0n] }),
  };
  return { oneclick, publicClient, quotes };
}

test('planning a buy prices it, fixes minOut, and points 1Click at the order\'s Robinhood deposit address', async () => {
  const { oneclick, publicClient, quotes } = fakes();
  const plan = await planBuy({
    oneclick, publicClient, config: { factory: FACTORY, forwarder: FORWARDER },
    user: USER, marketId: 200000, outcome: 0, originAsset: 'nep141:sol.omft.near', amount: 100_000_000n, refundTo: 'SoLaddr', slippageBps: 100,
  });
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].dry, true);
  assert.equal(quotes[1].dry, false);
  assert.equal(quotes[1].recipient, DEPOSIT, 'USDG lands at the order\'s deposit address');
  assert.equal(plan.minOut, String(applySlippage(15_000_000n, 100)));
  assert.equal(plan.order.minOut, 14_850_000n);
  assert.equal(plan.order.user, USER);
  assert.equal(plan.depositAddress, 'So1DepositAddr');
  assert.ok(Number(plan.order.deadline) - Math.floor(Date.now() / 1000) <= ORDER_TTL);
});

test('a dry buy opens nothing', async () => {
  const { oneclick, publicClient, quotes } = fakes();
  const plan = await planBuy({ oneclick, publicClient, config: { factory: FACTORY, forwarder: FORWARDER }, user: USER, marketId: 1, outcome: 0, originAsset: 'a', amount: 1n, refundTo: 'r', dry: true });
  assert.equal(quotes.length, 1);
  assert.equal(plan.depositAddress, undefined);
  assert.equal(plan.outcomeExpected, '15000000');
});

test('local mode fixes the order but opens no real 1Click deposit address', async () => {
  const { oneclick, publicClient, quotes } = fakes();
  const plan = await planBuy({ oneclick, publicClient, config: { factory: FACTORY, forwarder: FORWARDER }, user: USER, marketId: 1, outcome: 0, originAsset: 'a', amount: 1n, refundTo: 'r', local: true });
  assert.equal(quotes.length, 1, 'only the dry price');
  assert.equal(plan.depositAddress, null);
  assert.equal(plan.forwarderDeposit, DEPOSIT);
  assert.equal(plan.local, true);
});

test('a withdrawal quote pays USDG on Robinhood Chain', async () => {
  const { oneclick, quotes } = fakes();
  const plan = await planWithdraw({ oneclick, destinationAsset: 'nep141:sol.omft.near', amount: 5_000_000n, recipient: 'SoLaddr', refundTo: USER });
  assert.equal(quotes[0].originAsset, USDG_ON_HOOD);
  assert.equal(plan.depositAddress, 'So1DepositAddr');
});

test('the keeper buys once USDG lands, refunds after the deadline, and follows 1Click otherwise', () => {
  const t = 1_000;
  assert.equal(decide({ status: 'PROCESSING', usdgAtDeposit: 5n, now: t, deadline: 2_000 }), 'execute', 'USDG there: buy');
  assert.equal(decide({ status: 'SUCCESS', usdgAtDeposit: 5n, now: 3_000, deadline: 2_000 }), 'refund', 'past the deadline: refund');
  assert.equal(decide({ status: 'PENDING_DEPOSIT', usdgAtDeposit: 0n, now: t, deadline: 2_000 }), 'wait');
  assert.equal(decide({ status: 'SUCCESS', usdgAtDeposit: 0n, now: t, deadline: 2_000 }), 'wait', 'delivered but not visible yet');
  assert.equal(decide({ status: 'SUCCESS', usdgAtDeposit: 0n, depositUsed: true, now: t, deadline: 2_000 }), 'done');
  assert.equal(decide({ status: 'REFUNDED', usdgAtDeposit: 0n, now: t, deadline: 2_000 }), 'refunded');
  assert.equal(decide({ status: 'FAILED', usdgAtDeposit: 0n, now: t, deadline: 2_000 }), 'failed');
  assert.equal(decide({ status: 'PENDING_DEPOSIT', usdgAtDeposit: 0n, now: 2_000 + 3_601, deadline: 2_000 }), 'expired');
});

test('a keeper pass executes a delivered order and records the transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfwa-intents-'));
  const store = openStore(path.join(dir, 'orders.json'));
  const order = makeOrder({ user: USER, marketId: 200000, outcome: 0, minOut: 1, deadline: Math.floor(Date.now() / 1000) + 600, nonce: 7 });
  store.add({ id: 'o1', depositAddress: 'So1DepositAddr', forwarderDeposit: DEPOSIT, order });
  const sent = [];
  const publicClient = {
    readContract: async () => 9_000_000n, // USDG at the deposit address
    getCode: async () => '0x',
    simulateContract: async ({ functionName, args }) => ({ request: { functionName, args } }),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  const walletClient = { account: { address: USER }, writeContract: async (req) => { sent.push(req); return '0xhash'; } };
  const oneclick = { status: async () => ({ status: 'SUCCESS' }) };
  const lines = await keeperPass({ oneclick, publicClient, walletClient, config: { forwarder: FORWARDER }, store, log: () => {} });
  assert.equal(sent[0].functionName, 'execute');
  assert.equal(sent[0].args[0].nonce, 7n);
  assert.match(lines[0], /execute done 0xhash/);
  assert.equal(store.all()[0].state, 'executed');
  assert.equal(store.open().length, 0);
});
