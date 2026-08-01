/**
 * BFF service proxy (P0-02 R4). The single same-origin contract the audit asks
 * for: the browser calls `/api/bff/api/v1/<domain>/…` (so the HttpOnly auth
 * cookie is sent automatically), and this route attaches the cookie's access
 * token as a Bearer header when forwarding to the real service. The token never
 * touches the browser's JS, and the downstream service still authenticates it
 * independently (project-service PermissionGuard).
 *
 * Only an allow-listed set of domains is proxied — this is not an open relay.
 */
import { NextResponse } from 'next/server';
import { invalidateProject } from '@journeyax/cache';
import { readCookie, COOKIE_AT, jwtSecondsLeft } from '../../../../lib/bff-auth';

const DEV_BYPASS = process.env.AUTH_DEV_BYPASS === 'true';

/**
 * Allow-listed domains proxied through this BFF.
 * Every domain points to the API gateway — the gateway owns all routing to
 * private backend services. This means ZERO direct service URLs in Vercel env
 * vars; only GATEWAY_URL needs to be set.
 */
const GATEWAY = process.env.GATEWAY_URL
  || process.env.PROJECT_SERVICE_URL  // legacy — remove once GATEWAY_URL is set
  || process.env.NEXT_PUBLIC_PROJECT_API
  || 'http://localhost:8080';

const DOWNSTREAM: Record<string, string> = {
  projects:      GATEWAY,
  organizations: GATEWAY,
  analytics:     GATEWAY,  // insights, funnel, sessions — all via gateway → analytics-service
  products:      GATEWAY,
  auth:          GATEWAY,
};

async function forward(req: Request, path: string[]): Promise<Response> {
  // Expected shape: ['api','v1','<domain>', ...rest]
  const domain = path[2];
  const base = domain ? DOWNSTREAM[domain] : undefined;
  if (!base) return NextResponse.json({ error: 'Unknown service.' }, { status: 404 });

  const token = readCookie(req, COOKIE_AT);
  // Auth boundary: require a live session cookie (middleware already refreshed a
  // near-expiry one). The downstream service still verifies the token itself.
  if (!DEV_BYPASS && jwtSecondsLeft(token) <= 0) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }
  const search = new URL(req.url).search;
  const targetUrl = `${base}/${path.join('/')}${search}`;

  const headers: Record<string, string> = { 'Content-Type': req.headers.get('content-type') || 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.text();

  try {
    const res = await fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    /* Anything that WRITES to a project drops that project's cached reads, so a
     * saved edit or a publish is never followed by a screen still showing the
     * figures from before it. Reads pass through untouched. */
    if (method !== 'GET' && method !== 'HEAD' && res.ok && domain === 'projects' && path[3]) {
      await invalidateProject(path[3]);
    }
    return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } });
  } catch (e: any) {
    return NextResponse.json({ error: `Upstream ${domain} unreachable: ${e.message}` }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function POST(req: Request, ctx: Ctx)   { return forward(req, (await ctx.params).path); }
export async function PATCH(req: Request, ctx: Ctx)  { return forward(req, (await ctx.params).path); }
export async function PUT(req: Request, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function DELETE(req: Request, ctx: Ctx) { return forward(req, (await ctx.params).path); }
