import { NextResponse } from 'next/server';
import { tokens, type OneClickToken } from '@/lib/orderbook/intents';

export const dynamic = 'force-dynamic';

// The coins NEAR Intents (1Click) can turn into USDG on Robinhood Chain, for the "pay from any chain" picker.
// Robinhood Chain's own assets are left out: on Robinhood Chain you trade directly.
let cache: { at: number; list: OneClickToken[] } | null = null;
const TTL = 10 * 60 * 1000;

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > TTL) {
      const all = await tokens();
      const list = all
        .filter((t) => t.blockchain !== 'hood' && t.assetId && t.symbol && Number.isInteger(t.decimals))
        // contractAddress (none for a chain's own coin) lets the page send the deposit from a connected wallet.
        .map(({ assetId, symbol, blockchain, decimals, price, contractAddress }) => ({ assetId, symbol, blockchain, decimals, price, contractAddress: contractAddress ?? null }))
        .sort((a, b) => a.blockchain.localeCompare(b.blockchain) || a.symbol.localeCompare(b.symbol));
      cache = { at: Date.now(), list };
    }
    return NextResponse.json({ tokens: cache.list }, { headers: { 'cache-control': 'public, max-age=300' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'NEAR Intents is unreachable' }, { status: 502 });
  }
}
