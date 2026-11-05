import { verifyGatewayAssertion } from '@journeyax/database';

function deploymentEnvironment(): string {
  const environment = process.env.COMMERCE_ENVIRONMENT || 'production';
  if (!['dev', 'test', 'staging', 'production'].includes(environment)) throw new Error('Unsupported commerce deployment environment.');
  return environment;
}

/**
 * Who is asking, as the gateway signed it. The browser never says which role or groups a person has: the gateway verifies the login
 * and signs the role and (for staff) the groups into an assertion on every call it passes on. This service reads that assertion so the
 * runtime can be told the same, instead of treating every signed-in person as a shopper. Anything wrong with the assertion (missing, not
 * signed with our secret, for another tenant, expired) gives no identity, which means a shopper: it can only ever lower what a person gets.
 */
export interface VerifiedIdentity {
  sub: string;
  role: string;
  groups: string[];
}

export function verifiedIdentity(assertion: string | undefined, tenantId: string, secret: string | undefined = process.env.GATEWAY_ASSERTION_SECRET): VerifiedIdentity | undefined {
  if (!assertion || !secret || !tenantId) return undefined;
  try {
    const payload = verifyGatewayAssertion(assertion, secret, { expectedTenantId: tenantId, expectedEnvironmentId: deploymentEnvironment() });
    return { sub: payload.sub, role: payload.role, groups: payload.groups ?? [] };
  } catch {
    return undefined;
  }
}

/** The connectors a person has switched off for this chat, from the request: a short list of plain ids, nothing else. */
export function cleanDisabledConnectors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(id)))].slice(0, 50);
  return ids.length ? ids : undefined;
}

/** Only the gateway-verified subject is an identity. A browser's customer/session ID is never re-signed as one. */
export function principalIdFor(identity: VerifiedIdentity | undefined, _claimed: unknown): string {
  const verified = String(identity?.sub ?? '').trim();
  return verified && !['anonymous', 'guest', 'guest@anonymous'].includes(verified.toLowerCase()) ? verified : 'anonymous';
}

/** The page cannot change deployment environment while the gateway signs another one. */
export function chatEnvironment(assertion: string | undefined, tenantId: string, claimed?: string, internalKey?: string): string {
  const allowed = ['dev', 'test', 'staging', 'production'];
  const workload = !!process.env.INTERNAL_API_KEY && internalKey === process.env.INTERNAL_API_KEY;
  if (workload && claimed && allowed.includes(claimed)) return claimed;
  let environment = 'production';
  if (assertion && process.env.GATEWAY_ASSERTION_SECRET) {
    const identity = verifyGatewayAssertion(assertion, process.env.GATEWAY_ASSERTION_SECRET, { expectedTenantId: tenantId, expectedEnvironmentId: deploymentEnvironment() });
    environment = identity.environmentId;
  }
  if (!allowed.includes(environment) || claimed && claimed !== environment) throw Object.assign(new Error('The requested environment does not match the verified deployment scope.'), { status: 403 });
  return environment;
}

export interface CommerceIdentity { principalId: string; environmentId: string; role: string; groups: string[] }
export function commerceIdentity(assertion: string | undefined, tenantId: string): CommerceIdentity | undefined {
  const secret = process.env.GATEWAY_ASSERTION_SECRET;
  if (!assertion || !secret) return undefined;
  try {
    const value = verifyGatewayAssertion(assertion, secret, { expectedTenantId: tenantId, expectedEnvironmentId: deploymentEnvironment() });
    if (!value.sub || ['anonymous', 'guest', 'guest@anonymous'].includes(value.sub.toLowerCase())) return undefined;
    return { principalId: value.sub, environmentId: value.environmentId, role: value.role, groups: value.groups ?? [] };
  } catch { return undefined; }
}
