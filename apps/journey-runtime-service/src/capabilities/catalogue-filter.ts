/**
 * Answers the catalogue's own database queries from a list of products held in memory.
 *
 * The search handler builds MongoDB filters (tenant and lifecycle rules, category scope, word patterns over named fields). Running
 * those same filters over the in-memory copy, in the database's own collection order and with its own limit, gives the same
 * products as the database by construction; nothing about matching or ranking is written a second time.
 *
 * Only the operators the catalogue filters use are supported ($and, $or, $nor, $in, a pattern, or an equal value). Anything
 * else throws UnsupportedFilter, and the caller then asks the database instead, so an unforeseen filter can never give a wrong answer.
 */

export class UnsupportedFilter extends Error {
  constructor(detail: string) {
    super(`unsupported catalogue filter: ${detail}`);
    this.name = 'UnsupportedFilter';
  }
}

type DocPredicate = (doc: any) => boolean;

const NUMERIC_SEGMENT = /^\d+$/;

/**
 * The values a dotted path reaches in a document, the way the database reads it: a path through a list reaches every element's
 * field, and a numeric segment picks that position.
 */
export function valuesAt(node: any, segments: string[], position = 0, found: any[] = []): any[] {
  if (position === segments.length) { found.push(node); return found; }
  if (node === null || node === undefined || typeof node !== 'object') return found;
  const segment = segments[position];
  if (Array.isArray(node)) {
    if (NUMERIC_SEGMENT.test(segment)) {
      valuesAt(node[Number(segment)], segments, position + 1, found);
    } else {
      for (const element of node) if (element && typeof element === 'object') valuesAt(element, segments, position, found);
    }
    return found;
  }
  return valuesAt(node[segment], segments, position + 1, found);
}

/** A reached value, or the elements of it when it is a list: the database matches a list field when any element matches. */
function eachCandidate(values: any[], test: (value: any) => boolean): boolean {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const element of value) if (test(element)) return true;
    } else if (test(value)) {
      return true;
    }
  }
  return false;
}

const matchesPattern = (pattern: RegExp, value: any): boolean => {
  if (typeof value !== 'string') return false;
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
  return pattern.test(value);
};

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function compileCondition(path: string, condition: unknown): DocPredicate {
  const segments = path.split('.');
  if (condition instanceof RegExp) {
    return (doc) => eachCandidate(valuesAt(doc, segments), (value) => matchesPattern(condition, value));
  }
  if (isPrimitive(condition)) {
    return (doc) => eachCandidate(valuesAt(doc, segments), (value) => value === condition);
  }
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    const operators = Object.keys(condition);
    if (operators.length > 0 && operators.every((operator) => operator.startsWith('$'))) {
      const predicates = operators.map((operator): DocPredicate => {
        if (operator !== '$in') throw new UnsupportedFilter(`${operator} on ${path}`);
        const candidates = (condition as any).$in;
        if (!Array.isArray(candidates)) throw new UnsupportedFilter(`$in on ${path} needs a list`);
        for (const candidate of candidates) {
          if (!(candidate instanceof RegExp) && !isPrimitive(candidate)) throw new UnsupportedFilter(`$in value on ${path}`);
        }
        return (doc) => eachCandidate(valuesAt(doc, segments), (value) =>
          candidates.some((candidate: unknown) => candidate instanceof RegExp ? matchesPattern(candidate, value) : value === candidate));
      });
      return (doc) => predicates.every((predicate) => predicate(doc));
    }
  }
  throw new UnsupportedFilter(`condition on ${path}`);
}

/** Turns a database filter into a test over a product. Throws UnsupportedFilter for anything the catalogue filters do not use. */
export function compileFilter(filter: Record<string, any> | undefined): DocPredicate {
  const predicates: DocPredicate[] = [];
  for (const [key, value] of Object.entries(filter || {})) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(value) || value.length === 0) throw new UnsupportedFilter(`${key} needs a non-empty list`);
      const clauses = value.map((clause) => compileFilter(clause));
      if (key === '$and') predicates.push((doc) => clauses.every((clause) => clause(doc)));
      else if (key === '$or') predicates.push((doc) => clauses.some((clause) => clause(doc)));
      else predicates.push((doc) => !clauses.some((clause) => clause(doc)));
    } else if (key.startsWith('$')) {
      throw new UnsupportedFilter(key);
    } else {
      predicates.push(compileCondition(key, value));
    }
  }
  return (doc) => predicates.every((predicate) => predicate(doc));
}

/**
 * The part of a database collection the search handler uses (find with limit, count, distinct), over products held in memory,
 * in the order they were loaded (the database's own order for a scan).
 */
export class MemoryProductCollection {
  constructor(private readonly docs: any[]) {}

  find(filter?: Record<string, any>): { limit: (count: number) => { toArray: () => Promise<any[]> }; toArray: () => Promise<any[]> } {
    const matches = compileFilter(filter);
    const take = (count?: number) => async () => {
      const out: any[] = [];
      for (const doc of this.docs) {
        if (matches(doc)) {
          out.push(doc);
          if (count !== undefined && out.length >= count) break;
        }
      }
      return out;
    };
    return { limit: (count: number) => ({ toArray: take(count) }), toArray: take() };
  }

  async countDocuments(filter?: Record<string, any>): Promise<number> {
    const matches = compileFilter(filter);
    let count = 0;
    for (const doc of this.docs) if (matches(doc)) count += 1;
    return count;
  }

  /** The distinct values of a field over the matching products; a list field contributes each of its elements. */
  async distinct(field: string, filter?: Record<string, any>): Promise<any[]> {
    const matches = compileFilter(filter);
    const segments = field.split('.');
    const seen = new Set<any>();
    for (const doc of this.docs) {
      if (!matches(doc)) continue;
      for (const value of valuesAt(doc, segments)) {
        if (Array.isArray(value)) value.forEach((element) => seen.add(element)); else if (value !== undefined) seen.add(value);
      }
    }
    return [...seen];
  }
}
