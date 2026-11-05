import type { ConnectorId, KeyKind, ThingName } from '../model';
import { applyCaseRule, compareIds, normaliseKeyValue, normaliseName } from './normalise';
import type { KeyCaseRule, KeyKindRule, KeySourceRecord } from './types';

/**
 * The key report: what a person reads before any key row is written. Records from the systems go in; every record and every canonical id
 * comes out in one of four categories. Nothing here fixes anything, picks between two answers or reads a vendor. The report holds record
 * ids and canonical ids only: no names, no values from a free-text field, no personal data.
 */

export const KEY_REPORT_CATEGORIES = ['unmatched', 'matched_twice', 'name_only', 'ok'] as const;
export type KeyReportCategory = (typeof KEY_REPORT_CATEGORIES)[number];

export type KeyReportReason =
  | 'source_record_without_id'
  | 'canonical_missing_in_system'
  | 'number_only_in_one_system'
  | 'duplicate_in_system'
  | 'disagree'
  | 'name_only'
  | 'ok';

/** Which category each reason belongs to, and the plain term a loader prints for it. */
export const KEY_REPORT_REASONS: Record<KeyReportReason, { category: KeyReportCategory; term: string }> = {
  source_record_without_id: { category: 'unmatched', term: 'No id' },
  canonical_missing_in_system: { category: 'unmatched', term: 'Missing in a system' },
  number_only_in_one_system: { category: 'unmatched', term: 'Number only in one system' },
  duplicate_in_system: { category: 'matched_twice', term: 'Duplicate' },
  disagree: { category: 'matched_twice', term: 'Disagree' },
  name_only: { category: 'name_only', term: 'Matched only by name' },
  ok: { category: 'ok', term: 'OK' },
};

export interface KeyReportOptions {
  thing: ThingName;
  /** The systems where a record should exist. */
  expectedIn: ConnectorId[];
  /** One rule per identifier a system holds (the platform mapping supplies them). */
  kinds: KeyKindRule[];
  /** How the canonical id is written. */
  canonical: { caseRule: KeyCaseRule; pattern?: string };
}

export interface KeyReportRecord {
  system: ConnectorId;
  recordId: string;
  role?: 'division';
  parentSystemKey?: string;
}

export interface KeyReportItem {
  category: KeyReportCategory;
  reason: KeyReportReason;
  /** One id for most reasons; the ids in dispute for `disagree`; the candidates for `name_only`; none for `source_record_without_id`. */
  canonicalIds: string[];
  records: KeyReportRecord[];
  /** The expected systems that hold no record of the canonical id. */
  missingFrom?: ConnectorId[];
}

export interface KeyReport {
  thing: ThingName;
  items: KeyReportItem[];
  counts: Record<KeyReportCategory, number>;
  /** Plain sentences about input the report could not use. They name systems, record ids and key kinds, never a value. */
  warnings: string[];
}

interface Read {
  record: KeySourceRecord;
  ref: KeyReportRecord;
  /** The canonical ids this record's own number fields claim. */
  claims: Set<string>;
  /** `claims`, or for a division with none, its parent's. */
  effective: Set<string>;
  own: Array<{ kind: KeyKind; value: string }>;
  refs: Array<{ kind: KeyKind; value: string }>;
  division: boolean;
  held: boolean;
}

const idOf = (system: string, id: string): string => `${system}\u0000${id}`;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((value) => b.has(value));
const disjoint = (a: Set<string>, b: Set<string>): boolean => ![...a].some((value) => b.has(value));
const refKey = (ref: KeyReportRecord): string => idOf(ref.system, ref.recordId);
const byRef = (a: KeyReportRecord, b: KeyReportRecord): number => compareIds(refKey(a), refKey(b));

const itemOf = (reason: KeyReportReason, canonicalIds: Iterable<string>, reads: Read[], missingFrom?: ConnectorId[]): KeyReportItem => ({
  category: KEY_REPORT_REASONS[reason].category,
  reason,
  canonicalIds: sorted(canonicalIds),
  records: reads.map((read) => read.ref).sort(byRef),
  ...(missingFrom ? { missingFrom } : {}),
});

