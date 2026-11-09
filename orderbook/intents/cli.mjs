#!/usr/bin/env node
// Buy a PFWA order book outcome from any chain, or withdraw USDG to any chain, through NEAR Intents.
// Run `node cli.mjs help` for the commands. Configuration comes from the environment (see .env.example).
import { randomUUID } from 'node:crypto';
import { createOneClick, fromBaseUnits, toBaseUnits, USDG_ON_HOOD } from './src/oneclick.mjs';
import { clients, V4_QUOTER } from './src/chain.mjs';
import { keeperPass, planBuy, planWithdraw } from './src/flows.mjs';
import { openStore } from './src/store.mjs';

const HELP = `pfwa-intents: buy PFWA order book outcomes from any chain through NEAR Intents

  tokens [--chain sol]                      Assets 1Click can route (assetId, decimals), optionally one chain
  buy --from <assetId> --amount <n>         Pay <n> of an asset on its own chain for outcome tokens on Robinhood Chain
      --refund-to <address on that chain>     where 1Click refunds if the swap can't happen
      --user <0x address>                     receives the outcome tokens on Robinhood Chain
      --market <id> --outcome <index>
      [--slippage <bps>] [--dry] [--local]    --dry prices it without opening a deposit address; --local
                                              also fixes the order (for forks) but opens no real deposit address
  submit --deposit <address> --tx <hash>    Tell 1Click about your deposit transaction (speeds it up)
  status --deposit <address>                1Click's status for a deposit address
  orders                                    The orders the keeper is watching
  keeper [--watch <seconds>]                Execute delivered orders (needs KEEPER_PRIVATE_KEY), refund expired ones
  withdraw --to <assetId> --amount <usdg>   Send USDG from Robinhood Chain to another chain
      --recipient <address on that chain> --refund-to <0x address> [--dry]

Environment: OB_FACTORY, OB_FORWARDER (default: the order book contracts on Robinhood Chain mainnet), ROBINHOOD_RPC_URL,
ONECLICK_API_KEY (optional partner key), KEEPER_PRIVATE_KEY (keeper only), INTENTS_STORE (default orders.json).
`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function need(opts, ...keys) {
  const missing = keys.filter((k) => opts[k] === undefined || opts[k] === true);
  if (missing.length) throw new Error(`Missing ${missing.map((k) => `--${k}`).join(', ')}. Run \`node cli.mjs help\`.`);
}

const show = (v) => console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

