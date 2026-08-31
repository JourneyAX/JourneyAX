import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/cdl/review  { sessionId, kind, sku?, conceptId?, brief?, summary?,
 *                          sizes?, customer?, roster?, flatViews? }
 *
 * Coach team-order journey (Step 6) — the "Submit team order" button in
 * ConfiguratorPanel calls this directly, since the roster + four flat design
 * views only ever exist in the BROWSER's journey state (the server-side
 * agent journeyState does not track them). Proxies to the existing
 * `POST :projectId/cdl/review` (cdl.controller.ts `submitReview`) through the
 * gateway's `cdl` domain, same pattern as /api/cdl/flat-views and /analyze —
 * small JSON in/out, no binary/slow work here.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!body?.sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });
  }

  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'augusta'
  ).toLowerCase();

  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/cdl/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': projectId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response from CDL service' }));
    return NextResponse.json(j, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `review submission failed: ${e?.message || e}` }, { status: 502 });
  }
}
