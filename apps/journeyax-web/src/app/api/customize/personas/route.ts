/**
 * GET  /api/customize/personas   the persona library of the project (personas, use cases, teams) and the tools people said each scenario needs
 * POST /api/customize/personas   { useCaseId, tools, expectedRevision }   saves the tools of one scenario
 *
 * Reads and writes the project service's persona library with the signed-in person's own token; the project service checks the permission
 * to change the configuration. The library is reference material for the people who configure the assistant: saving the tools of a scenario
 * changes nothing the assistant says or may do, so it needs no publishing. `expectedRevision` makes a save on top of a change you have not
 * seen come back as 409 instead of overwriting it.
 */
import { NextResponse } from 'next/server';
import { resolveTenant } from '@/lib/tenant';
import { unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { readLibrary, readScenarioOp, saveScenarioTools } from '@/lib/customize/personaApi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';

async function deps(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return null;
  const tenantId = await resolveTenant(req);
  return { base: `${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}`, headers: { ...auth, 'X-Tenant-ID': tenantId } };
}

export async function GET(req: Request) {
  const d = await deps(req);
  if (!d) return unauthorized();
  const result = await readLibrary(d);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  const d = await deps(req);
  if (!d) return unauthorized();
  const op = readScenarioOp(await req.json().catch(() => ({})));
  if ('error' in op) return NextResponse.json({ error: op.error }, { status: 400 });
  const result = await saveScenarioTools(d, op);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
