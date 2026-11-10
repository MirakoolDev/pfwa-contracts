import { NextRequest, NextResponse } from 'next/server';
import { PFWA_API } from '@/lib/pfwaApi';

export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['football', 'defillama', 'rwa', 'historical-peak']);

// Live oracle readings (a match's score, a protocol's metric, a coin's peak since the market opened), from pfwa.fun's
// public API: the same data its resolver reads.
export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path.length !== 1 || !ALLOWED.has(path[0])) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const res = await fetch(`${PFWA_API}/api/oracle/${path[0]}${req.nextUrl.search}`, { cache: 'no-store' });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  } catch {
    return NextResponse.json({ error: 'Could not reach pfwa.fun' }, { status: 502 });
  }
}
