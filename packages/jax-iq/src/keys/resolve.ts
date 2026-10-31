import type { ConnectorId, KeyEvidence, KeyKind } from '../model';
import { compareIds, nameContainsWords, nameWords, normaliseKeyValue, MAX_PATTERN_INPUT_LENGTH } from './normalise';
import type { KeyRepository } from './repository';
import type { KeyKindRule, KeyRow, KeyScope, KeyStatus } from './types';

/**
 * Who is "the one"? A name only finds candidates; it never decides on its own. The answer is `one` in two cases only:
 * - a key was given and its key row is `matched`; or
 * - a name was given, every system where a record should exist answered, no answer was cut, and the name-matching hits join through the
 *   key table to exactly one canonical id, every joined row `matched`.
 * Anything else with something to show is `several`, with a note naming what was missing. Nothing here chooses between candidates: the
 * list is sorted only so that the same input gives the same output.
 */

export type ResolveOutcome = 'one' | 'several' | 'none' | 'refused';

/** Why a request could not be tried at all. */
export type ResolveRefusal = 'no_words' | 'unknown_key_kind' | 'key_not_ready' | 'bad_key_value';

/** `none`: there is no live key row. */
export type ResolveStatus = KeyStatus | 'none';

export interface ResolveDeps {
  repository: KeyRepository;
  scope: KeyScope;
  /** One rule per identifier a system holds (the platform mapping supplies them). */
  kinds: KeyKindRule[];
}

/** One record a system returned for a name search, identified by the key kind that names the record in that system. */
export interface ResolveSystemHit {
  keyKind: KeyKind;
  systemKey: string;
  /** Only compared with the words asked for. It is never copied into the result or stored. */
  name: string;
}

export interface ResolveSystemAnswer {
  system: ConnectorId;
  /** False: the system did not answer (down, blocked, not set up). Its hits are ignored. */
  answered: boolean;
  /** True: the system said there were more matches than it returned, or its answer was cut. */
  cut?: boolean;
  hits: ResolveSystemHit[];
}

export type ResolveRequest =
  | { by: 'key'; keyKind: KeyKind; value: unknown }
  | { by: 'name'; words: string; expectedIn: ConnectorId[]; answers: ResolveSystemAnswer[] };

export interface ResolveKeyRef {
  system: ConnectorId;
  keyKind: KeyKind;
  systemKey: string;
}

export interface ResolveCandidate {
  /** Null: found in a system but not in the key table. */
  canonicalId: string | null;
  /** The weakest status among the rows that joined; `none` when no live row did. */
  status: ResolveStatus;
  evidence: KeyEvidence[];
  systems: ResolveKeyRef[];
}

export interface ResolveResult {
  by: 'key' | 'name';
  outcome: ResolveOutcome;
  /** Set only when the outcome is `one`. */
  canonicalId?: string;
  candidates: ResolveCandidate[];
  /** Hits whose name does not carry the words (for example a match through a contact). Left out of the candidates, listed here. */
  setAside: ResolveKeyRef[];
  /** Systems where a record should exist and that did not answer. */
  missing: ConnectorId[];
  /** Systems whose answer was cut. */
  cut: ConnectorId[];
  /** Plain sentences naming what was missing or doubtful. They name systems and key kinds, never a value. */
  notes: string[];
  refusal?: ResolveRefusal;
}

const STATUS_ORDER: readonly ResolveStatus[] = ['matched', 'candidate', 'conflict', 'none'];
const weakest = (statuses: ResolveStatus[]): ResolveStatus => statuses.reduce((worst, status) => (STATUS_ORDER.indexOf(status) > STATUS_ORDER.indexOf(worst) ? status : worst), 'matched' as ResolveStatus);
const unique = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort(compareIds);
const byRef = (a: ResolveKeyRef, b: ResolveKeyRef): number => compareIds(`${a.system}\u0000${a.keyKind}\u0000${a.systemKey}`, `${b.system}\u0000${b.keyKind}\u0000${b.systemKey}`);

function refused(by: 'key' | 'name', refusal: ResolveRefusal, note: string): ResolveResult {
  return { by, outcome: 'refused', candidates: [], setAside: [], missing: [], cut: [], notes: [note], refusal };
}

