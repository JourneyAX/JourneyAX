import { isWithinLimit } from './limits';

/**
 * The store of tool answers that lets a query skip a call whose answer is still within its freshness limit.
 *
 * Three rules keep it from leaking. The key holds the person asking, so one person's answer is never served to another (the gateway
 * cache is person-blind and has leaked before). An answer is cut to the answer fields this person may see before it is stored, so a
 * field a grouped call returned but the person may not read is never kept (D33). And a limit that is not set stores nothing and reads
 * nothing: unset means always read again.
 */

/** One tool answer, as stored. `answer` holds only the fields named in `fields`. */
export interface CachedCall {
  answer: unknown;
  /** The answer field paths the answer was cut to, sorted, without repeats. */
  fields: string[];
  truncated: boolean;
  retrievedAt: string;
  sourceUpdatedAt: string | null;
}

/** An entry past its limit is kept until it is replaced, so a fact that allows stale can still show it when the system does not answer. */
export interface FreshnessCache {
  get(key: string): Promise<CachedCall | undefined>;
  put(key: string, entry: CachedCall): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheKeyParts {
  tenantId: string;
  environmentId: string;
  system: string;
  tool: string;
  /** A hash of the call's arguments, never the arguments. */
  argsHash: string;
  /** Who is asking, in a form that also tells people with different rights apart: for example the person's id and their groups. */
  viewerKey: string;
}

const escapePart = (part: string): string => part.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** `tenant|environment|system|tool|argsHash|viewer`, each part escaped. A blank part is refused: a key must never lose the person. */
export function freshnessCacheKey(parts: CacheKeyParts): string {
  const named: Array<[string, string]> = [
    ['tenantId', parts.tenantId], ['environmentId', parts.environmentId], ['system', parts.system],
    ['tool', parts.tool], ['argsHash', parts.argsHash], ['viewerKey', parts.viewerKey],
  ];
  for (const [name, value] of named) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`freshness cache key: ${name} is required`);
  }
  return named.map(([, value]) => escapePart(value)).join('|');
}

const ANSWER_PATH = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

interface PathNode {
  /** The path ends here: keep everything below. */
  whole: boolean;
  next: Map<string, PathNode>;
}

function buildPathTree(fields: readonly string[]): PathNode {
  const root: PathNode = { whole: false, next: new Map() };
  for (const field of fields) {
    if (!ANSWER_PATH.test(field)) throw new Error('answer cut: a field is a path of names joined by dots');
    let node = root;
    for (const name of field.split('.')) {
      let child = node.next.get(name);
      if (!child) {
        child = { whole: false, next: new Map() };
        node.next.set(name, child);
      }
      node = child;
    }
    node.whole = true;
  }
  return root;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function cutNode(value: unknown, node: PathNode): unknown {
  if (node.whole) return structuredClone(value);
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      if (isRecord(item)) kept.push(cutNode(item, node) ?? {});
      else if (Array.isArray(item)) kept.push(cutNode(item, node));
    }
    return kept;
  }
  if (!isRecord(value)) return undefined;
  const kept: Array<[string, unknown]> = [];
  for (const [name, child] of node.next) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const part = cutNode(value[name], child);
    if (part !== undefined) kept.push([name, part]);
  }
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * The answer cut to the named field paths (dot paths, no indexes). A path that names a branch keeps the whole branch. A path below a list
 * applies to every row, and a row with none of the named fields stays as an empty row so the list keeps its length. Returns `undefined`
 * when nothing the paths name is in the answer. The result shares nothing with the answer.
 */
export function cutAnswerForCache(answer: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return undefined;
  return cutNode(answer, buildPathTree(fields));
}

/** The same text for the same data, whatever order the keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** True when a stored answer holds nothing outside its paths. */
export function isCutTo(answer: unknown, fields: readonly string[]): boolean {
  if (fields.length === 0) return false;
  const cut = cutAnswerForCache(answer, fields);
  return cut !== undefined && canonical(cut) === canonical(answer);
}

/** True when every wanted path is one of the stored paths or lies below one. */
export function cachedFieldsCover(stored: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((want) => stored.some((have) => want === have || want.startsWith(`${have}.`)));
}

/** Keeps entries in this process. Copies go in and come out, so a caller cannot change what is stored. An entry holding a field outside its own list is refused. */
export class MemoryFreshnessCache implements FreshnessCache {
  private readonly entries = new Map<string, CachedCall>();

  async get(key: string): Promise<CachedCall | undefined> {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  async put(key: string, entry: CachedCall): Promise<void> {
    if (!isCutTo(entry.answer, entry.fields)) throw new Error('freshness cache: the answer holds a field outside the fields it names');
    this.entries.set(key, structuredClone(entry));
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface StoreCallInput {
  /** The tool's answer as it came, before any cut. */
  answer: unknown;
  /** The answer field paths this person may see for the facts this call was asked for. */
  allowedFields: readonly string[];
  truncated: boolean;
  retrievedAt: string;
  sourceUpdatedAt?: string | null;
  /** The call's limit (`callFreshnessLimit`). `null` stores nothing. */
  limitMs: number | null;
}

/**
 * Stores the answer cut to the allowed fields. Returns whether anything was stored: it is not when the limit is not set, when no field is
 * allowed, or when the answer holds none of the allowed fields.
 */
export async function storeCachedCall(cache: FreshnessCache, key: string, input: StoreCallInput): Promise<boolean> {
  if (input.limitMs === null) return false;
  const fields = [...new Set(input.allowedFields)].sort();
  const answer = cutAnswerForCache(input.answer, fields);
  if (answer === undefined) return false;
  await cache.put(key, { answer, fields, truncated: input.truncated, retrievedAt: input.retrievedAt, sourceUpdatedAt: input.sourceUpdatedAt ?? null });
  return true;
}

export interface LookupCallInput {
  /** The call's limit (`callFreshnessLimit`). `null`: the cache is not read. */
  limitMs: number | null;
  /** The answer field paths this query needs from the call. */
  allowedFields: readonly string[];
  now: Date;
}

/**
 * `use_cached`: within the limit and holding every field this query needs. `fetch`: read the system. `stale` is then the old entry, past
 * its limit, that a fact allowing stale may show if that read fails; it is absent when there is none or it lacks a needed field.
 */
export type CachedCallLookup =
  | { action: 'use_cached'; entry: CachedCall }
  | { action: 'fetch'; stale?: CachedCall };

export async function lookupCachedCall(cache: FreshnessCache, key: string, input: LookupCallInput): Promise<CachedCallLookup> {
  if (input.limitMs === null) return { action: 'fetch' };
  const entry = await cache.get(key);
  if (!entry || !cachedFieldsCover(entry.fields, input.allowedFields)) return { action: 'fetch' };
  if (isWithinLimit(entry.retrievedAt, input.limitMs, input.now)) return { action: 'use_cached', entry };
  return { action: 'fetch', stale: entry };
}