function compareItems(a: KeyReportItem, b: KeyReportItem): number {
  return KEY_REPORT_CATEGORIES.indexOf(a.category) - KEY_REPORT_CATEGORIES.indexOf(b.category)
    || compareIds(a.reason, b.reason)
    || compareIds(a.canonicalIds.join('|'), b.canonicalIds.join('|'))
    || compareIds((a.missingFrom ?? []).join('|'), (b.missingFrom ?? []).join('|'))
    || compareIds(a.records.map(refKey).join('|'), b.records.map(refKey).join('|'));
}

/**
 * Sorts source records into the report's categories:
 * - **unmatched**: a record with no usable number (`source_record_without_id`; a missing value is absent, never zero); a number only one
 *   system holds (`number_only_in_one_system`); a number some expected system lacks (`canonical_missing_in_system`).
 * - **matched_twice**: two records of one system claim one number, not counting a division (`duplicate_in_system`); or one record claims
 *   two numbers, or a record and a record it points at claim different ones (`disagree`). Held back: nothing about them is `ok`.
 * - **name_only**: a record with no number whose normalised name equals that of a numbered record in another system. Never used to answer.
 * - **ok**: the number is held by every expected system and nothing disputes it.
 * A division (a record that names a parent) rolls up under its parent's number. The result does not depend on the order of the input.
 *
 * The Salesforce backfill's words are read from the items, not stored in them: OK is `ok`; Disagree is `disagree`; Duplicate is
 * `duplicate_in_system`; No note is `source_record_without_id` on a Salesforce record; Number only in Salesforce is
 * `number_only_in_one_system` whose one record is in Salesforce; Missing in Salesforce is any item whose `missingFrom` names Salesforce.
 * A number in dispute appears in the item that disputes it; the other records that carry it are not listed again.
 */
