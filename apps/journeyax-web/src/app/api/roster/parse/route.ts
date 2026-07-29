import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/roster/parse — read a pasted player list.
 *
 * Deliberately a READ: it stores nothing and orders nothing. The response
 * carries the column mapping that was inferred and why, so the dealer confirms
 * it before a garment is committed.
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
      `${AGENT_API}/api/v1/${encodeURIComponent(projectId)}/commerce/roster/parse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!res.ok) return NextResponse.json({ error: 'Could not read that list.' }, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'The roster service is not responding.' }, { status: 200 });
  }
}
