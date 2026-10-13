/**
 * In-memory MongoDB fake for isolated tests.
 *
 * Models the behaviour the platform relies on: dotted paths, the common query and
 * update operators, projections, cursors, unique indexes (duplicate key errors
 * with code 11000), upserts, and no-op sessions/transactions. It never touches a
 * real database.
 */

export type Doc = Record<string, any>;

export class DuplicateKeyError extends Error {
  readonly code = 11000;
  constructor(public readonly keyPattern: Record<string, number>) {
    super(`E11000 duplicate key error: ${JSON.stringify(keyPattern)}`);
    this.name = 'MongoServerError';
  }
}

const getPath = (doc: Doc, path: string): any =>
  path.split('.').reduce((value: any, part) => (value == null ? undefined : value[part]), doc);

function setPath(doc: Doc, path: string, value: any): void {
  const parts = path.split('.');
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor[parts[i]] == null || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const parts = path.split('.');
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor[parts[i]] == null) return;
    cursor = cursor[parts[i]];
  }
  delete cursor[parts[parts.length - 1]];
}

const same = (a: any, b: any): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
};

function matchValue(actual: any, expected: any): boolean {
  if (expected instanceof RegExp) {
    return Array.isArray(actual) ? actual.some((v) => typeof v === 'string' && expected.test(v)) : typeof actual === 'string' && expected.test(actual);
  }
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
      return keys.every((op) => {
        const arg = expected[op];
        switch (op) {
          case '$exists': return (actual !== undefined) === Boolean(arg);
          case '$ne': return Array.isArray(actual) ? !actual.some((v) => same(v, arg)) : !same(actual, arg);
          case '$in': return (arg as any[]).some((candidate) =>
            candidate instanceof RegExp ? matchValue(actual, candidate)
              : Array.isArray(actual) ? actual.some((v) => same(v, candidate)) : same(actual, candidate));
          case '$nin': return !(arg as any[]).some((candidate) =>
            candidate instanceof RegExp ? matchValue(actual, candidate)
              : Array.isArray(actual) ? actual.some((v) => same(v, candidate)) : same(actual, candidate));
          case '$gt': return actual > arg;
          case '$gte': return actual >= arg;
          case '$lt': return actual < arg;
          case '$lte': return actual <= arg;
          case '$regex': return new RegExp(arg, expected.$options).test(String(actual ?? ''));
          case '$options': return true;
          default: throw new Error(`MemoryDb: unsupported query operator ${op}`);
        }
      });
    }
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((v) => same(v, expected));
  return same(actual, expected);
}

export function matches(doc: Doc, query: Doc = {}): boolean {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return (expected as Doc[]).some((clause) => matches(doc, clause));
    if (key === '$and') return (expected as Doc[]).every((clause) => matches(doc, clause));
    if (key === '$nor') return !(expected as Doc[]).some((clause) => matches(doc, clause));
    return matchValue(getPath(doc, key), expected);
  });
}

function project(doc: Doc, projection?: Doc): Doc {
  if (!projection || Object.keys(projection).length === 0) return structuredClone(doc);
  const include = Object.entries(projection).filter(([, v]) => v === 1 || v === true).map(([k]) => k);
  const exclude = Object.entries(projection).filter(([k, v]) => (v === 0 || v === false) && k !== '_id').map(([k]) => k);
  const out = structuredClone(doc);
  if (include.length > 0) {
    const picked: Doc = {};
    for (const key of include) { const v = getPath(out, key); if (v !== undefined) setPath(picked, key, v); }
    if (out._id !== undefined && projection._id !== 0) picked._id = out._id;
    return picked;
  }
  for (const key of exclude) unsetPath(out, key);
  if (projection._id === 0) delete out._id;
  return out;
}

