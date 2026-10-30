import type { ConnectorId, Environment, KeyEvidence, KeyKind, KeyKindDef, ThingName } from '../model';

/**
 * The key table: one row says "this identifier, held by this system, is that record". Identity is tenant, environment, thing and
 * canonical id. A name is only ever used to find candidates; the table holds identifiers and hashes, never names and never a readable
 * email address.
 */

export const KEY_ROLES = ['primary', 'division', 'alias'] as const;
/** `division`: a unit that belongs to a parent unit in the same system; it rolls up under the parent's canonical id. */
export type KeyRole = (typeof KEY_ROLES)[number];

export const KEY_STATUSES = ['matched', 'candidate', 'conflict', 'retired'] as const;
/** Only `matched` ever answers a question. `candidate`: the link rests on a name alone. `conflict`: the systems disagree. */
export type KeyStatus = (typeof KEY_STATUSES)[number];

export const KEY_EVIDENCE_VALUES: readonly KeyEvidence[] = ['real_field', 'text_note', 'tag', 'name_only'];

export type KeyCaseRule = KeyKindDef['caseRule'];

export interface KeyBuiltBy {
  runId: string;
  releaseVersion: string;
  releaseChecksum: string;
}

export interface KeyRow {
  tenantId: string;
  environmentId: Environment;
  thing: ThingName;
  canonicalId: string;
  system: ConnectorId;
  keyKind: KeyKind;
  /** The identifier as the key kind's case rule writes it. */
  systemKey: string;
  role: KeyRole;
  /** Required for a division, refused for every other role. */
  parentSystemKey?: string;
  evidence: KeyEvidence;
  status: KeyStatus;
  firstSeenAt: string;
  lastVerifiedAt: string;
  builtBy: KeyBuiltBy;
}

/** Every read and write names its tenant and environment, and the thing the canonical ids belong to. */
export interface KeyScope {
  tenantId: string;
  environmentId: Environment;
  thing: ThingName;
}

export const KEY_USES = ['number', 'own_id', 'reference'] as const;
/**
 * What an identifier means on a record:
 * - `number`: the value is the canonical id itself (in the key kind's case); the record claims that canonical id.
 * - `own_id`: the system's own id for the record. It claims nothing; other records may point at it.
 * - `reference`: the id of the same thing's record in another system. It is evidence for a cross-check, not a claim.
 */
export type KeyUse = (typeof KEY_USES)[number];

/** What the key code needs to know about one identifier a system holds. The mapping file supplies one per field. */
export interface KeyKindRule {
  kind: KeyKind;
  /** The system whose record holds the identifier. */
  system: ConnectorId;
  use: KeyUse;
  caseRule: KeyCaseRule;
  /** A regular expression, written as text, that a value written in the kind's case matches. */
  pattern?: string;
  /** False while the source field does not exist yet or the connector does not read it: the report ignores such a key. */
  ready: boolean;
}

/** One identifier read from a record. Absent, null and blank all mean "the record does not carry it". */
export interface KeySourceKey {
  keyKind: KeyKind;
  value?: string | number | null;
}

/** One record read from one system, reduced to what the key code needs. It carries no personal data. */
export interface KeySourceRecord {
  system: ConnectorId;
  /** The system's own id for the record. */
  recordId: string;
  /** A division names its parent's `recordId` (the parent's system key) in the same system. */
  parentSystemKey?: string;
  /** Only used to find "matched by name only" candidates. Never copied into a report or a key row. */
  name?: string;
  keys: KeySourceKey[];
}
