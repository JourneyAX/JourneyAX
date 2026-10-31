import { z } from 'zod';
import { KeyKindDefSchema } from '../model';
import type { ConnectorId, KeyKind, KeyKindDef, ThingName } from '../model';
import type { KeyCaseRule, KeyKindRule, KeyUse } from './types';

/**
 * The table of which platform field feeds which key kind, as data. The file lives in the dictionary folder; this module only parses and
 * checks it and hands out the pieces the dictionary and the key code need. It reads no file and names no platform: every platform word
 * is in the data.
 *
 * Each entry is a key kind definition (the shape a thing's `keyKinds` list holds) plus where the field is read and what it means on a
 * record. `ready: false` marks a field that is planned: it does not exist yet, or the connector does not read it.
 */

export const KEY_MAPPING_VERSION = '1.0.0' as const;

export interface KeyMappingEntry extends KeyKindDef {
  /** The field as the platform or its connector names it. */
  field: string;
  use: KeyUse;
  /** For a text note: a regular expression, written as text, with one capture group that holds the number. */
  extract?: { pattern: string };
  /** One plain line: where it is read and what to watch for. */
  note: string;
}

export interface KeyMapping {
  mappingVersion: typeof KEY_MAPPING_VERSION;
  thing: ThingName;
  /** The entry whose pattern and case rule write the canonical id. */
  canonical: { kind: KeyKind; system: ConnectorId };
  keys: KeyMappingEntry[];
  notes?: string;
}

const Line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*\S[^\r\n]*$/, 'one plain line, not blank');
const RegexSource = z.string().min(1).max(200).refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

/** The same cap as the list of key kinds a thing may hold. */
const MAX_KEYS = 20;

export const KeyMappingEntrySchema = z.object({
  ...KeyKindDefSchema.shape,
  field: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, 'a field name uses letters, digits, _ and .'),
  use: z.enum(['number', 'own_id', 'reference']),
  extract: z.object({ pattern: RegexSource }).strict().optional(),
  note: Line(300),
}).strict();

export const KeyMappingSchema = z.object({
  mappingVersion: z.literal(KEY_MAPPING_VERSION),
  thing: z.string().min(1).max(40).regex(/^[A-Z][A-Za-z0-9]*$/, 'a thing name starts with a capital letter and uses letters and digits'),
  canonical: z.object({
    kind: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, 'a key kind uses lower-case letters, digits and _'),
    system: z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$/, 'a connector id uses lower-case letters, digits and -'),
  }).strict(),
  keys: z.array(KeyMappingEntrySchema).min(1).max(MAX_KEYS),
  notes: z.string().max(2000).optional(),
}).strict();

const capturesOf = (source: string): number => (new RegExp(`${source}|`).exec('') ?? []).length - 1;

/** Plain-language problems in a mapping that the schema cannot see. Empty means the mapping is consistent. */
export function checkKeyMapping(mapping: KeyMapping): string[] {
  const problems: string[] = [];
  const kinds = new Set<string>();
  const fields = new Set<string>();
  mapping.keys.forEach((entry, index) => {
    const at = `keys[${index}] (${entry.system}, ${entry.field})`;
    const kindKey = `${entry.system}\u0000${entry.kind}`;
    if (kinds.has(kindKey)) problems.push(`${at}: the key kind ${entry.kind} is mapped twice for ${entry.system}.`);
    kinds.add(kindKey);
    const fieldKey = `${entry.system}\u0000${entry.field}`;
    if (fields.has(fieldKey)) problems.push(`${at}: the field is mapped twice for ${entry.system}.`);
    fields.add(fieldKey);
    if (entry.evidence === 'name_only') problems.push(`${at}: a name is not a mapped field; evidence name_only has no place in the mapping.`);
    if (entry.use === 'number' && entry.pattern === undefined) problems.push(`${at}: a field that holds the number needs a pattern.`);
    if (entry.evidence === 'tag' && entry.use !== 'number') problems.push(`${at}: a tag identifies the account by its number, so its use must be number.`);
    if (entry.evidence === 'text_note' && !entry.extract) problems.push(`${at}: a text note needs an extract pattern.`);
    if (entry.evidence !== 'text_note' && entry.extract) problems.push(`${at}: only a text note has an extract pattern.`);
    if (entry.extract && capturesOf(entry.extract.pattern) !== 1) problems.push(`${at}: the extract pattern must have exactly one capture group.`);
    if (entry.use === 'reference' && !mapping.keys.some((other) => other !== entry && other.use === 'own_id' && other.kind === entry.kind)) {
      problems.push(`${at}: a reference to ${entry.kind} has no own_id entry of that kind to be checked against.`);
    }
  });
  const canonical = mapping.keys.find((entry) => entry.kind === mapping.canonical.kind && entry.system === mapping.canonical.system);
  if (!canonical) problems.push(`canonical: no entry for ${mapping.canonical.kind} in ${mapping.canonical.system}.`);
  else if (canonical.use !== 'number') problems.push('canonical: the canonical entry must hold the number (use number).');
  return problems;
}

/** Reads a mapping from parsed JSON. Throws one error that lists every problem, schema and consistency alike. */
export function parseKeyMapping(raw: unknown): KeyMapping {
  const parsed = KeyMappingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The account key mapping is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join(' | ')}`);
  }
  const mapping = parsed.data as KeyMapping;
  const problems = checkKeyMapping(mapping);
  if (problems.length > 0) throw new Error(`The account key mapping is not consistent: ${problems.join(' | ')}`);
  return mapping;
}

/** The key kind definitions a thing's `keyKinds` list holds, in the file's order, without the extra mapping columns. */
export function keyKindDefsOf(mapping: KeyMapping): KeyKindDef[] {
  return mapping.keys.map((entry) => ({
    kind: entry.kind, system: entry.system, evidence: entry.evidence, ...(entry.pattern !== undefined ? { pattern: entry.pattern } : {}), caseRule: entry.caseRule, ready: entry.ready,
  }));
}

/** What the report and the resolver need to read each field. */
export function keyKindRulesOf(mapping: KeyMapping): KeyKindRule[] {
  return mapping.keys.map((entry) => ({
    kind: entry.kind, system: entry.system, use: entry.use, caseRule: entry.caseRule, ...(entry.pattern !== undefined ? { pattern: entry.pattern } : {}), ready: entry.ready,
  }));
}

/** The pattern and case that write the canonical id. */
export function canonicalRuleOf(mapping: KeyMapping): { caseRule: KeyCaseRule; pattern?: string } {
  const entry = mapping.keys.find((candidate) => candidate.kind === mapping.canonical.kind && candidate.system === mapping.canonical.system);
  if (!entry) throw new Error(`The mapping has no entry for the canonical key ${mapping.canonical.kind} in ${mapping.canonical.system}.`);
  return { caseRule: entry.caseRule, ...(entry.pattern !== undefined ? { pattern: entry.pattern } : {}) };
}