export class MemoryCursor<T extends Doc = Doc> {
  private sortSpec?: Record<string, 1 | -1>;
  private limitCount?: number;
  private skipCount = 0;
  private projection?: Doc;
  constructor(private readonly docs: T[]) {}
  sort(spec: Record<string, 1 | -1>) { this.sortSpec = spec; return this; }
  limit(count: number) { this.limitCount = count; return this; }
  skip(count: number) { this.skipCount = count; return this; }
  project(projection: Doc) { this.projection = projection; return this; }
  async toArray(): Promise<T[]> {
    let rows = [...this.docs];
    if (this.sortSpec) {
      const entries = Object.entries(this.sortSpec);
      rows.sort((a, b) => {
        for (const [key, direction] of entries) {
          const av = getPath(a, key), bv = getPath(b, key);
          if (av === bv) continue;
          return (av > bv ? 1 : -1) * direction;
        }
        return 0;
      });
    }
    rows = rows.slice(this.skipCount, this.limitCount === undefined ? undefined : this.skipCount + this.limitCount);
    return rows.map((row) => project(row, this.projection)) as T[];
  }
  async next(): Promise<T | null> { return (await this.toArray())[0] ?? null; }
}

export interface FindOptions { projection?: Doc; sort?: Record<string, 1 | -1>; limit?: number; session?: unknown }

export class MemoryCollection<T extends Doc = Doc> {
  docs: T[] = [];
  private uniqueIndexes: Array<Record<string, number>> = [];
  constructor(public readonly name: string) {}

  async createIndex(spec: Record<string, number>, options: { unique?: boolean } = {}): Promise<string> {
    if (options.unique) this.uniqueIndexes.push(spec);
    return Object.keys(spec).join('_');
  }

  private assertUnique(candidate: Doc, ignore?: Doc): void {
    for (const spec of this.uniqueIndexes) {
      const keys = Object.keys(spec);
      const clash = this.docs.some((existing) =>
        existing !== ignore && keys.every((key) => getPath(existing, key) !== undefined && same(getPath(existing, key), getPath(candidate, key))));
      if (clash && keys.every((key) => getPath(candidate, key) !== undefined)) throw new DuplicateKeyError(spec);
    }
  }

  async findOne(query: Doc = {}, options: FindOptions = {}): Promise<T | null> {
    const found = this.docs.filter((doc) => matches(doc, query));
    const cursor = new MemoryCursor(found);
    if (options.sort) cursor.sort(options.sort);
    const row = (await cursor.project(options.projection ?? {}).toArray())[0];
    return (row as T) ?? null;
  }

  find(query: Doc = {}, options: FindOptions = {}): MemoryCursor<T> {
    const cursor = new MemoryCursor(this.docs.filter((doc) => matches(doc, query)));
    if (options.sort) cursor.sort(options.sort);
    if (options.limit) cursor.limit(options.limit);
    if (options.projection) cursor.project(options.projection);
    return cursor;
  }

  async insertOne(doc: T, _options?: { session?: unknown }): Promise<{ acknowledged: boolean; insertedId: any }> {
    const copy: Doc = structuredClone(doc);
    if (copy._id === undefined) copy._id = `${this.name}_${this.docs.length + 1}`;
    this.assertUnique(copy);
    this.docs.push(copy as T);
    return { acknowledged: true, insertedId: copy._id };
  }

  async insertMany(docs: T[], options?: { session?: unknown }) {
    for (const doc of docs) await this.insertOne(doc, options);
    return { acknowledged: true, insertedCount: docs.length };
  }

  private applyUpdate(doc: Doc, update: Doc, inserting: boolean): void {
    if (update.$setOnInsert && inserting) for (const [k, v] of Object.entries(update.$setOnInsert)) setPath(doc, k, structuredClone(v));
    for (const [k, v] of Object.entries(update.$set || {})) setPath(doc, k, structuredClone(v));
    for (const k of Object.keys(update.$unset || {})) unsetPath(doc, k);
    for (const [k, v] of Object.entries(update.$inc || {})) setPath(doc, k, (getPath(doc, k) || 0) + (v as number));
    for (const [k, v] of Object.entries(update.$push || {})) {
      const current: any[] = getPath(doc, k) || [];
      const spec: any = v;
      const additions = spec && typeof spec === 'object' && '$each' in spec ? spec.$each : [spec];
      let next = [...current, ...structuredClone(additions)];
      if (spec && typeof spec === 'object' && typeof spec.$slice === 'number') next = spec.$slice < 0 ? next.slice(spec.$slice) : next.slice(0, spec.$slice);
      setPath(doc, k, next);
    }
    for (const [k, v] of Object.entries(update.$addToSet || {})) {
      const current: any[] = getPath(doc, k) || [];
      if (!current.some((entry) => same(entry, v))) setPath(doc, k, [...current, structuredClone(v)]);
    }
  }

