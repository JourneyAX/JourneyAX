import { z } from 'zod';

/**
 * The caller scope: who is asking and what the tool state was, signed and sent with every call JAX IQ makes to a connector server.
 * It holds ids, words and field names, never a fact value and never an argument value (`argsHash` is a hash). Only `allow` is ever
 * signed: a call whose state is `blocked` or `ask` is not made at all. A connector service can check the scope itself and cut its
 * answer to `fields`; the reference check is `verifyScope`.
 */

/** The header that carries the signed scope. */
export const SCOPE_HEADER = 'X-Caller-Scope';

export interface CallScope {
  v: 1 | 2;
  /** Read scopes cannot authorise commands. Command scopes are issued by the governed harness action path. */
  operation?: 'read' | 'command';
  actionId?: string;
  tenantId: string;
  environmentId: string;
  queryId: string;
  correlationId: string;
  principal: { id: string; audience: 'staff' | 'shopper'; groups: string[] };
  connectorId: string;
  /** V2 binds the physical connection, not just the logical vendor. */
  connectionRef?: string;
  tool: string;
  /** Only 'allow' is ever signed. */
  toolState: 'allow';
  toolStateVia: 'tool' | 'default' | 'none';
  /** The thing rules that narrowed the table's state. */
  capRuleIds: string[];
  /** Hash of the arguments, not the arguments. */
  argsHash: string;
  /** Answer field paths this person may see; a grouped call can return more, and the service cuts to these. */
  fields: string[];
  release: { version: string; checksum: string };
  /** Seconds since the epoch. `exp - iat` is the scope lifetime, a setting of the service. */
  iat: number;
  exp: number;
  jti: string;
}

/** A scope as it goes on the wire: `header` is the value of `X-Caller-Scope`, `scope` is what it says (for the audit line). */
export interface SignedScope {
  header: string;
  scope: CallScope;
}

// The shapes below follow the dictionary schema's patterns, so the same word is valid in both places.
const Identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.\-]*$/, 'an id uses letters, digits and _ . -');
const ConnectorId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$/, 'a connector id uses lower-case letters, digits and -');
const ToolName = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_\-.]*$/, 'a tool name uses letters, digits and _ - .');
const GroupId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-.:]*[a-z0-9])?$/, 'a group id uses lower-case letters, digits and - . :');
const AnswerPath = z.string().min(1).max(120).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/, 'a path is names joined by dots');
/** Ids that come from outside (a person, a request): any visible text, no control characters. */
const OuterId = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, 'no control characters');
/** Release version and checksum, as the pack gives them. */
const ReleaseWord = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.+\-]*$/, 'letters, digits and _ . + -');
const Seconds = z.number().int().safe().nonnegative();

export const CallScopeSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  operation: z.enum(['read', 'command']).optional(),
  actionId: OuterId.optional(),
  tenantId: Identifier,
  environmentId: Identifier,
  queryId: Identifier,
  correlationId: OuterId,
  principal: z.object({
    id: OuterId,
    audience: z.enum(['staff', 'shopper']),
    groups: z.array(GroupId).max(50),
  }).strict(),
  connectorId: ConnectorId,
  connectionRef: OuterId.optional(),
  tool: ToolName,
  toolState: z.literal('allow'),
  toolStateVia: z.enum(['tool', 'default', 'none']),
  capRuleIds: z.array(Identifier).max(50),
  argsHash: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 hash in lower-case hex'),
  fields: z.array(AnswerPath).max(100),
  release: z.object({ version: ReleaseWord, checksum: ReleaseWord }).strict(),
  iat: Seconds,
  exp: Seconds,
  jti: Identifier,
}).strict().superRefine((scope, ctx) => {
  if (scope.operation === 'command' && (scope.v !== 2 || !scope.actionId)) ctx.addIssue({ code: 'custom', path: ['operation'], message: 'Commands require a V2 connection-bound action identity.' });
  if (scope.v === 1 && scope.principal.audience !== 'staff') ctx.addIssue({ code: 'custom', path: ['principal', 'audience'], message: 'V1 remains staff-only.' });
  if (scope.v === 1 && scope.connectionRef !== undefined) ctx.addIssue({ code: 'custom', path: ['connectionRef'], message: 'Use V2 for connection-bound grants.' });
  if (scope.v === 2 && (!scope.connectionRef || scope.exp - scope.iat > 60)) ctx.addIssue({ code: 'custom', path: ['v'], message: 'V2 requires an exact connection and a lifetime of at most 60 seconds.' });
}).refine((scope) => scope.exp > scope.iat, { path: ['exp'], message: 'A scope expires after it is issued.' });
