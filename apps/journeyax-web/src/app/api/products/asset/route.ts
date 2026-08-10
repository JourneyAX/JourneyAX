import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/products/asset?project=…&url=…
 *
 * Same-origin proxy for garment render assets.
 *
 * The 3D preview needs two things the browser cannot fetch itself: the Scene7
 * texture atlas (the imaging host answers 403 to any cross-origin request) and
 * the per-style mesh (served with no CORS headers at all). Both are readable
 * server-side, so we fetch and re-serve them from our own origin. Without this
 * the viewer silently fails on a tainted texture.
 *
 * This is deliberately NOT a general proxy. The target host must appear in the
 * project's own renderer config; anything else is refused. An open proxy here
 * would let a visitor use the storefront to reach internal addresses.
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

/** Hosts this project is allowed to load render assets from. */
async function allowedHosts(projectId: string): Promise<Set<string>> {
  const hosts = new Set<string>();
  try {
    const res = await fetch(
      `${GATEWAY_URL}/api/v1/${encodeURIComponent(projectId)}/products/renderer-config`,
      { headers: { 'X-Tenant-ID': projectId }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return hosts;
    const cfg: any = await res.json();
    for (const v of [cfg?.textureBase, cfg?.modelBase, cfg?.envMap]) {
      if (!v) continue;
      try { hosts.add(new URL(String(v)).host.toLowerCase()); } catch { /* ignore */ }
    }
  } catch { /* fall through to an empty allowlist */ }
  return hosts;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw) return NextResponse.json({ error: 'url is required' }, { status: 400 });

  let target: URL;
  try { target = new URL(raw); } catch {
    return NextResponse.json({ error: 'url is not valid' }, { status: 400 });
  }
  if (target.protocol !== 'https:') {
    return NextResponse.json({ error: 'only https targets are allowed' }, { status: 400 });
  }

  // Project comes from request context, never from the client body — a visitor
  // must not be able to borrow another tenant's allowlist.
  const projectId = (
    req.headers.get('x-tenant-id') ||
    req.nextUrl.searchParams.get('project') ||
    process.env.DEFAULT_PROJECT_ID ||
    'caroma'
  ).toLowerCase();

  const allowed = await allowedHosts(projectId);
  if (!allowed.has(target.host.toLowerCase())) {
    return NextResponse.json(
      { error: 'host is not a configured render asset source for this project' },
      { status: 403 },
    );
  }

  try {
    const upstream = await fetch(target.toString(), { signal: AbortSignal.timeout(30000) });
    if (!upstream.ok) {
      return NextResponse.json({ error: 'upstream refused' }, { status: 502 });
    }
    const body = await upstream.arrayBuffer();

    // A missing Scene7 template answers 200 with a tiny body rather than a 404.
    // Passing that through would surface as an invisible texture instead of a
    // clear failure, so name it here.
    if (body.byteLength < 1024) {
      return NextResponse.json({ error: 'upstream returned an empty asset' }, { status: 502 });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'upstream timed out' }, { status: 504 });
  }
}
