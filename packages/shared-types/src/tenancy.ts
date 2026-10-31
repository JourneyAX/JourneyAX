/**
 * Which tenant ids may be the tenant of a self-service account.
 *
 * The gateway lets an identity act on every project when its tenant is `platform` and treats `system` and `global` as the platform's
 * own tenants, so those ids belong to people the platform creates itself (the admin seed, the staff scripts), never to someone who
 * signed up through the open registration route. A few more names read as staff or as a service and are kept back for the same reason.
 * A real customer-facing project is anything else that is well formed, and the gateway then checks that it exists.
 */
export const PLATFORM_TENANT_IDS: readonly string[] = ['platform', 'system', 'global'];

const RESERVED_TENANT_IDS: ReadonlySet<string> = new Set([
  ...PLATFORM_TENANT_IDS,
  'admin', 'root', 'internal', 'anonymous', 'guest', 'public',
]);

/** The shape of a project id: lower case letters, digits and hyphens, starting with a letter or digit (the same alphabet the project service enforces). */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Is this one of the platform's own tenants (the ones the gateway lets act on any project)? */
export function isPlatformTenantId(tenantId: string | undefined): boolean {
  return !!tenantId && PLATFORM_TENANT_IDS.includes(tenantId);
}

/** Is this id kept back from self-service accounts? Expects an id already run through `normaliseTenantId`. */
export function isReservedTenantId(tenantId: string): boolean {
  return RESERVED_TENANT_IDS.has(tenantId);
}

/** Trim and lower-case a tenant id, as the services store it. Anything that is not a string is not a tenant id. */
export function normaliseTenantId(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

export type SelfServiceTenantCheck =
  | { status: 'ok'; tenantId: string }
  | { status: 'refused'; reason: 'missing' | 'malformed' | 'reserved' };

/** May an account created through the open registration route belong to this tenant? Says why not when it may not. */
export function checkSelfServiceTenant(value: unknown): SelfServiceTenantCheck {
  const tenantId = normaliseTenantId(value);
  if (!tenantId) return { status: 'refused', reason: 'missing' };
  if (!PROJECT_ID_PATTERN.test(tenantId)) return { status: 'refused', reason: 'malformed' };
  if (isReservedTenantId(tenantId)) return { status: 'refused', reason: 'reserved' };
  return { status: 'ok', tenantId };
}
