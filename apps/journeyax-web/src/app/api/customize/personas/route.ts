/**
 * GET  /api/customize/personas   the persona library of the project (personas, use cases, teams) and the tools people said each scenario needs
 * POST /api/customize/personas   { useCaseId, tools, expectedRevision }    saves the tools of one scenario
 *                                 { useCaseId, prompt, expectedRevision }   saves the question to try one scenario with
 *
 * Reads and writes the project service's persona library with the signed-in person's own token; the project service checks the permission
 * to change the configuration. The library is reference material for the people who configure the assistant: saving the tools of a scenario
 * changes nothing the assistant says or may do, so it needs no publishing. `expectedRevision` makes a save on top of a change you have not
 * seen come back as 409 instead of overwriting it.
 */
import { NextResponse } from 'next/server';
import { overlayFromEnv, removeNamesDeep } from '@/lib/brand/overlay';
import { resolveTenant } from '@/lib/tenant';
import { unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { readLibrary, readPromptOp, readScenarioOp, saveScenarioPrompt, saveScenarioTools } from '@/lib/customize/personaApi';

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
  // Under a brand overlay (BRAND_OVERLAY) the library is shown without the shop's name; what is stored is not changed.
  const overlay = overlayFromEnv();
  return NextResponse.json(overlay ? removeNamesDeep(result.body, overlay.remove) : result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  const d = await deps(req);
  if (!d) return unauthorized();
  const body = await req.json().catch(() => ({}));
  // `prompt` saves the question to try the scenario with; `tools` saves the tools it needs.
  if (body && typeof body === 'object' && 'prompt' in (body as object)) {
    const promptOp = readPromptOp(body);
    if ('error' in promptOp) return NextResponse.json({ error: promptOp.error }, { status: 400 });
    const saved = await saveScenarioPrompt(d, promptOp);
    return NextResponse.json(saved.body, { status: saved.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const op = readScenarioOp(body);
  if ('error' in op) return NextResponse.json({ error: op.error }, { status: 400 });
  const result = await saveScenarioTools(d, op);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
