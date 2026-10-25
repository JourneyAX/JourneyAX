import { verifyGatewayAssertion } from '@journeyax/database';

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
    const payload = verifyGatewayAssertion(assertion, secret, { expectedTenantId: tenantId });
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