async function main() {
  const opts = args(process.argv.slice(2));
  const cmd = opts._[0] ?? 'help';
  const oneclick = createOneClick();
  // Defaults: the contracts live on Robinhood Chain mainnet since Nov 9, 2026.
  const config = { factory: process.env.OB_FACTORY || '0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7', forwarder: process.env.OB_FORWARDER || '0xD95560b028F61eB5a28379bC5588DE315f2CcA38', quoter: process.env.V4_QUOTER || V4_QUOTER };

  if (cmd === 'help') return console.log(HELP);

  if (cmd === 'tokens') {
    const tokens = await oneclick.tokens();
    const rows = tokens.filter((t) => !opts.chain || t.blockchain === opts.chain);
    return show(rows.map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, priceUsd: t.price })));
  }

  if (cmd === 'buy') {
    need(opts, 'from', 'amount', 'refund-to', 'user', 'market', 'outcome');
    const tokens = await oneclick.tokens();
    const asset = tokens.find((t) => t.assetId === opts.from);
    if (!asset) throw new Error(`1Click doesn't route ${opts.from}. See \`node cli.mjs tokens\`.`);
    const { publicClient } = clients();
    const plan = await planBuy({
      oneclick,
      publicClient,
      config,
      user: opts.user,
      marketId: opts.market,
      outcome: opts.outcome,
      originAsset: opts.from,
      amount: toBaseUnits(opts.amount, asset.decimals),
      refundTo: opts['refund-to'],
      slippageBps: Number(opts.slippage ?? 100),
      dry: Boolean(opts.dry),
      local: Boolean(opts.local),
    });
    const summary = {
      pay: `${opts.amount} ${asset.symbol} on ${asset.blockchain}`,
      usdgOnRobinhood: `~${fromBaseUnits(plan.usdgExpected, 6)} (at least ${fromBaseUnits(plan.usdgMin, 6)})`,
      ...(plan.outcomeExpected ? { outcomeTokens: `~${fromBaseUnits(plan.outcomeExpected, 6)} (at least ${fromBaseUnits(plan.minOut, 6)})` } : {}),
      secondsToDeliver: plan.secondsToDeliver,
    };
    if (!plan.depositAddress && !plan.local) return show({ ...summary, dry: true, ...(plan.note ? { note: plan.note } : {}) });
    const store = openStore();
    const id = randomUUID();
    store.add({ id, depositAddress: plan.depositAddress, depositMemo: plan.depositMemo, forwarderDeposit: plan.forwarderDeposit, order: plan.order, originAsset: opts.from, amountIn: plan.amountIn });
    if (plan.local) {
      return show({ ...summary, local: true, robinhoodDepositAddress: plan.forwarderDeposit, orderId: id, next: 'Local mode: no real deposit address was opened. Deliver USDG to robinhoodDepositAddress yourself (on your fork), then run the keeper.' });
    }
    return show({
      ...summary,
      next: `Send exactly ${opts.amount} ${asset.symbol} on ${asset.blockchain} to ${plan.depositAddress}${plan.depositMemo ? ` with memo ${plan.depositMemo}` : ''} before ${new Date(plan.quoteDeadline * 1000).toISOString()}. Then run the keeper.`,
      depositAddress: plan.depositAddress,
      robinhoodDepositAddress: plan.forwarderDeposit,
      orderId: id,
    });
  }

  if (cmd === 'submit') {
    need(opts, 'deposit', 'tx');
    return show(await oneclick.submitDeposit({ txHash: opts.tx, depositAddress: opts.deposit, memo: opts.memo }));
  }

  if (cmd === 'status') {
    need(opts, 'deposit');
    const s = await oneclick.status(opts.deposit, opts.memo);
    return show({ status: s.status, updatedAt: s.updatedAt, swapDetails: s.swapDetails });
  }

  if (cmd === 'orders') return show(openStore().all());

  if (cmd === 'keeper') {
    if (!config.forwarder) throw new Error('Set OB_FORWARDER to the deployed ForwarderFactory.');
    const { publicClient, walletClient } = clients();
    const store = openStore();
    const pass = async () => {
      for (const line of await keeperPass({ oneclick, publicClient, walletClient, config, store })) console.log(line);
    };
    await pass();
    if (opts.watch) {
      const every = Number(opts.watch === true ? 15 : opts.watch) * 1000;
      setInterval(() => pass().catch((e) => console.error(e.message)), every);
    }
    return;
  }

  if (cmd === 'withdraw') {
    need(opts, 'to', 'amount', 'recipient', 'refund-to');
    const plan = await planWithdraw({
      oneclick,
      destinationAsset: opts.to,
      amount: toBaseUnits(opts.amount, 6),
      recipient: opts.recipient,
      refundTo: opts['refund-to'],
      slippageBps: Number(opts.slippage ?? 100),
      dry: Boolean(opts.dry),
    });
    return show({
      pay: `${opts.amount} USDG on Robinhood Chain (${USDG_ON_HOOD})`,
      receive: `~${plan.amountOutFormatted} of ${opts.to}`,
      secondsToDeliver: plan.secondsToDeliver,
      ...(plan.depositAddress ? { next: `Send ${opts.amount} USDG on Robinhood Chain to ${plan.depositAddress}.`, depositAddress: plan.depositAddress } : { dry: true }),
    });
  }

  throw new Error(`Unknown command ${cmd}. Run \`node cli.mjs help\`.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
