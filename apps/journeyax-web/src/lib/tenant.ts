/**
 * Multi-storefront tenant resolution (server-side).
 *
 * ONE storefront deployment serves every project. Each request resolves its
 * tenant in priority order:
 *   1. ?project=<id> query param        — demos / local testing / deep links
 *   2. X-Tenant-ID header               — upstream proxy / embed integrations
 *   3. Host header → project domain     — production: caroma.journeyax.com etc.
 *      (resolved via project-service /resolve/domain, cached 60s per host)
 *   4. env PROJECT_ID                   — single-tenant fallback (default caroma)
 *
 * Never trusts the value blindly downstream: the gateway/agent still validate
 * the projectId on their side per the isolation contract.
 */
const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';
const FALLBACK = process.env.PROJECT_ID || process.env.NEXT_PUBLIC_PROJECT_ID || 'caroma';

const domainCache = new Map<string, { projectId: string | null; expiresAt: number }>();

async function resolveHost(host: string): Promise<string | null> {
  const key = host.toLowerCase();
  const hit = domainCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.projectId;
  let projectId: string | null = null;
  try {
    const res = await fetch(
      `${PROJECT_API}/api/v1/projects/resolve/domain/${encodeURIComponent(key)}`,
      { cache: 'no-store' },
    );
    if (res.ok) projectId = (await res.json()).projectId ?? null;
  } catch { /* project-service down → fallback */ }
  domainCache.set(key, { projectId, expiresAt: Date.now() + 60_000 });
  return projectId;
}

/** Sanitise a candidate projectId (path-safe slug only). */
function clean(id: string | null | undefined): string | null {
  const v = (id || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-_]{0,63}$/.test(v) ? v : null;
}

export async function resolveTenant(req: Request): Promise<string> {
  const url = new URL(req.url);
  const fromQuery = clean(url.searchParams.get('project'));
  if (fromQuery) return fromQuery;

  const fromHeader = clean(req.headers.get('x-tenant-id'));
  if (fromHeader) return fromHeader;

  const host = req.headers.get('host');
  if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) {
    const fromHost = await resolveHost(host);
    if (fromHost) return fromHost;
  }
  return FALLBACK;
}
