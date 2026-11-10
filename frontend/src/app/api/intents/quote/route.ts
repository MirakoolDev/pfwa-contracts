import { NextRequest, NextResponse } from 'next/server';
import { isAddress, type Address } from 'viem';
import { OB, OB_ENABLED } from '@/lib/orderbook/config';
import { OneClickError, planBuy } from '@/lib/orderbook/intents';
import { saveOpenOrder } from '@/lib/orderbook/intentsKeeper';

export const dynamic = 'force-dynamic';

// Pay from any chain, step 1. Body: { user, marketId, outcome, originAsset, amount (base units of the origin
// asset), refundTo (an address on the origin chain), slippageBps?, dry? }.
//   dry: a price only (USDG it delivers, outcome tokens that buys).
//   otherwise: the order, its deposit address on Robinhood Chain, and the 1Click deposit address on the user's chain.
export async function POST(req: NextRequest) {
  if (!OB_ENABLED || !OB.forwarder) return NextResponse.json({ error: 'Order book markets are not live yet' }, { status: 503 });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  const user = String(b.user ?? '');
  const originAsset = String(b.originAsset ?? '');
  const refundTo = String(b.refundTo ?? '');
  const outcome = Number(b.outcome);
  const slippageBps = Math.min(500, Math.max(10, Number(b.slippageBps ?? 100)));
  let marketId: bigint, amount: bigint;
  try { marketId = BigInt(String(b.marketId)); amount = BigInt(String(b.amount)); } catch { return NextResponse.json({ error: 'Bad market or amount' }, { status: 400 }); }
  if (!isAddress(user)) return NextResponse.json({ error: 'Connect a wallet on Robinhood Chain: the tokens go there' }, { status: 400 });
  if (!originAsset || amount <= BigInt(0) || !Number.isInteger(outcome) || outcome < 0 || outcome > 9) return NextResponse.json({ error: 'Pick a coin, an amount and an outcome' }, { status: 400 });
  if (!b.dry && refundTo.length < 20) return NextResponse.json({ error: 'Enter your address on the chain you pay from, for refunds' }, { status: 400 });
  try {
    const plan = await planBuy({ user: user as Address, marketId, outcome, originAsset, amount, refundTo: refundTo || user, slippageBps, dry: Boolean(b.dry) });
    // A real order: keep it so the cron (api/cron/intents) finishes it even if the buyer closes the page.
    if (plan.order && plan.forwarderDeposit) {
      await saveOpenOrder({ order: plan.order, deposit: plan.forwarderDeposit, depositAddress: plan.depositAddress ?? null, depositMemo: plan.depositMemo ?? null })
        .catch((e) => console.error('Could not keep the open order for the cron', e));
    }
    return NextResponse.json(plan);
  } catch (e) {
    const status = e instanceof OneClickError && e.status < 500 ? 400 : 502;
    const msg = e instanceof Error ? e.message.replace(/^1Click \d+: /, '') : 'Quote failed';
    return NextResponse.json({ error: msg }, { status });
  }
}
