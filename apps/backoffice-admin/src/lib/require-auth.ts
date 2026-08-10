/**
 * requireAuth (P0-02 R2) — server-side guard for the back-office Next API routes.
 *
 * These routes open Mongo / call services directly and previously trusted a
 * caller-supplied `tenantId`/`projectId` with NO auth. Now every route must:
 *   1. present a valid JWT (verified against auth-service),
 *   2. hold the PERMISSION the action requires (RBAC), and
 *   3. act only on a tenant derived from the IDENTITY — never the query string
 *      (see scopeTenant): a tenant user is pinned to their own workspace; only a
 *      platform admin may target another project.
 *
 * No implicit fail-open: without a token these routes 401 unless AUTH_DEV_BYPASS
 * is explicitly set (local dev only).
 */
import { can, permissionsFor, type Permission } from '@journeyax/shared-types';
import { readCookie, COOKIE_AT } from './bff-auth';

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
const DEV_BYPASS = process.env.AUTH_DEV_BYPASS === 'true';

export interface AuthedIdentity {
  email: string;
  role: string;
  tenantId: string;
  permissions: Permission[];
}

type AuthResult =
  | { ok: true; identity: AuthedIdentity; token: string }
  | { ok: false; status: number; message: string };

function devIdentity(): AuthResult {
  return { ok: true, identity: { email: 'dev@local', role: 'admin', tenantId: 'platform', permissions: permissionsFor('admin') }, token: 'dev' };
}

export async function requireAuth(req: Request, permission: Permission): Promise<AuthResult> {
  // Prefer the HttpOnly access cookie (R4); fall back to a Bearer header for any
  // remaining direct/service callers.
  const header = req.headers.get('authorization') || '';
  const token = readCookie(req, COOKIE_AT) || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');

  if (!token) {
    if (DEV_BYPASS) return devIdentity();
    return { ok: false, status: 401, message: 'Authentication required.' };
  }

  try {
    const r = await fetch(`${AUTH_URL}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { ok: false, status: 401, message: 'Invalid token.' };
    const { valid, payload } = (await r.json()) as { valid: boolean; payload?: { sub: string; role: string; tenantId: string } };
    if (!valid || !payload) return { ok: false, status: 401, message: 'Invalid token.' };
    if (!can(payload.role, permission)) {
      return { ok: false, status: 403, message: `This action requires the '${permission}' permission.` };
    }
    return { ok: true, identity: { email: payload.sub, role: payload.role, tenantId: payload.tenantId, permissions: permissionsFor(payload.role) }, token };
  } catch {
    if (DEV_BYPASS) return devIdentity();
    return { ok: false, status: 503, message: 'Auth service unreachable.' };
  }
}

/**
 * The tenant this identity may act on. Platform admins may target the requested
 * project; every other user is pinned to their own tenant — the query string is
 * NEVER trusted to widen scope (this is the cross-tenant-enumeration fix).
 */
export function scopeTenant(identity: AuthedIdentity, requested?: string | null): string {
  if (identity.role === 'admin' || identity.tenantId === 'platform') return requested || identity.tenantId;
  return identity.tenantId;
}

/** May this identity act on this specific tenant's data? (admins: any). */
export function tenantAllowed(identity: AuthedIdentity, tenant?: string | null): boolean {
  if (identity.role === 'admin' || identity.tenantId === 'platform') return true;
  return !!tenant && identity.tenantId === tenant;
}
