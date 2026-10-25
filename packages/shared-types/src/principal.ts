/**
 * Who is asking, as the server sees it: one shape for every service.
 *
 * Four lists of role names grew up in different places (platform permissions, the user type, the role the gateway signs, the role of a
 * project member). They stay as they are; this file is the one place that says what each of them means for *which agents a person may
 * use*: a shopper, or a member of staff, and which groups of staff they belong to.
 *
 * Rules that keep it safe:
 *  - an unknown role is a shopper (the least access);
 *  - a shopper carries no groups, whatever was claimed, so a group can never lift a shopper into staff agents;
 *  - group ids are normalised and capped, so a claim cannot be used to smuggle odd text or a huge list.
 */

export type Audience = 'shopper' | 'staff';

export interface Principal {
  /** The signed-in person (the token subject), or `anonymous`. */
  userId: string;
  tenantId?: string;
  audience: Audience;
  /** The role as one of the four lists wrote it, lower-cased. Kept for the audit trail; do not branch on it. */
  roleType: string;
  /** Normalised group ids (for example `customer-service`). Always empty for a shopper. */
  groups: string[];
}

export const MAX_GROUPS = 50;
export const MAX_GROUP_ID_LENGTH = 64;
export const ANONYMOUS_USER_ID = 'anonymous';
/**
 * The group the platform admin belongs to by role. Access rows written per team name it so the admin is not shut out (the admin is in no
 * project team). The gateway adds it for that role only and strips it from anything a team lookup returns, so a team that happens to be
 * called Administrators puts nobody in it.
 */
export const ADMIN_GROUP = 'administrators';

/** Every role name, across the four lists, that belongs to a member of staff. Anything else is a shopper. */
const STAFF_ROLES: ReadonlySet<string> = new Set([
  // platform permissions (rbac.ts) and the gateway's signed roles
  'admin', 'manager', 'operator', 'consultant',
  // the user type
  'cs', 'rep',
  // project members
  'owner', 'analyst', 'viewer',
]);

/** True for a role name that belongs to a member of staff; false for a shopper, a guest, an unknown or an empty role. */
export function isStaffRole(role: unknown): boolean {
  return typeof role === 'string' && STAFF_ROLES.has(role.trim().toLowerCase());
}

/** The audience a role name belongs to. */
export function audienceForRole(role: unknown): Audience {
  return isStaffRole(role) ? 'staff' : 'shopper';
}

/** One group id in its stored form: lower case, letters, digits and `-`, `.`, `:`; spaces and underscores become `-`. Empty when nothing usable is left. */
export function normaliseGroupId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-.:]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.:]+|[-.:]+$/g, '')
    .slice(0, MAX_GROUP_ID_LENGTH);
}

/** A list (or a comma-separated string) of group ids, normalised, without duplicates or empties, at most {@link MAX_GROUPS}. */
export function normaliseGroups(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : typeof values === 'string' ? values.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const id = normaliseGroupId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

/** The principal for a person, from whatever role name and group claims the caller has. */
export function principalFrom(input: { userId?: unknown; tenantId?: unknown; role?: unknown; groups?: unknown }): Principal {
  const roleType = typeof input.role === 'string' && input.role.trim() ? input.role.trim().toLowerCase() : 'customer';
  const audience = audienceForRole(roleType);
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : ANONYMOUS_USER_ID;
  return {
    userId,
    ...(typeof input.tenantId === 'string' && input.tenantId.trim() ? { tenantId: input.tenantId.trim() } : {}),
    audience,
    roleType,
    groups: audience === 'staff' ? normaliseGroups(input.groups) : [],
  };
}
