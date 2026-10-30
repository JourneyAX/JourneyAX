import { UNATTRIBUTED_PRINCIPAL } from '@journeyax/shared-types';
import type { ZodType } from 'zod';
import { BindingSchema, ThingDefSchema, WhoClauseSchema } from '../model';
import type { ConnectorId, FactPath, ThingName } from '../model';
import { isJaxIqErrorCode } from '../errors/codes';
import type { JaxIqErrorCode } from '../errors/codes';

const OPS = ['find', 'get', 'related', 'explain'] as const;
const OUTCOMES = ['answered', 'partial', 'refused', 'ambiguous', 'none', 'error'] as const;
const SYSTEM_OUTCOMES = ['success', 'failed', 'skipped', 'cached'] as const;
const RESOLVED_BY = ['key', 'exact_name', 'candidate_list', 'none'] as const;
const AUDIENCES = ['shopper', 'staff'] as const;

export type JaxIqAuditOp = (typeof OPS)[number];
export type JaxIqAuditOutcome = (typeof OUTCOMES)[number];
export type JaxIqAuditSystemOutcome = (typeof SYSTEM_OUTCOMES)[number];
export type JaxIqResolvedBy = (typeof RESOLVED_BY)[number];
export type JaxIqAuditAudience = (typeof AUDIENCES)[number];

/** A line lists no more fact names than a release block may hold facts, and no more calls than it may hold bindings (the model schema's caps). */
export const AUDIT_FACT_NAME_CAP = 3000;
export const AUDIT_CALL_CAP = 5000;

/** One call to one tool of one system. */
export interface JaxIqAuditSystem {
  system: ConnectorId;
  tool: string;
  outcome: JaxIqAuditSystemOutcome;
  errorType?: JaxIqErrorCode;
  durationMs: number;
  attempts: number;
}

/** The id of the signed scope one call carried, so a connector-side audit can be joined to this line. */
export interface JaxIqAuditScopeJti {
  system: ConnectorId;
  tool: string;
  jti: string;
}

/**
 * One line per query. It holds names, codes and counts: never an argument, a fact value, a vendor's words or an address. The line
 * is for operators; `factsDenied` is internal and is never sent back to the caller.
 */
export interface JaxIqAuditLine {
  at: string;
  tenantId: string;
  environmentId: string;
  correlationId: string;
  queryId: string;
  op: JaxIqAuditOp;
  /** The platform's unattributed name when the call carried no person. */
  principalId: string;
  /** Absent when the call carried no person. */
  audience?: JaxIqAuditAudience;
  groups: string[];
  /** Absent when the request named no thing the dictionary knows. */
  thing?: ThingName;
  canonicalId?: string;
  resolvedBy: JaxIqResolvedBy;
  factsRead: FactPath[];
  factsUnavailable: FactPath[];
  factsDenied: FactPath[];
  systems: JaxIqAuditSystem[];
  scopeJtis: JaxIqAuditScopeJti[];
  outcome: JaxIqAuditOutcome;
  errorType?: JaxIqErrorCode;
  /** Absent when the call was answered before any release was loaded. */
  release?: { version: string; checksum: string };
  durationMs: number;
}

/** What `buildAuditLine` is given. Anything beyond these fields is ignored, so a caller can hand over a larger record without leaking it. */
export interface JaxIqAuditLineInput {
  at: Date;
  tenantId: string;
  environmentId: string;
  correlationId: string;
  queryId: string;
  op: JaxIqAuditOp;
  principalId?: string;
  audience?: JaxIqAuditAudience;
  groups?: string[];
  thing?: ThingName;
  canonicalId?: string;
  resolvedBy?: JaxIqResolvedBy;
  factsRead?: FactPath[];
  factsUnavailable?: FactPath[];
  factsDenied?: FactPath[];
  systems?: JaxIqAuditSystem[];
  scopeJtis?: JaxIqAuditScopeJti[];
  outcome: JaxIqAuditOutcome;
  errorType?: JaxIqErrorCode;
  release?: { version: string; checksum: string };
  durationMs: number;
}

/** A name is a name by the model schema's own patterns. */
const matches = (schema: ZodType) => (value: unknown): value is string => typeof value === 'string' && schema.safeParse(value).success;
const isThing = matches(ThingDefSchema.shape.thing);
const isFactPath = matches(ThingDefSchema.shape.labelFact);
const isSystem = matches(ThingDefSchema.shape.expectedIn.element);
const isTool = matches(BindingSchema.shape.tool);
const isGroup = matches(WhoClauseSchema.shape.groups.element);

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** An identifier has no space and no control character, so a person's name or a sentence is not one. */
const IDENTIFIER = /^[^\s\u0000-\u001f\u007f]+$/;
const identifier = (value: unknown): string | undefined => (typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined);
const INVALID_IDENTIFIER = 'invalid';

const wholeNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/** The valid names of a list, each once, in a fixed order. A name in `without` is left out. */
function allNames(values: unknown, valid: (value: unknown) => value is string, without?: ReadonlySet<string>): string[] {
  const kept = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) if (valid(value) && !without?.has(value)) kept.add(value);
  return [...kept].sort();
}

/** The same, up to the cap. */
const names = (values: unknown, valid: (value: unknown) => value is string, without?: ReadonlySet<string>): string[] =>
  allNames(values, valid, without).slice(0, AUDIT_FACT_NAME_CAP);

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

function systemEntry(entry: unknown): JaxIqAuditSystem | undefined {
  const raw = objectOf(entry);
  if (!isSystem(raw.system) || !isTool(raw.tool) || !oneOf(SYSTEM_OUTCOMES, raw.outcome)) return undefined;
  return {
    system: raw.system, tool: raw.tool, outcome: raw.outcome,
    ...(isJaxIqErrorCode(raw.errorType) ? { errorType: raw.errorType } : {}),
    durationMs: wholeNumber(raw.durationMs), attempts: wholeNumber(raw.attempts),
  };
}

function jtiEntry(entry: unknown): JaxIqAuditScopeJti | undefined {
  const raw = objectOf(entry);
  const jti = identifier(raw.jti);
  return isSystem(raw.system) && isTool(raw.tool) && jti !== undefined ? { system: raw.system, tool: raw.tool, jti } : undefined;
}

const entries = <T>(values: unknown, read: (entry: unknown) => T | undefined): T[] =>
  (Array.isArray(values) ? values : []).map(read).filter((entry): entry is T => entry !== undefined).slice(0, AUDIT_CALL_CAP);

/**
 * Builds the audit line of one query from what the query knows, and nothing else. Every field is copied by name from the input: a
 * name that is not a name (a value put in a name's place) is left out, an identifier that is not one becomes `invalid`, errors are
 * codes from the closed list, and there is no field for an argument, a value or a message. A fact the person may not see is listed
 * once, in `factsDenied`, and is removed from the other two lists. An `op` or `outcome` outside the closed lists, or a time that is
 * not a time, throws: the types do not allow them.
 */
export function buildAuditLine(input: JaxIqAuditLineInput): JaxIqAuditLine {
  if (!oneOf(OPS, input.op)) throw new TypeError('An audit line needs one of the four operations.');
  if (!oneOf(OUTCOMES, input.outcome)) throw new TypeError('An audit line needs one of the six outcomes.');
  const at = input.at.toISOString();
  // The set is made before the list is cut, so a denied name that does not fit on the line is still taken out of the other two lists.
  const deniedAll = allNames(input.factsDenied, isFactPath);
  const factsDenied = deniedAll.slice(0, AUDIT_FACT_NAME_CAP);
  const denied = new Set(deniedAll);
  const thing = isThing(input.thing) ? input.thing : undefined;
  const canonicalId = identifier(input.canonicalId);
  const release = objectOf(input.release);
  const version = identifier(release.version);
  const checksum = identifier(release.checksum);
  return {
    at,
    tenantId: identifier(input.tenantId) ?? INVALID_IDENTIFIER,
    environmentId: identifier(input.environmentId) ?? INVALID_IDENTIFIER,
    correlationId: identifier(input.correlationId) ?? INVALID_IDENTIFIER,
    queryId: identifier(input.queryId) ?? INVALID_IDENTIFIER,
    op: input.op,
    principalId: input.principalId === undefined ? UNATTRIBUTED_PRINCIPAL : identifier(input.principalId) ?? INVALID_IDENTIFIER,
    ...(oneOf(AUDIENCES, input.audience) ? { audience: input.audience } : {}),
    groups: names(input.groups, isGroup),
    ...(thing ? { thing } : {}),
    ...(canonicalId ? { canonicalId } : {}),
    resolvedBy: oneOf(RESOLVED_BY, input.resolvedBy) ? input.resolvedBy : 'none',
    factsRead: names(input.factsRead, isFactPath, denied),
    factsUnavailable: names(input.factsUnavailable, isFactPath, denied),
    factsDenied,
    systems: entries(input.systems, systemEntry),
    scopeJtis: entries(input.scopeJtis, jtiEntry),
    outcome: input.outcome,
    ...(isJaxIqErrorCode(input.errorType) ? { errorType: input.errorType } : {}),
    ...(version && checksum ? { release: { version, checksum } } : {}),
    durationMs: wholeNumber(input.durationMs),
  };
}
