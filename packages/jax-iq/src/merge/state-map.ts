import type { StateMap } from '../model';

/**
 * A state map is the only conversion the dictionary allows between a system's status words and the words of a fact. A word the table
 * does not list is never passed through and never guessed: the fact is not available. Notes never carry the word itself, because a
 * status is text from a vendor.
 */

export type StateMapConversion =
  | { ok: true; to: string; lossy: boolean }
  | { ok: false; note: string };

export function applyStateMap(map: StateMap, raw: unknown): StateMapConversion {
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    return { ok: false, note: `The source did not give a status word, so state map '${map.id}' cannot convert it.` };
  }
  const word = String(raw);
  const targets = new Set(map.table.filter((row) => row.from === word).map((row) => row.to));
  if (targets.size === 0) return { ok: false, note: `The source gave a status that state map '${map.id}' does not list.` };
  if (targets.size > 1) return { ok: false, note: `State map '${map.id}' lists the status the source gave with more than one result.` };
  const [to] = targets;
  return { ok: true, to, lossy: map.lossy };
}

/** The maps by id. An id declared twice is left out, so a binding that names it finds no map and its fact is not available. */
export function indexStateMaps(maps: readonly StateMap[]): ReadonlyMap<string, StateMap> {
  const found = new Map<string, StateMap>();
  const repeated = new Set<string>();
  for (const map of maps) {
    if (found.has(map.id) || repeated.has(map.id)) {
      found.delete(map.id);
      repeated.add(map.id);
      continue;
    }
    found.set(map.id, map);
  }
  return found;
}

export interface LossyStateMapNote {
  id: string;
  from: string;
  to: string;
  /** The map says it is lossy. */
  declaredLossy: boolean;
  /** Source words that end up as the same result: what a person loses by reading only the result. Only groups of two or more. */
  collapses: Array<{ to: string; from: string[] }>;
}

/**
 * The state maps a person should look at before relying on them: every map declared lossy, with the words it merges, and any map that
 * merges words without saying so.
 */
export function listLossyStateMaps(maps: readonly StateMap[]): LossyStateMapNote[] {
  const notes: LossyStateMapNote[] = [];
  for (const map of maps) {
    const byResult = new Map<string, string[]>();
    for (const row of map.table) {
      const words = byResult.get(row.to) ?? [];
      if (!words.includes(row.from)) words.push(row.from);
      byResult.set(row.to, words);
    }
    const collapses = [...byResult].filter(([, words]) => words.length > 1).map(([to, from]) => ({ to, from }));
    if (map.lossy || collapses.length > 0) notes.push({ id: map.id, from: map.from, to: map.to, declaredLossy: map.lossy, collapses });
  }
  return notes;
}
