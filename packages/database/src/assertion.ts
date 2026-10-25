import * as crypto from 'crypto';

export const GATEWAY_ASSERTION_ISSUER = 'journeyax-api-gateway' as const;
export const GATEWAY_ASSERTION_AUDIENCE = 'journeyax-runtime' as const;

export const VALID_GATEWAY_ROLES = [
  'admin',
  'manager',
  'operator',
  'consultant',
  'customer',
] as const;

export type GatewayRole = (typeof VALID_GATEWAY_ROLES)[number];

/** The most groups an assertion may carry, and the longest group id. Mirrors `MAX_GROUPS` and `MAX_GROUP_ID_LENGTH` in shared-types `principal.ts`. */
export const ASSERTION_MAX_GROUPS = 50;
export const ASSERTION_MAX_GROUP_ID_LENGTH = 64;
/** A group id as `normaliseGroupId` (shared-types) writes it: lower case letters, digits and `-`, `.`, `:`, starting and ending with a letter or digit. */
const GROUP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9\-.:]*[a-z0-9])?$/;

/** The groups an assertion may carry: valid ids only, no duplicates, at most {@link ASSERTION_MAX_GROUPS}. */
export function cleanAssertionGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const value of groups) {
    if (typeof value !== 'string' || value.length > ASSERTION_MAX_GROUP_ID_LENGTH || !GROUP_ID_PATTERN.test(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length >= ASSERTION_MAX_GROUPS) break;
  }
  return out;
}

export interface GatewayAssertionPayload {
  iss: typeof GATEWAY_ASSERTION_ISSUER;
  aud: typeof GATEWAY_ASSERTION_AUDIENCE;
  tenantId: string;
  environmentId: string;
  sub: string;
  role: GatewayRole;
  /** The staff groups the person belongs to in this tenant (for example `customer-service`). Absent for a shopper and for an older gateway. */
  groups?: string[];
  iat: number;
  exp: number;
  jti: string;
}

export type GatewayAssertionClaims = GatewayAssertionPayload;

export interface SignGatewayAssertionOptions {
  ttlSeconds?: number;
  jti?: string;
  iat?: number;
}

export interface VerifyGatewayAssertionOptions {
  expectedTenantId: string;
  expectedEnvironmentId?: string;
  maxClockSkewSeconds?: number;
}

export class GatewayAssertionError extends Error {
  constructor(message: string, public readonly code: string = 'INVALID_ASSERTION') {
    super(message);
    this.name = 'GatewayAssertionError';
  }
}

/**
 * Signs a strongly-typed Gateway Assertion using HMAC-SHA256.
 */
