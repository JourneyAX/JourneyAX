import type { ConnectorId, Environment, KeyKind, ThingName } from '../model';
import { MAX_PATTERN_INPUT_LENGTH } from './normalise';
import { KEY_EVIDENCE_VALUES, KEY_ROLES, KEY_STATUSES } from './types';
import type { KeyRow, KeyScope } from './types';

/**
 * The key table's port. Every read and write names its tenant and environment. The two uniqueness rules are code here, not only
 * database indexes, because a test database cannot model a partial index and the real one should repeat the same checks:
 * - U1: a system record belongs to exactly one canonical id. Unique on (tenant, environment, thing, system, key kind, system key).
 * - U2: a canonical id has one primary key per system and key kind. Unique on (tenant, environment, thing, canonical id, system,
 *   key kind), but only among rows whose role is `primary` and whose status is `matched`; divisions and aliases may repeat.
 */

export type KeyRuleName = 'shape' | 'U1' | 'U2';

/** Why a write was refused. The message holds field names and canonical ids only, never a value that could be personal data. */
export interface KeyProblem {
  rule: KeyRuleName;
  /** The position of the row in the batch, when the problem belongs to one. */
  index?: number;
  message: string;
}

export type KeyWriteResult =
  | { ok: true; inserted: number; updated: number }
  | { ok: false; problem: KeyProblem };

export interface KeyRepository {
  /** The row for one system key, in any status, or undefined. At most one exists (U1). */
  findBySystemKey(scope: KeyScope, system: ConnectorId, keyKind: KeyKind, systemKey: string): Promise<KeyRow | undefined>;
  /** Every row of one canonical id, in any status, in a fixed order. */
  findByCanonicalId(scope: KeyScope, canonicalId: string): Promise<KeyRow[]>;
  /**
   * Adds or refreshes rows, all or nothing: if one row is malformed or breaks U1 or U2, nothing is written. A row for a system key that
   * already has a live row of the same canonical id refreshes it (the earlier `firstSeenAt` is kept); a retired row at the same key is
   * replaced. A live row of another canonical id is never taken over: retire it first.
   */
  upsertMany(rows: KeyRow[]): Promise<KeyWriteResult>;
  /** Marks every live row built by one run as retired. Returns how many. */
  retireRun(tenantId: string, environmentId: Environment, runId: string): Promise<number>;
  /**
   * The deletion path: removes every row of one account in this tenant and environment: the account's own rows and, for each thing named
   * in `keyedUnder`, the rows whose canonical id was made under the account (a contact). Returns how many.
   */
  deleteByAccount(scope: KeyScope, accountCanonicalId: string, keyedUnder?: ThingName[]): Promise<number>;
}

