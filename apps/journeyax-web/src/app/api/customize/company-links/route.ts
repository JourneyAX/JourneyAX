/**
 * GET    /api/customize/company-links   the logins linked to a company, for the back office
 * PUT    /api/customize/company-links   { email, companyId, companyName, role }   links a login to a company (or changes the person's role)
 * DELETE /api/customize/company-links   { email, companyId }                      removes one link
 *
 * Reads and writes the project service's company links with the signed-in person's own token; the project service checks the permission to
 * change the configuration. A link is how the assistant knows, for a signed-in customer, whose deliveries, balance and prices to read: the
 * team checks who the person is before linking. Saving one changes no wording and needs no publishing.
 */
import { NextResponse } from 'next/server';
import { resolveTenant } from '@/lib/tenant';
import { unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { listLinks, readLinkOp, readUnlinkOp, removeLink, saveLink } from '@/lib/customize/companyLinks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';

async function deps(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return null;
  const tenantId = await resolveTenant(req);
  return { base: `${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}`, headers: { ...auth, 'X-Tenant-ID': tenantId } };
}

const reply = (result: { status: number; body: Record<string, unknown> }) => NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(req: Request) {
  const d = await deps(req);
  return d ? reply(await listLinks(d)) : unauthorized();
}

export async function PUT(req: Request) {
  const d = await deps(req);
  if (!d) return unauthorized();
  const op = readLinkOp(await req.json().catch(() => ({})));
  if ('error' in op) return NextResponse.json({ error: op.error }, { status: 400 });
  return reply(await saveLink(d, op));
}

export async function DELETE(req: Request) {
  const d = await deps(req);
  if (!d) return unauthorized();
  const op = readUnlinkOp(await req.json().catch(() => ({})));
  if ('error' in op) return NextResponse.json({ error: op.error }, { status: 400 });
  return reply(await removeLink(d, op));
}