export function buildKeyReport(records: KeySourceRecord[], options: KeyReportOptions): KeyReport {
  const rules = new Map(options.kinds.map((rule) => [idOf(rule.system, rule.kind), rule] as const));
  const warnings = new Set<string>();
  const reads: Read[] = [];
  const byRecord = new Map<string, Read>();

  for (const record of records) {
    const id = idOf(record.system, record.recordId);
    if (byRecord.has(id)) {
      warnings.add(`${record.system} ${record.recordId} is listed more than once; the first is used.`);
      continue;
    }
    const read: Read = {
      record,
      ref: { system: record.system, recordId: record.recordId, ...(record.parentSystemKey ? { role: 'division' as const, parentSystemKey: record.parentSystemKey } : {}) },
      claims: new Set(), effective: new Set(), own: [], refs: [], division: Boolean(record.parentSystemKey), held: false,
    };
    for (const key of record.keys) {
      const rule = rules.get(idOf(record.system, key.keyKind));
      if (!rule) {
        warnings.add(`${record.system}: the key kind ${key.keyKind} is not in the mapping and was ignored.`);
        continue;
      }
      if (!rule.ready) {
        warnings.add(`${record.system}: the key kind ${key.keyKind} is not read yet (ready is false) and was ignored.`);
        continue;
      }
      const checked = normaliseKeyValue(key.value, rule);
      if (checked.ok === false) {
        if (checked.reason !== 'absent') warnings.add(`${record.system} ${record.recordId}: ${key.keyKind} is not a usable value (${checked.reason === 'too_long' ? 'too long' : 'wrong shape'}).`);
        continue;
      }
      if (rule.use === 'own_id') read.own.push({ kind: key.keyKind, value: checked.value });
      else if (rule.use === 'reference') read.refs.push({ kind: key.keyKind, value: checked.value });
      else {
        const canonical = normaliseKeyValue(applyCaseRule(checked.value, options.canonical.caseRule), options.canonical);
        if (canonical.ok) read.claims.add(canonical.value);
        else warnings.add(`${record.system} ${record.recordId}: ${key.keyKind} does not read as a canonical id.`);
      }
    }
    reads.push(read);
    byRecord.set(id, read);
  }

  const effectiveOf = (read: Read, seen: Set<Read> = new Set()): Set<string> => {
    if (read.claims.size > 0) return read.claims;
    if (!read.record.parentSystemKey || seen.has(read)) return new Set();
    seen.add(read);
    const parent = byRecord.get(idOf(read.record.system, read.record.parentSystemKey));
    return parent ? effectiveOf(parent, seen) : new Set();
  };
  for (const read of reads) read.effective = effectiveOf(read);

  const items: KeyReportItem[] = [];
  const disputes = new Set<string>();
  const dispute = (pair: Read[]): void => {
    const key = pair.map((read) => refKey(read.ref)).sort().join('\u0001');
    if (disputes.has(key)) return;
    disputes.add(key);
    items.push(itemOf('disagree', pair.flatMap((read) => [...read.effective]), pair));
    for (const read of pair) read.held = true;
  };

  // One record claims two numbers.
  for (const read of reads) if (read.claims.size > 1) dispute([read]);

  // A division claims a number its parent does not.
  for (const read of reads) {
    const parent = read.record.parentSystemKey ? byRecord.get(idOf(read.record.system, read.record.parentSystemKey)) : undefined;
    if (parent && read.claims.size === 1 && parent.effective.size > 0 && !sameSet(read.claims, parent.effective)) dispute([read, parent]);
  }

  // A record points at another system's record that claims a different number.
  const owners = new Map<string, Read[]>();
  for (const read of reads) for (const own of read.own) owners.set(idOf(own.kind, own.value), [...(owners.get(idOf(own.kind, own.value)) ?? []), read]);
  for (const read of reads) {
    for (const reference of read.refs) {
      for (const target of owners.get(idOf(reference.kind, reference.value)) ?? []) {
        if (target !== read && read.effective.size > 0 && target.effective.size > 0 && disjoint(read.effective, target.effective)) dispute([read, target]);
      }
    }
  }

  // Two records of one system claim one number. A division is not a second record of its parent.
  const claimants = new Map<string, Read[]>();
  for (const read of reads) {
    if (read.held || read.division || read.effective.size !== 1) continue;
    const key = idOf(read.record.system, [...read.effective][0]);
    claimants.set(key, [...(claimants.get(key) ?? []), read]);
  }
  for (const group of claimants.values()) {
    if (group.length < 2) continue;
    items.push(itemOf('duplicate_in_system', group[0].effective, group));
    for (const read of group) read.held = true;
  }

  // A record with no number: matched only by name, or simply without an id.
  const namesOf = new Map<string, Read[]>();
  for (const read of reads) {
    const name = read.record.name === undefined ? '' : normaliseName(read.record.name);
    if (name !== '' && read.effective.size > 0) namesOf.set(name, [...(namesOf.get(name) ?? []), read]);
  }
  for (const read of reads) {
    if (read.effective.size > 0) continue;
    const name = read.record.name === undefined ? '' : normaliseName(read.record.name);
    const same = (name === '' ? [] : namesOf.get(name) ?? []).filter((other) => other.record.system !== read.record.system);
    if (same.length > 0) items.push(itemOf('name_only', same.flatMap((other) => [...other.effective]), [read]));
    else items.push(itemOf('source_record_without_id', [], [read]));
  }

  // Every number nobody disputes: held by all the expected systems, by one only, or by some.
  const disputed = new Set(reads.filter((read) => read.held).flatMap((read) => [...read.effective]));
  const holders = new Map<string, Read[]>();
  for (const read of reads) {
    if (read.held || read.effective.size !== 1) continue;
    const canonicalId = [...read.effective][0];
    holders.set(canonicalId, [...(holders.get(canonicalId) ?? []), read]);
  }
  for (const [canonicalId, group] of holders) {
    if (disputed.has(canonicalId)) continue;
    const systems = new Set(group.map((read) => read.record.system));
    const missing = options.expectedIn.filter((system) => !systems.has(system));
    if (missing.length === 0) items.push(itemOf('ok', [canonicalId], group));
    else if (systems.size === 1) items.push(itemOf('number_only_in_one_system', [canonicalId], group, missing));
    else for (const system of missing) items.push(itemOf('canonical_missing_in_system', [canonicalId], group, [system]));
  }

  items.sort(compareItems);
  const counts: Record<KeyReportCategory, number> = { unmatched: 0, matched_twice: 0, name_only: 0, ok: 0 };
  for (const item of items) counts[item.category]++;
  return { thing: options.thing, items, counts, warnings: [...warnings].sort() };
}
