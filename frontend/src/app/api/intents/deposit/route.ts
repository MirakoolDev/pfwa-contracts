import { NextRequest, NextResponse } from 'next/server';
import { submitDeposit } from '@/lib/orderbook/intents';

export const dynamic = 'force-dynamic';

// Pay from any chain: after the page sends the deposit from the user's wallet (EVM or Solana), it reports the
// transaction here and we pass it to 1Click (/v0/deposit/submit) so the swap starts without waiting to spot it.
// Optional: 1Click finds the deposit on its own anyway.
export async function POST(req: NextRequest) {
  let body: { txHash?: string; depositAddress?: string; depositMemo?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  if (!body.txHash || !body.depositAddress) return NextResponse.json({ error: 'txHash and depositAddress are required' }, { status: 400 });
  try {
    await submitDeposit(body.txHash, body.depositAddress, body.depositMemo);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
