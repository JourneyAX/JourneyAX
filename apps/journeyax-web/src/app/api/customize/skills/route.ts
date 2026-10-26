/**
 * POST /api/customize/skills
 *
 * Saves or deletes a skill of the tenant's assistant and makes the change live: reads the project's settings, works out the new skill,
 * who has it and which agents carry it, writes them with project-service's own update route and publishes through the publication gate
 * (which refuses an inconsistent result). If the publish is refused, every setting is put back exactly as it was.
 *
 *   { op: 'save', mode: 'create' | 'update', skill: { skillId?, name, description, tier, instructions, tools[], access[], agents[] }, base? }
 *   { op: 'delete', skillId, base }
 *
 * `base` is the fingerprint of the skill as the page read it; a skill changed elsewhere since then is refused with 409.
 * Needs the config.publish permission, checked with the auth service. Nothing here runs without a signed-in person who has it.
 */
import { NextResponse } from 'next/server';
import { can } from '@journeyax/shared-types';
import { resolveTenant } from '@/lib/tenant';
import { COOKIE_AT, readCookie, unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { changeSkill, readSkillOp } from '@/lib/customize/skillPublish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';

async function verifiedRole(req: Request): Promise<string | undefined> {
  const token = readCookie(req, COOKIE_AT);
  if (!token) return undefined;
  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const { valid, payload } = await res.json();
    return valid && payload?.role ? String(payload.role) : undefined;
  } catch { return undefined; }
}

export async function POST(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const role = await verifiedRole(req);
  if (!role || !can(role as any, 'config.publish')) return NextResponse.json({ error: 'Changing a skill needs permission to publish the configuration.' }, { status: 403 });

  const op = readSkillOp(await req.json().catch(() => ({})));
  if ('error' in op) return NextResponse.json({ error: op.error }, { status: 400 });

  const tenantId = await resolveTenant(req);
  const result = await changeSkill({
    base: `${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}`,
    headers: { ...auth, 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
  }, op);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
