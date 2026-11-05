import { createHash, createHmac } from 'node:crypto';
import { CallScopeSchema, type CallScope, type SignedScope } from './types';

/**
 * A signed scope is two parts joined by a dot: the scope as JSON in base64url, then the HMAC-SHA256 of that exact first part in base64url.
 * The secret is always an argument; this module reads no environment. Nothing it throws or returns contains the secret.
 */

export type ScopeSecret = string | Uint8Array;

/** A secret is a string or bytes and is not empty. */
export function isUsableSecret(secret: unknown): secret is ScopeSecret {
  if (typeof secret === 'string') return secret.length > 0;
  return secret instanceof Uint8Array && secret.byteLength > 0;
}

/** The signature of the first part of a header. */
export function signatureOf(payloadPart: string, secret: ScopeSecret): string {
  return createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

/** The same JSON whatever the order the keys were written in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash a scope holds in place of the arguments of the call: SHA-256 in hex, the same for the same arguments in any key order. */
export function hashScopeArguments(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  if (json === undefined) throw new Error('The arguments cannot be written as JSON.');
  return createHash('sha256').update(canonicalJson(JSON.parse(json))).digest('hex');
}

/** Signs a scope. Refuses a scope that is not valid (only `allow`, no extra keys, a hash and field names, an expiry after the issue time). */
export function signScope(scope: CallScope, secret: ScopeSecret): SignedScope {
  if (!isUsableSecret(secret)) throw new Error('A scope cannot be signed without a secret.');
  const parsed = CallScopeSchema.safeParse(scope);
  if (!parsed.success) {
    const paths = parsed.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys.map((key) => [...issue.path, key].join('.')) : [issue.path.join('.') || 'scope']));
    const where = [...new Set(paths)].join(', ');
    throw new Error(`The scope is not valid and was not signed. Fix: ${where}.`);
  }
  const payloadPart = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
  return { header: `${payloadPart}.${signatureOf(payloadPart, secret)}`, scope: parsed.data as CallScope };
}
