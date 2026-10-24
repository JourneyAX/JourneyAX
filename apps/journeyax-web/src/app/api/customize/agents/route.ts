/**
 * POST /api/customize/agents
 *
 * Makes a draft agent live: adds it to the tenant's project configuration and publishes, through project-service's own update
 * and publish routes (so the publication gate runs). Add-only: existing agents are never changed. If the publish is refused,
 * the project's agent list is put back exactly as it was. Needs the config.publish permission, checked with the auth service.
 */
import { NextResponse } from 'next/server';
import { can } from '@journeyax/shared-types';
import { resolveTenant } from '@/lib/tenant';
import { COOKIE_AT, readCookie, unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { buildPublishableAgent } from '@/lib/customize/publishAgent';
import { PLATFORM_TOOLS } from '@/lib/customize/tool-catalog';

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

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : []);

export async function POST(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const role = await verifiedRole(req);
  if (!role || !can(role as any, 'config.publish')) return NextResponse.json({ error: 'Publishing an agent needs permission to publish the configuration.' }, { status: 403 });

  const body: any = await req.json().catch(() => ({}));
  const draft = {
    name: String(body?.draft?.name ?? ''),
    purpose: String(body?.draft?.purpose ?? ''),
    instructions: String(body?.draft?.instructions ?? ''),
    skills: asStrings(body?.draft?.skills),
    tools: asStrings(body?.draft?.tools),
    knowledgeNote: String(body?.draft?.knowledgeNote ?? ''),
  };
  const tenantId = await resolveTenant(req);
  const headers = { ...auth, 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId };
  const base = `${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}`;

  try {
    const current = await fetch(base, { headers, signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!current.ok) return NextResponse.json({ error: 'The project could not be read.' }, { status: 502 });
    const project: any = await current.json();
    const existingAgents: any[] = Array.isArray(project?.agents) ? project.agents : [];
    const defaultAgent = existingAgents.find((a) => a?.isDefault === true) || existingAgents[0];
    const built = buildPublishableAgent(draft, {
      existingAgents,
      knownTools: Object.keys(PLATFORM_TOOLS).filter((id) => id !== 'use_skill'),
      knownSkills: asStrings((project?.extensions?.skills || []).map((s: any) => s?.skillId)),
      modelPolicyRef: typeof defaultAgent?.modelPolicyRef === 'string' ? defaultAgent.modelPolicyRef : undefined,
    });
    if (built.ok === false) return NextResponse.json({ error: built.errors.join(' ') }, { status: 400 });

    const updated = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ agents: built.agents }), signal: AbortSignal.timeout(8000) });
    if (!updated.ok) return NextResponse.json({ error: 'The agent could not be saved to the project.' }, { status: 502 });

    const published = await fetch(`${base}/publish`, {
      method: 'POST', headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ environmentId: 'production', note: `Agent "${built.agent.name}" added from the Customize page` }),
    });
    if (!published.ok) {
      const detail: any = await published.json().catch(() => ({}));
      // Put the agent list back exactly as it was, so a refused publish leaves nothing behind.
      await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ agents: existingAgents }), signal: AbortSignal.timeout(8000) }).catch(() => undefined);
      return NextResponse.json({ error: `The configuration was not published: ${String(detail?.message || published.status)}` }, { status: 422 });
    }
    const result: any = await published.json().catch(() => ({}));
    return NextResponse.json({ ok: true, agentId: built.agent.agentId, version: result?.version ?? result?.config?.version ?? null });
  } catch (err: any) {
    console.warn(`[customize/agents] Publishing an agent for tenant '${tenantId}' failed:`, err.message);
    return NextResponse.json({ error: 'The project service is unavailable.' }, { status: 502 });
  }
}
