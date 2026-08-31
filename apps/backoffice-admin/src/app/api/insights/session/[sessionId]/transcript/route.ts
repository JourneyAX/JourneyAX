/**
 * GET /api/insights/session/:sessionId/transcript?projectId=… — backoffice
 * conversation-drilldown proxy. Same shape as /api/insights, just one
 * session's real transcript instead of the aggregate figures.
 *
 * Architecture: Browser → BFF (this route) → Gateway → analytics-service → MongoDB
 */
import { NextResponse } from 'next/server';
import { readCookie, COOKIE_AT, jwtSecondsLeft } from '../../../../../../lib/bff-auth';

const DEV_BYPASS = process.env.AUTH_DEV_BYPASS === 'true';

const GATEWAY = process.env.GATEWAY_URL
  || process.env.PROJECT_SERVICE_URL  // legacy fallback
  || 'http://localhost:3010';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const token = readCookie(req, COOKIE_AT);
    if (!DEV_BYPASS && jwtSecondsLeft(token) <= 0) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { sessionId } = await params;
    const url = new URL(req.url);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    }

    const upstream = `${GATEWAY}/api/v1/analytics/session/${encodeURIComponent(sessionId)}/transcript?projectId=${encodeURIComponent(projectId)}`;

    const res = await fetch(upstream, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json().catch(() => ({ error: 'Invalid response from analytics-service' }));
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