export function signGatewayAssertion(
  claims: {
    tenantId: string;
    environmentId?: string;
    sub: string;
    role: GatewayRole;
    groups?: string[];
  },
  secret: string,
  options: SignGatewayAssertionOptions = {}
): string {
  if (!secret) {
    throw new GatewayAssertionError('Signing secret must not be empty', 'SECRET_MISSING');
  }

  const nowSec = options.iat ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(1, options.ttlSeconds ?? 300), 300);
  const exp = nowSec + ttl;
  const jti = options.jti ?? `jti_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;

  const payload: GatewayAssertionPayload = {
    iss: GATEWAY_ASSERTION_ISSUER,
    aud: GATEWAY_ASSERTION_AUDIENCE,
    tenantId: claims.tenantId.toLowerCase(),
    environmentId: (claims.environmentId || 'production').toLowerCase(),
    sub: claims.sub,
    role: claims.role,
    ...(cleanAssertionGroups(claims.groups).length > 0 ? { groups: cleanAssertionGroups(claims.groups) } : {}),
    iat: nowSec,
    exp,
    jti,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('hex');
  return `${encodedPayload}.${signature}`;
}

/**
 * Strictly verifies a Gateway Assertion with timing-safe HMAC check,
 * lifetime validation, clock skew checks, and tenant/environment binding.
 */
export function verifyGatewayAssertion(
  token: string,
  secret: string,
  options: VerifyGatewayAssertionOptions
): GatewayAssertionPayload {
  if (!token || typeof token !== 'string') {
    throw new GatewayAssertionError('Missing or invalid assertion format', 'MALFORMED');
  }
  if (!secret) {
    throw new GatewayAssertionError('Assertion verification secret is not configured', 'SECRET_MISSING');
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new GatewayAssertionError('Assertion must be in <payload>.<sig> format', 'MALFORMED');
  }

  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) {
    throw new GatewayAssertionError('Assertion payload or signature segment is empty', 'MALFORMED');
  }

  // 1. Timing-safe signature verification
  const expectedSig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('hex');
  const providedBuffer = Buffer.from(providedSig);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new GatewayAssertionError('Signature mismatch in gateway assertion', 'SIGNATURE_MISMATCH');
  }

  // 2. Decode and parse JSON payload
  let payload: any;
  try {
    const jsonStr = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    payload = JSON.parse(jsonStr);
  } catch {
    throw new GatewayAssertionError('Payload decoding or JSON parse failed', 'MALFORMED');
  }

  // 3. Strict presence check on all 9 required claims
  const requiredClaims = ['iss', 'aud', 'tenantId', 'environmentId', 'sub', 'role', 'iat', 'exp', 'jti'];
  for (const field of requiredClaims) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new GatewayAssertionError(`Missing required claim in assertion: '${field}'`, 'MISSING_CLAIM');
    }
  }

  // 4. Issuer and audience validation
  if (payload.iss !== GATEWAY_ASSERTION_ISSUER) {
    throw new GatewayAssertionError(
      `Invalid issuer: expected '${GATEWAY_ASSERTION_ISSUER}', got '${payload.iss}'`,
      'INVALID_ISSUER'
    );
  }
  if (payload.aud !== GATEWAY_ASSERTION_AUDIENCE) {
    throw new GatewayAssertionError(
      `Invalid audience: expected '${GATEWAY_ASSERTION_AUDIENCE}', got '${payload.aud}'`,
      'INVALID_AUDIENCE'
    );
  }

  // 5. Role validation
  if (!VALID_GATEWAY_ROLES.includes(payload.role)) {
    throw new GatewayAssertionError(
      `Invalid role '${payload.role}': must be one of ${VALID_GATEWAY_ROLES.join(', ')}`,
      'INVALID_ROLE'
    );
  }

  // 5b. Groups (optional claim): when present they must be a clean list, exactly as the gateway writes them.
  if (payload.groups !== undefined) {
    const cleaned = cleanAssertionGroups(payload.groups);
    if (!Array.isArray(payload.groups) || cleaned.length !== payload.groups.length) {
      throw new GatewayAssertionError('Invalid groups claim in assertion', 'INVALID_GROUPS');
    }
  }

  // 6. Tenant and environment binding
  const normExpectedTenant = options.expectedTenantId.trim().toLowerCase();
  if (payload.tenantId.toLowerCase() !== normExpectedTenant) {
    throw new GatewayAssertionError(
      `Tenant binding mismatch: assertion tenant '${payload.tenantId}' does not match request '${normExpectedTenant}'`,
      'TENANT_MISMATCH'
    );
  }

  const expectedEnv = (options.expectedEnvironmentId || 'production').trim().toLowerCase();
  if (payload.environmentId.toLowerCase() !== expectedEnv) {
    throw new GatewayAssertionError(
      `Environment binding mismatch: assertion environment '${payload.environmentId}' does not match request '${expectedEnv}'`,
      'ENVIRONMENT_MISMATCH'
    );
  }

  // 7. Time and lifetime validation (with clock skew)
  const nowSec = Math.floor(Date.now() / 1000);
  const maxClockSkew = options.maxClockSkewSeconds ?? 30;

  // Reject future-dated tokens (exceeding clock skew)
  if (payload.iat > nowSec + maxClockSkew) {
    throw new GatewayAssertionError(
      `Assertion issued in the future (iat=${payload.iat}, now=${nowSec})`,
      'FUTURE_ISSUED'
    );
  }

  // Reject expired tokens
  if (payload.exp <= nowSec) {
    throw new GatewayAssertionError(
      `Assertion expired (exp=${payload.exp}, now=${nowSec})`,
      'EXPIRED'
    );
  }

  // Maximum lifetime constraint (5 minutes = 300 seconds)
  if (payload.exp - payload.iat > 300) {
    throw new GatewayAssertionError(
      `Assertion lifetime exceeds maximum allowed 300 seconds (${payload.exp - payload.iat}s)`,
      'LIFETIME_EXCEEDED'
    );
  }

  return payload as GatewayAssertionPayload;
}
