import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/kit/quote — price the kit on the rack.
 *
 * Styles and counts only; every monetary figure is computed by the quote engine
 * (P0-04). Nothing here does arithmetic on money, and nothing the browser sends
 * can influence a price.
 */
const AGENT_API = process.env.AGENT_SERVICE_URL || 'http://localhost:3004';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  try {
    const res = await fetch(
      `${AGENT_API}/api/v1/${encodeURIComponent(projectId)}/commerce/kit/quote`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) return NextResponse.json({ error: 'Could not price that kit.' }, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'The quote service is not responding.' }, { status: 200 });
  }
}
