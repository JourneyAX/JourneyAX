import { timingSafeEqual } from 'node:crypto';
import { verifyGatewayAssertion } from './assertion';

export interface VerifiedServiceIdentity { sub: string; role: string; tenantId: string; internal: boolean }
export interface ServiceIdentityOptions { internalKey?: string; assertionSecret?: string; authUrl: string; expectedTenantId?: string; expectedEnvironmentId?: string; fetchImpl?: typeof fetch }
const header = (headers: Record<string, unknown>, name: string) => typeof headers[name] === 'string' ? headers[name] as string : '';
const equal = (given: string, expected: string) => { const a = Buffer.from(given), b = Buffer.from(expected); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); };

/** Establish identity independently at a service boundary. Claimed role/permission
 * or x-internal-call headers never authenticate a request. No development bypass. */
export async function authenticateServiceIdentity(headers: Record<string, unknown>, options: ServiceIdentityOptions): Promise<VerifiedServiceIdentity> {
  if (options.internalKey && equal(header(headers, 'x-internal-key'), options.internalKey)) return { sub: 'service:internal', role: 'admin', tenantId: String(options.expectedTenantId || header(headers, 'x-tenant-id')).toLowerCase(), internal: true };
  const assertion = header(headers, 'x-gateway-assertion');
  if (assertion) {
    const target = String(options.expectedTenantId || header(headers, 'x-tenant-id')).toLowerCase();
    if (!target) throw new Error('An explicit signed tenant is required.');
    const value = verifyGatewayAssertion(assertion, options.assertionSecret || '', { expectedTenantId: target, expectedEnvironmentId: options.expectedEnvironmentId || 'production' });
    return { sub: value.sub, role: value.role, tenantId: value.tenantId, internal: false };
  }
  const auth = header(headers, 'authorization'), token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new Error('Verified service identity is required.');
  let response: Response;
  try { response = await (options.fetchImpl || fetch)(`${options.authUrl.replace(/\/$/, '')}/api/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), redirect: 'error', signal: AbortSignal.timeout(3000) }); }
  catch { throw new Error('Identity verification is unavailable.'); }
  if (!response.ok) throw new Error('Identity verification failed.');
  const answer = await response.json() as any, identity = answer?.payload;
  if (answer?.valid !== true || typeof identity?.sub !== 'string' || !identity.sub.trim() || typeof identity.role !== 'string' || typeof identity.tenantId !== 'string' || !identity.tenantId.trim()) throw new Error('Identity verification failed.');
  return { sub: identity.sub, role: identity.role, tenantId: identity.tenantId.toLowerCase(), internal: false };
}
