import { checkSelfServiceTenant } from '@journeyax/shared-types';

/**
 * What the open registration route (`POST /api/v1/auth/register`, reachable without signing in) accepts.
 *
 * There is deliberately no role here. Anyone can call the route, so it can only ever create a plain customer (`buyer`) in a real,
 * customer-facing project. Staff and admin logins are made another way, by people who already hold access to the database: the admin
 * seed (`seed-admin.ts`) and the staff scripts (`scripts/placemakers/seed-demo-staff.ts`). Nothing in the request body can reach the
 * stored document except the four fields below.
 */
export interface PublicRegistration {
  email: string;
  password: string;
  tenantId: string;
  fullName: string;
}

export type PublicRegistrationRead =
  | { status: 'ok'; value: PublicRegistration }
  | { status: 'refused'; message: string };

const MISSING_FIELDS = 'email, password, tenantId, and fullName are required.';
const NOT_A_PROJECT = 'tenantId must name a customer-facing project.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/**
 * Picks the four fields out of whatever the caller sent and checks their type and size. Every other field (`role`, `isActive`,
 * `passwordHash`, `_id`, ...) is dropped without a word, and a tenant that is reserved or not a well-formed project id is refused
 * with one message, so the reply does not list the reserved names.
 */
export function readPublicRegistration(body: unknown): PublicRegistrationRead {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'refused', message: MISSING_FIELDS };
  const { email, password, tenantId, fullName } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string' || typeof fullName !== 'string' || !email.trim() || !password || !fullName.trim()) {
    return { status: 'refused', message: MISSING_FIELDS };
  }
  const tenant = checkSelfServiceTenant(tenantId);
  if (tenant.status === 'refused') return { status: 'refused', message: tenant.reason === 'missing' ? MISSING_FIELDS : NOT_A_PROJECT };
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.length > 254 || !EMAIL_SHAPE.test(cleanEmail)) return { status: 'refused', message: 'email must be a valid e-mail address.' };
  if (password.length < 8) return { status: 'refused', message: 'Password must be at least 8 characters.' };
  if (password.length > 128) return { status: 'refused', message: 'Password must be at most 128 characters.' };
  const cleanName = fullName.trim();
  if (cleanName.length > 200) return { status: 'refused', message: 'fullName must be at most 200 characters.' };
  return { status: 'ok', value: { email: cleanEmail, password, tenantId: tenant.tenantId, fullName: cleanName } };
}