  async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean; session?: unknown } = {}) {
    const target = this.docs.find((doc) => matches(doc, filter));
    if (target) {
      const draft = structuredClone(target);
      this.applyUpdate(draft, update, false);
      this.assertUnique(draft, target);
      Object.keys(target).forEach((key) => delete (target as any)[key]);
      Object.assign(target, draft);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true };
    }
    if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, acknowledged: true };
    const fresh: Doc = {};
    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('$') && (value === null || typeof value !== 'object' || value instanceof Date)) setPath(fresh, key, value);
    }
    this.applyUpdate(fresh, update, true);
    await this.insertOne(fresh as T);
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true };
  }

  async replaceOne(filter: Doc, replacement: Doc) {
    const target = this.docs.find((doc) => matches(doc, filter));
    if (!target) return { matchedCount: 0, modifiedCount: 0 };
    const copy = structuredClone(replacement);
    copy._id = (target as any)._id;
    this.assertUnique(copy, target);
    Object.keys(target).forEach((key) => delete (target as any)[key]);
    Object.assign(target, copy);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteMany(filter: Doc = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matches(doc, filter));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(filter: Doc = {}) { return this.docs.filter((doc) => matches(doc, filter)).length; }

  /**
   * The aggregation subset the platform uses: `$match`, `$group` (keys of `$field` references; `$sum` of 1 or a number),
   * `$sort` and `$limit`. Anything else throws, so a test cannot pass on a pipeline the fake silently ignores.
   */
  aggregate(pipeline: Doc[]): { toArray: () => Promise<Doc[]> } {
    return {
      toArray: async () => {
        let rows: Doc[] = this.docs.map((doc) => structuredClone(doc));
        for (const stage of pipeline) {
          const [op] = Object.keys(stage);
          const arg = stage[op];
          if (op === '$match') rows = rows.filter((doc) => matches(doc, arg));
          else if (op === '$sort') {
            const entries = Object.entries(arg as Record<string, 1 | -1>);
            rows.sort((a, b) => {
              for (const [key, direction] of entries) {
                const av = getPath(a, key), bv = getPath(b, key);
                if (av === bv) continue;
                return (av > bv ? 1 : -1) * direction;
              }
              return 0;
            });
          } else if (op === '$limit') rows = rows.slice(0, arg as number);
          else if (op === '$group') {
            const resolve = (doc: Doc, expression: unknown): unknown => {
              if (typeof expression === 'string' && expression.startsWith('$')) return getPath(doc, expression.slice(1));
              if (expression && typeof expression === 'object') return Object.fromEntries(Object.entries(expression).map(([k, v]) => [k, resolve(doc, v)]));
              return expression;
            };
            const groups = new Map<string, Doc>();
            for (const doc of rows) {
              const id = resolve(doc, (arg as Doc)._id);
              const key = JSON.stringify(id ?? null);
              const group = groups.get(key) ?? { _id: id };
              for (const [field, accumulator] of Object.entries(arg as Doc)) {
                if (field === '_id') continue;
                const spec = accumulator as Doc;
                if (!('$sum' in spec)) throw new Error(`MemoryDb.aggregate: unsupported accumulator for ${field}`);
                const amount = typeof spec.$sum === 'number' ? spec.$sum : Number(resolve(doc, spec.$sum) ?? 0);
                group[field] = (Number(group[field]) || 0) + amount;
              }
              groups.set(key, group);
            }
            rows = [...groups.values()];
          } else throw new Error(`MemoryDb.aggregate: unsupported stage ${op}`);
        }
        return rows;
      },
    };
  }
}

export class MemorySession {
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  async endSession(): Promise<void> {}
}

export class MemoryDb {
  private readonly collections = new Map<string, MemoryCollection>();
  /** Mimics `db.client.startSession()` so transactional code paths run. */
  readonly client = { startSession: () => new MemorySession() };
  collection<T extends Doc = Doc>(name: string): MemoryCollection<T> {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection(name));
    return this.collections.get(name) as MemoryCollection<T>;
  }
  /** Test helper: all documents of a collection. */
  dump(name: string): Doc[] { return this.collection(name).docs.map((doc) => structuredClone(doc)); }
}
