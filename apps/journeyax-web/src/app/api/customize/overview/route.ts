/**
 * GET /api/customize/overview
 *
 * What the Customize page shows for the signed-in person's tenant: the active pack's agents, skills, knowledge and the
 * platform tools agents can call. Read-only; it never writes and never calls a publish endpoint.
 *
 * Source: the project's PUBLISHED configuration from project-service (the same document /api/config serves a trimmed copy
 * of, and the one a pack release is compiled from). The runtime exposes no endpoint that returns a pack's content, and this
 * route does not read Mongo itself. Agent system prompts are dropped here; skill instructions are sent only to people who
 * hold the config.edit permission. Knowledge release details are added for people who may read knowledge releases.
 */
import { NextResponse } from 'next/server';
import { can } from '@journeyax/shared-types';
import { resolveTenant } from '@/lib/tenant';
import { COOKIE_AT, readCookie, unauthorized, upstreamAuthHeaders } from '@/lib/bff-auth';
import { normaliseGroupId } from '@journeyax/shared-types';
import { buildOverview } from '@/lib/customize/overview';
import { buildToolOptions } from '@/lib/customize/toolOptions';
import { buildConnectorRules } from '@/lib/customize/connectorRules';
import { readConnectorStatuses, statusUrlsFromEnv } from '@/lib/customize/connectorStatus';
import type { OverviewTeam } from '@/lib/customize/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_API = process.env.PROJECT_API || 'http://localhost:8082';
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';

/** The caller's role, verified by the auth service (the same check /api/auth/session makes); undefined when it cannot be confirmed. */
async function verifiedRole(req: Request): Promise<string | undefined> {
  const token = readCookie(req, COOKIE_AT);
  if (!token) return undefined;
  try {
    const res = await fetch(`${AUTH_URL}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const { valid, payload } = await res.json();
    return valid && payload?.role ? String(payload.role) : undefined;
  } catch {
    return undefined;
  }
}

/** Publication details of one knowledge release (metadata only, no content); null when not readable. */
async function releaseDetails(tenantId: string, releaseId: string, authorization: string): Promise<{ publishedAt?: string; status?: string } | null> {
  try {
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}/knowledge/releases?environmentId=production`, {
      headers: { Authorization: authorization, 'X-Tenant-ID': tenantId },
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const rows: unknown = await res.json();
    const row = Array.isArray(rows) ? (rows as Array<{ releaseId?: string; publishedAt?: unknown; status?: unknown }>).find((r) => r?.releaseId === releaseId) : null;
    if (!row) return null;
    return {
      ...(row.publishedAt ? { publishedAt: String(row.publishedAt) } : {}),
      ...(row.status ? { status: String(row.status) } : {}),
    };
  } catch {
    return null;
  }
}

/** The project's teams (the groups a skill can be given to); empty when they cannot be read, so the page still loads. */
async function readTeams(tenantId: string, authorization: string): Promise<OverviewTeam[]> {
  try {
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}/teams`, {
      headers: { Authorization: authorization, 'X-Tenant-ID': tenantId },
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    const seen = new Set<string>();
    const out: OverviewTeam[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      const id = normaliseGroupId(name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const auth = upstreamAuthHeaders(req);
  if (!auth) return unauthorized();
  const tenantId = await resolveTenant(req);

  const role = await verifiedRole(req);
  const canViewInstructions = can(role, 'config.edit');

  let published: Record<string, unknown>;
  try {
    const res = await fetch(`${PROJECT_API}/api/v1/projects/${encodeURIComponent(tenantId)}/published`, {
      headers: { 'X-Tenant-ID': tenantId },
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
    if (res.status === 404 || res.status === 403) {
      return NextResponse.json({ error: 'ProjectNotFound', message: 'This project is disabled or does not exist.' }, { status: 404 });
    }
    if (!res.ok) throw new Error(`project-service answered ${res.status}`);
    published = await res.json();
  } catch (err: unknown) {
    console.warn(`[customize/overview] Pack read failed for tenant '${tenantId}':`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'PackUnavailable', message: 'The assistant configuration could not be read just now.' }, { status: 502 });
  }

  // Editing skills needs the publish permission (the same one "Make live" needs); only then are the teams and the tool list read.
  const canEdit = can(role, 'config.publish');
  const teams = canEdit && auth.Authorization ? await readTeams(tenantId, auth.Authorization) : [];
  const connectorRules = canEdit ? buildConnectorRules((published.extensions as Record<string, unknown> | undefined)?.connectors as any, teams, await readConnectorStatuses(statusUrlsFromEnv(process.env.CONNECTOR_STATUS_URLS))) : [];
  const overview = buildOverview(tenantId, published, { canViewInstructions, canEdit, teams, toolOptions: canEdit ? buildToolOptions(published, teams) : [], connectorRules });

  if (overview.knowledge.releaseId && auth.Authorization && can(role, 'knowledge.read')) {
    const details = await releaseDetails(tenantId, overview.knowledge.releaseId, auth.Authorization);
    if (details) overview.knowledge = { ...overview.knowledge, ...details };
  }

  return NextResponse.json(overview, { headers: { 'Cache-Control': 'no-store' } });
}