function candidateOf(rows: KeyRow[], refs: ResolveKeyRef[]): ResolveCandidate {
  return {
    canonicalId: rows[0]?.canonicalId ?? null,
    status: rows.length === 0 ? 'none' : weakest(rows.map((row) => row.status)),
    evidence: unique(rows.map((row) => row.evidence)),
    systems: [...refs].sort(byRef),
  };
}

/** The notes that explain why a candidate list is not a single, confirmed account. */
function doubtNotes(candidates: ResolveCandidate[]): string[] {
  const notes: string[] = [];
  if (candidates.filter((candidate) => candidate.canonicalId !== null).length > 1) notes.push('More than one account fits.');
  for (const candidate of candidates) {
    const systems = unique(candidate.systems.map((ref) => ref.system)).join(', ');
    if (candidate.canonicalId === null) notes.push(`${systems} returned a record that is not in the key table.`);
    else if (candidate.status === 'candidate') notes.push(`The link in ${systems} rests on a name alone and needs a person to confirm it.`);
    else if (candidate.status === 'conflict') notes.push(`The systems disagree about the record in ${systems}, so the link is held back.`);
  }
  return [...new Set(notes)];
}

async function resolveByKey(deps: ResolveDeps, request: Extract<ResolveRequest, { by: 'key' }>): Promise<ResolveResult> {
  const lookups = deps.kinds.filter((rule) => rule.kind === request.keyKind && rule.use !== 'reference');
  if (lookups.length === 0) return refused('key', 'unknown_key_kind', `${request.keyKind} is not a key that names a record, so it cannot be looked up.`);
  const ready = lookups.filter((rule) => rule.ready);
  if (ready.length === 0) return refused('key', 'key_not_ready', `${request.keyKind} is planned but no system holds it yet.`);

  const rows: KeyRow[] = [];
  const refs: ResolveKeyRef[] = [];
  let readable = 0;
  for (const rule of ready) {
    const checked = normaliseKeyValue(request.value, rule);
    if (!checked.ok) continue;
    readable++;
    const row = await deps.repository.findBySystemKey(deps.scope, rule.system, rule.kind, checked.value);
    if (row && row.status !== 'retired') {
      rows.push(row);
      refs.push({ system: rule.system, keyKind: rule.kind, systemKey: row.systemKey });
    }
  }
  if (readable === 0) return refused('key', 'bad_key_value', `That is not a usable ${request.keyKind}.`);
  if (rows.length === 0) {
    const systems = unique(ready.map((rule) => rule.system)).join(', ');
    return { by: 'key', outcome: 'none', candidates: [], setAside: [], missing: [], cut: [], notes: [`No key row holds that ${request.keyKind} in ${systems}.`] };
  }

  const groups = new Map<string, { rows: KeyRow[]; refs: ResolveKeyRef[] }>();
  rows.forEach((row, index) => {
    const group = groups.get(row.canonicalId) ?? { rows: [], refs: [] };
    group.rows.push(row);
    group.refs.push(refs[index]);
    groups.set(row.canonicalId, group);
  });
  const candidates = [...groups.values()].map((group) => candidateOf(group.rows, group.refs)).sort((a, b) => compareIds(a.canonicalId ?? '', b.canonicalId ?? ''));
  const [only] = candidates;
  if (candidates.length === 1 && only.canonicalId !== null && only.status === 'matched') {
    return { by: 'key', outcome: 'one', canonicalId: only.canonicalId, candidates, setAside: [], missing: [], cut: [], notes: [] };
  }
  return { by: 'key', outcome: 'several', candidates, setAside: [], missing: [], cut: [], notes: doubtNotes(candidates) };
}

interface Joined {
  ref: ResolveKeyRef;
  row?: KeyRow;
}

/** Joins one hit to its key row. A hit whose id cannot be read as a key of its system joins nothing. */
async function joinHit(deps: ResolveDeps, system: ConnectorId, hit: ResolveSystemHit): Promise<Joined> {
  const raw: ResolveKeyRef = { system, keyKind: hit.keyKind, systemKey: String(hit.systemKey).slice(0, MAX_PATTERN_INPUT_LENGTH) };
  const rule = deps.kinds.find((candidate) => candidate.system === system && candidate.kind === hit.keyKind);
  if (!rule || !rule.ready || rule.use === 'reference') return { ref: raw };
  const checked = normaliseKeyValue(hit.systemKey, rule);
  if (!checked.ok) return { ref: raw };
  const ref = { ...raw, systemKey: checked.value };
  const row = await deps.repository.findBySystemKey(deps.scope, system, hit.keyKind, checked.value);
  return row && row.status !== 'retired' ? { ref, row } : { ref };
}