const ROW_FIELDS: ReadonlySet<string> = new Set([
  'tenantId', 'environmentId', 'thing', 'canonicalId', 'system', 'keyKind', 'systemKey', 'role', 'parentSystemKey', 'evidence', 'status',
  'firstSeenAt', 'lastVerifiedAt', 'builtBy',
]);
const BUILT_BY_FIELDS: ReadonlySet<string> = new Set(['runId', 'releaseVersion', 'releaseChecksum']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY_VALUE_FIELDS = ['canonicalId', 'systemKey', 'parentSystemKey'] as const;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The shape of a key row, as a list of problems (empty means fine). It refuses a field it does not know, so a name or an email address
 * cannot ride along, and refuses any text that looks like an email address: a contact is keyed by a hash.
 */
export function checkKeyRow(row: unknown): string[] {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['A key row is an object.'];
  const record = row as Record<string, unknown>;
  const problems: string[] = [];
  for (const name of Object.keys(record)) if (!ROW_FIELDS.has(name)) problems.push(`A key row has no field called ${name}.`);
  for (const name of ['tenantId', 'environmentId', 'thing', 'canonicalId', 'system', 'keyKind', 'systemKey'] as const) {
    if (!isText(record[name])) problems.push(`${name} is required.`);
  }
  for (const name of KEY_VALUE_FIELDS) {
    const value = record[name];
    if (typeof value === 'string' && value.length > MAX_PATTERN_INPUT_LENGTH) problems.push(`${name} is longer than the longest text a key pattern is applied to.`);
  }
  if (!(KEY_ROLES as readonly unknown[]).includes(record.role)) problems.push('role must be primary, division or alias.');
  if (!(KEY_STATUSES as readonly unknown[]).includes(record.status)) problems.push('status must be matched, candidate, conflict or retired.');
  if (!(KEY_EVIDENCE_VALUES as readonly unknown[]).includes(record.evidence)) problems.push('evidence must be real_field, text_note, tag or name_only.');
  if (record.evidence === 'name_only' && record.status !== 'candidate' && record.status !== 'retired') {
    problems.push('A link that rests on a name alone is only ever a candidate.');
  }
  if (record.role === 'division') {
    if (!isText(record.parentSystemKey)) problems.push('A division names its parent in parentSystemKey.');
  } else if (record.parentSystemKey !== undefined) problems.push('Only a division has a parentSystemKey.');
  for (const name of ['firstSeenAt', 'lastVerifiedAt'] as const) {
    const value = record[name];
    if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) problems.push(`${name} must be a time like 2026-10-29T09:30:00Z.`);
  }
  const builtBy = record.builtBy;
  if (!builtBy || typeof builtBy !== 'object' || Array.isArray(builtBy)) problems.push('builtBy is required.');
  else {
    for (const name of Object.keys(builtBy)) if (!BUILT_BY_FIELDS.has(name)) problems.push(`builtBy has no field called ${name}.`);
    for (const name of BUILT_BY_FIELDS) if (!isText((builtBy as Record<string, unknown>)[name])) problems.push(`builtBy.${name} is required.`);
  }
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.includes('@')) problems.push(`${name} looks like an email address; a contact is keyed by contactKeyHash, never by the address.`);
  }
  return problems;
}

/** The identity of a system record, the columns of U1. */
export function systemKeyId(row: Pick<KeyRow, 'tenantId' | 'environmentId' | 'thing' | 'system' | 'keyKind' | 'systemKey'>): string {
  return JSON.stringify([row.tenantId, row.environmentId, row.thing, row.system, row.keyKind, row.systemKey]);
}

/** The identity of a canonical id, the leading columns of U2 and of the fan-out lookup. */
export function canonicalKeyId(row: Pick<KeyRow, 'tenantId' | 'environmentId' | 'thing' | 'canonicalId'>): string {
  return JSON.stringify([row.tenantId, row.environmentId, row.thing, row.canonicalId]);
}

const isLive = (row: KeyRow): boolean => row.status !== 'retired';
const isMatchedPrimary = (row: KeyRow): boolean => row.role === 'primary' && row.status === 'matched';

/**
 * U1 and U2 as code. `existing` holds the stored rows that could clash with `row`: the row at the same system key and the rows of the
 * same canonical id (more rows are harmless). The row at the same system key is the row being refreshed, so it is never a U2 clash with
 * itself. Returns the first problem, or undefined when the row may be written.
 */
export function checkKeyUniqueness(row: KeyRow, existing: Iterable<KeyRow>): KeyProblem | undefined {
  const sameKey = systemKeyId(row);
  for (const other of existing) {
    if (other.tenantId !== row.tenantId || other.environmentId !== row.environmentId || other.thing !== row.thing) continue;
    if (systemKeyId(other) === sameKey) {
      if (isLive(other) && other.canonicalId !== row.canonicalId) {
        return { rule: 'U1', message: `U1: this ${row.system} ${row.keyKind} already belongs to ${other.canonicalId}, so it cannot also belong to ${row.canonicalId}. Retire the earlier row first.` };
      }
      continue;
    }
    if (isMatchedPrimary(row) && isMatchedPrimary(other) && other.canonicalId === row.canonicalId && other.system === row.system && other.keyKind === row.keyKind) {
      return { rule: 'U2', message: `U2: ${row.canonicalId} already has a matched primary ${row.keyKind} in ${row.system}; a second one needs the role alias or division.` };
    }
  }
  return undefined;
}
