import { NextRequest, NextResponse } from 'next/server';
import { OB } from '@/lib/orderbook/config';
import type { OrderJson } from '@/lib/orderbook/intents';
import { processOrder } from '@/lib/orderbook/intentsKeeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Pay from any chain, step 2: the page polls this with its order while the payment travels. It reports 1Click's
// status and the USDG waiting at the order's deposit address, and once USDG is there the relayer executes the order
// (the outcome tokens go to the user), or refunds it to the user on Robinhood Chain after the deadline. execute and
// refund are open to anyone and only touch USDG sent for this exact order. The cron (api/cron/intents) does the same
// for every open order, so closing the tab doesn't stop it (lib/orderbook/intentsKeeper.ts).
export async function POST(req: NextRequest) {
  if (!OB.forwarder) return NextResponse.json({ error: 'Order book markets are not live yet' }, { status: 503 });
  let body: { order: OrderJson; depositAddress?: string | null; depositMemo?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  try {
    return NextResponse.json(await processOrder(body.order, body.depositAddress, body.depositMemo));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