async function resolveByName(deps: ResolveDeps, request: Extract<ResolveRequest, { by: 'name' }>): Promise<ResolveResult> {
  if (nameWords(request.words).length === 0) return refused('name', 'no_words', 'There are no words to look for.');

  const expected = unique(request.expectedIn);
  const systems = new Map<ConnectorId, { answered: boolean; cut: boolean; hits: ResolveSystemHit[] }>();
  for (const answer of request.answers) {
    const entry = systems.get(answer.system) ?? { answered: true, cut: false, hits: [] };
    entry.answered = entry.answered && answer.answered;
    if (answer.answered) {
      entry.cut = entry.cut || answer.cut === true;
      entry.hits.push(...answer.hits);
    }
    systems.set(answer.system, entry);
  }
  const missing = expected.filter((system) => !systems.get(system)?.answered);
  const cut = unique([...systems].filter(([, entry]) => entry.answered && entry.cut).map(([system]) => system));
  const complete = expected.length > 0 && missing.length === 0 && cut.length === 0;

  const notes: string[] = [];
  if (expected.length === 0) notes.push('No system is named as holding a record of this thing, so coverage cannot be shown.');
  for (const system of missing) notes.push(`${system} did not answer, so the search did not cover every system.`);
  for (const system of cut) notes.push(`${system} returned only part of its matches.`);

  const setAside: ResolveKeyRef[] = [];
  const seen = new Set<string>();
  const joined: Joined[] = [];
  for (const system of unique(systems.keys())) {
    const entry = systems.get(system)!;
    if (!entry.answered) continue;
    for (const hit of entry.hits) {
      if (!nameContainsWords(hit.name, request.words)) {
        setAside.push({ system, keyKind: hit.keyKind, systemKey: String(hit.systemKey).slice(0, MAX_PATTERN_INPUT_LENGTH) });
        continue;
      }
      const one = await joinHit(deps, system, hit);
      const identity = `${one.ref.system}\u0000${one.ref.keyKind}\u0000${one.ref.systemKey}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      joined.push(one);
    }
  }
  setAside.sort(byRef);
  if (setAside.length > 0) notes.push('Some records came back without these words in the name and were left out of the list.');

  const groups = new Map<string, { rows: KeyRow[]; refs: ResolveKeyRef[] }>();
  const unkeyed: ResolveCandidate[] = [];
  for (const one of joined) {
    if (!one.row) {
      unkeyed.push(candidateOf([], [one.ref]));
      continue;
    }
    const group = groups.get(one.row.canonicalId) ?? { rows: [], refs: [] };
    group.rows.push(one.row);
    group.refs.push(one.ref);
    groups.set(one.row.canonicalId, group);
  }
  const candidates = [
    ...[...groups.values()].map((group) => candidateOf(group.rows, group.refs)).sort((a, b) => compareIds(a.canonicalId ?? '', b.canonicalId ?? '')),
    ...unkeyed.sort((a, b) => byRef(a.systems[0], b.systems[0])),
  ];

  if (candidates.length === 0) return { by: 'name', outcome: 'none', candidates, setAside, missing, cut, notes };
  const [only] = candidates;
  if (candidates.length === 1 && complete && only.canonicalId !== null && only.status === 'matched') {
    return { by: 'name', outcome: 'one', canonicalId: only.canonicalId, candidates, setAside, missing, cut, notes };
  }
  return { by: 'name', outcome: 'several', candidates, setAside, missing, cut, notes: [...notes, ...doubtNotes(candidates)] };
}

/** Resolves who is meant, by a key or by a name, against the key table. Read-only: it writes nothing and calls no system. */
export async function resolveSubject(deps: ResolveDeps, request: ResolveRequest): Promise<ResolveResult> {
  return request.by === 'key' ? resolveByKey(deps, request) : resolveByName(deps, request);
}
