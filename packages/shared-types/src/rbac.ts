/**
 * RBAC policy (P0-02) — the single source of truth for authorization.
 *
 * Roles are coarse (what the JWT carries today); PERMISSIONS are the fine-grained
 * actions the audit requires (`config.publish`, `knowledge.ingest`, `secret.rotate`
 * …). The gateway, the back-office BFF routes, and each service all derive
 * "may this subject do this action?" from THIS map — never from ad-hoc role
 * string checks scattered across the codebase.
 */

export type Role = 'admin' | 'manager' | 'buyer' | 'guest';

export type Permission =
  | 'project.read'
  | 'project.list'
  | 'config.edit'
  | 'config.publish'
  | 'knowledge.read'
  | 'knowledge.ingest'
  | 'knowledge.delete'
  | 'secret.rotate'
  | 'user.read'
  | 'user.manage'
  | 'order.read'
  | 'order.manage'
  | 'analytics.read'
  | 'chat.use';

/** What each role may do. Additive from least → most privileged. */
const GUEST: Permission[] = ['chat.use'];
const BUYER: Permission[] = [...GUEST, 'project.read', 'order.read', 'knowledge.read'];
const MANAGER: Permission[] = [
  ...BUYER,
  'config.edit', 'config.publish', 'knowledge.ingest', 'knowledge.delete',
  'order.manage', 'analytics.read', 'user.read',
];
// Platform admin: everything, including cross-tenant + secret rotation + user mgmt.
const ADMIN: Permission[] = [...MANAGER, 'project.list', 'secret.rotate', 'user.manage'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  guest: GUEST,
  buyer: BUYER,
  manager: MANAGER,
  admin: ADMIN,
};

function normaliseRole(role?: string): Role {
  const r = (role || 'guest').toLowerCase();
  return r === 'admin' || r === 'manager' || r === 'buyer' || r === 'guest' ? (r as Role) : 'guest';
}

/** Does this role hold this permission? */
export function can(role: string | undefined, permission: Permission): boolean {
  return ROLE_PERMISSIONS[normaliseRole(role)].includes(permission);
}

/** All permissions for a role (e.g. to stamp on a downstream header). */
export function permissionsFor(role: string | undefined): Permission[] {
  return ROLE_PERMISSIONS[normaliseRole(role)];
}

/**
 * Route → required permission policy for the API gateway. Keyed by `${domain}`,
 * with an optional per-HTTP-method override. A request must satisfy the matched
 * permission. Domains not listed here fall back to `defaultByMethod`.
 *
 * `null` ⇒ no permission required beyond a valid (or anonymous, where allowed)
 * identity — used for customer-facing chat.
 */
export interface DomainPolicy {
  read?: Permission | null;   // GET/HEAD
  write?: Permission | null;  // POST/PUT/PATCH/DELETE
}

export const GATEWAY_POLICY: Record<string, DomainPolicy> = {
  commerce:      { read: null, write: null },              // customer chat/order — anon allowed upstream
  products:      { read: null, write: 'config.edit' },     // public search; writes need edit
  projects:      { read: 'project.read', write: 'config.edit' },
  organizations: { read: 'project.read', write: 'user.manage' },
  analytics:     { read: 'analytics.read', write: 'analytics.read' },
  leads:         { read: 'analytics.read', write: 'chat.use' },
  data:          { read: 'project.read', write: 'config.edit' },
  auth:          { read: null, write: null },              // login/register are public routes anyway
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The permission required for a (domain, method). Returns `null` when no
 * permission is required, or `undefined` when the domain is unknown (caller
 * decides — default deny for platform routes, allow for anon domains).
 */
export function requiredPermission(domain: string | null, method: string): Permission | null | undefined {
  if (!domain) return undefined;
  const policy = GATEWAY_POLICY[domain];
  if (!policy) return undefined;
  const isWrite = WRITE_METHODS.has(method.toUpperCase());
  return isWrite ? policy.write : policy.read;
}
