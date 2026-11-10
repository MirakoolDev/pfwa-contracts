import { NextRequest, NextResponse } from 'next/server';
import { PFWA_API } from '@/lib/pfwaApi';

export const dynamic = 'force-dynamic';

// A market's oracle setup (the coin, match or metric behind it, its target and deadline) is kept in pfwa.fun's
// database when the market is created. This standalone app reads it from pfwa.fun's public API.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  try {
    const res = await fetch(`${PFWA_API}/api/market/${id}/oracle`, { cache: 'no-store' });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  } catch {
    return NextResponse.json({ error: 'Could not reach pfwa.fun' }, { status: 502 });
  }
}
