import { timingSafeEqual } from 'node:crypto';
import type { JtiStore } from './jti';
import { isUsableSecret, signatureOf, type ScopeSecret } from './sign';
import { CallScopeSchema, type CallScope } from './types';

/**
 * The reference check a connector service can run on the `X-Caller-Scope` header before it does any work. The connector servers do not run
 * it in this round (design only); it is here so that the later round starts from a tested contract.
 *
 * Every message of one tool call carries the same header: `initialize`, `notifications/initialized` and then `tools/call`. All three need a
 * valid, unexpired signature for this tenant and environment, and for this connector when the verifier says which connector it serves.
 * Only `tools/call` has to name the tool the scope was made for, and only `tools/call` uses up the `jti`; a refused `tools/call` does not
 * use it up.
 */

export type ScopeRefusal =
  | 'no_secret'
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'unsupported_version'
  | 'tool_state_not_allow'
  | 'expired'
  | 'wrong_tenant'
  | 'wrong_environment'
  | 'wrong_connector'
  | 'wrong_tool'
  | 'wrong_arguments'
  | 'replayed';

export type ScopeVerdict =
  | { ok: true; scope: CallScope }
  | { ok: false; reason: ScopeRefusal; message: string };

export interface VerifyScopeOptions {
  secret: ScopeSecret;
  now: Date;
  /** The JSON-RPC method of the message the header came with. */
  method: string;
  /** The tenant and environment headers of the same request. */
  tenantHeader: string;
  environmentHeader: string;
  /**
   * The id of the connector that receives the message. When given it must equal the scope's `connectorId` on every method, handshake
   * included, so a scope made for one connector cannot be used at another that has a tool of the same name. A connector service should
   * always give it; without it the check is skipped.
   */
  connectorId?: string;
  /** The tool the message names. Required on `tools/call`. */
  toolName?: string;
  /** The hash of the arguments the message carries (`hashScopeArguments`); when given it must equal the scope's. */
  argsHash?: string;
  seen: JtiStore;
}

/** The one method that names a tool and uses up the `jti`. */
const TOOL_CALL = 'tools/call';

const MESSAGES: Record<ScopeRefusal, string> = {
  no_secret: 'The service has no signing secret, so it accepts no scope.',
  missing: 'The call carries no caller scope.',
  malformed: 'The caller scope is not in the expected form.',
  bad_signature: 'The caller scope signature is not valid.',
  unsupported_version: 'The caller scope is of a version this check does not read.',
  tool_state_not_allow: 'The caller scope does not say the tool is allowed.',
  expired: 'The caller scope has expired.',
  wrong_tenant: 'The caller scope was made for another tenant.',
  wrong_environment: 'The caller scope was made for another environment.',
  wrong_connector: 'The caller scope was made for another connector.',
  wrong_tool: 'The caller scope was made for another tool.',
  wrong_arguments: 'The caller scope was made for other arguments.',
  replayed: 'The caller scope was already used for a call.',
};

const refuse = (reason: ScopeRefusal): ScopeVerdict => ({ ok: false, reason, message: MESSAGES[reason] });

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** True when the two texts are equal, in time that does not depend on where they first differ. */
function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyScope(header: string | undefined | null, options: VerifyScopeOptions): ScopeVerdict {
  if (!isUsableSecret(options.secret)) return refuse('no_secret');
  if (typeof header !== 'string' || header.length === 0) return refuse('missing');

  const parts = header.split('.');
  if (parts.length !== 2 || !BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) return refuse('malformed');
  const [payloadPart, signaturePart] = parts;
  if (!sameText(signaturePart, signatureOf(payloadPart, options.secret))) return refuse('bad_signature');

  // The signature is good, so the body is what a service of ours wrote. Read it.
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return refuse('malformed');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return refuse('malformed');
  const raw = body as Record<string, unknown>;
  if (raw.v !== 1) return refuse('unsupported_version');
  if (raw.toolState !== 'allow') return refuse('tool_state_not_allow');
  const parsed = CallScopeSchema.safeParse(raw);
  if (!parsed.success) return refuse('malformed');
  const scope = parsed.data;

  // Written so that a time that is not a time (an invalid date) counts as expired, not as in time.
  if (!(options.now.getTime() < scope.exp * 1000)) return refuse('expired');
  if (scope.tenantId !== options.tenantHeader) return refuse('wrong_tenant');
  if (scope.environmentId !== options.environmentHeader) return refuse('wrong_environment');
  if (options.connectorId !== undefined && scope.connectorId !== options.connectorId) return refuse('wrong_connector');
  const isToolCall = options.method === TOOL_CALL;
  if ((isToolCall || options.toolName !== undefined) && scope.tool !== options.toolName) return refuse('wrong_tool');
  if (options.argsHash !== undefined && scope.argsHash !== options.argsHash) return refuse('wrong_arguments');
  // Last, so that a call refused for another reason leaves the scope unused.
  if (isToolCall && options.seen.seen(scope.jti, scope.exp)) return refuse('replayed');
  return { ok: true, scope };
}
