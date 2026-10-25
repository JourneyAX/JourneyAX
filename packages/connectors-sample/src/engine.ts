import { ToolError, type Filter, type Limit, type Op, type Origin, type Rec, type TextSearch } from './types';

/**
 * Runs a tool's declarative `op` over a tenant's records. One small set of operations (find, get, create, aggregate, nearest, drive, match)
 * serves every sample connector; what a connector holds and what its tools are called is in its own data files.
 *
 * Every result has the same outline: `ok` and `connector`, then one of `records`, `record` or `rows`.
 */
export interface Collections {
  /** All records of a collection: the seed plus anything created through a tool. */
  all(collection: string): Rec[];
  /** Adds a created record. */
  add(collection: string, record: Rec): void;
}

export interface EngineContext {
  connectorId: string;
  data: Collections;
  now: () => Date;
}

const tokenize = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);

const flatten = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.values(value as Rec).map(flatten).join(' ');
  return String(value);
};

function clampLimit(limit: Limit | undefined, args: Rec): number {
  if (!limit) return Number.MAX_SAFE_INTEGER;
  const asked = limit.arg ? Number(args[limit.arg]) : NaN;
  const wanted = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : limit.default;
  return Math.min(wanted, limit.max);
}

/** Numbers compare as numbers; anything else (an ISO date, for one) compares as text. */
function atLeast(larger: unknown, smaller: unknown): boolean {
  const a = Number(larger);
  const b = Number(smaller);
  if (Number.isFinite(a) && Number.isFinite(b) && larger !== '' && smaller !== '') return a >= b;
  return String(larger ?? '') >= String(smaller ?? '');
}

function passes(record: Rec, filters: Filter[] | undefined, args: Rec): boolean {
  for (const filter of filters ?? []) {
    const wanted = args[filter.arg];
    if (wanted === undefined || wanted === null || wanted === '') continue;
    const actual = record[filter.field];
    switch (filter.match ?? 'equals') {
      case 'equals': {
        const same = typeof actual === 'string' || typeof wanted === 'string' ? String(actual ?? '').toLowerCase() === String(wanted).toLowerCase() : actual === wanted;
        if (!same) return false;
        break;
      }
      case 'contains':
        if (!flatten(actual).toLowerCase().includes(String(wanted).toLowerCase())) return false;
        break;
      case 'gte':
        if (!atLeast(actual, wanted)) return false;
        break;
      case 'lte':
        if (!atLeast(wanted, actual)) return false;
        break;
    }
  }
  return true;
}

/** A relevance score for a record, or 0 for no match. A word counts double when a field has a word that starts with it. */
export function scoreText(record: Rec, search: TextSearch, query: string): number {
  const words = tokenize(query);
  if (words.length === 0) return 0;
  let total = 0;
  let matchedWords = 0;
  const fields = search.fields.map((field) => ({ weight: field.weight ?? 1, text: flatten(record[field.field]).toLowerCase() }));
  for (const word of words) {
    let best = 0;
    for (const field of fields) {
      if (!field.text) continue;
      const fieldWords = tokenize(field.text);
      if (fieldWords.some((candidate) => candidate.startsWith(word))) best = Math.max(best, field.weight * 2);
      else if (field.text.includes(word)) best = Math.max(best, field.weight);
    }
    if (best > 0) matchedWords++;
    total += best;
  }
  if ((search.mode ?? 'all') === 'all' && matchedWords < words.length) return 0;
  return matchedWords > 0 ? total : 0;
}

function pick(record: Rec, select: string[] | undefined): Rec {
  if (!select) return { ...record };
  const out: Rec = {};
  for (const field of select) if (field in record) out[field] = record[field];
  return out;
}

function compare(sort: { field: string; order?: 'asc' | 'desc' } | undefined) {
  return (a: Rec, b: Rec) => {
    if (!sort) return 0;
    const x = a[sort.field];
    const y = b[sort.field];
    const order = sort.order === 'desc' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * order;
    return String(x ?? '').localeCompare(String(y ?? '')) * order;
  };
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function position(origin: Origin, args: Rec, ctx: EngineContext): { lat: number; lng: number; label?: string } {
  if (origin.latArg && origin.lngArg && args[origin.latArg] !== undefined && args[origin.lngArg] !== undefined) {
    const lat = Number(args[origin.latArg]);
    const lng = Number(args[origin.lngArg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ToolError('invalid_arguments', 'The coordinates are not numbers.');
    return { lat, lng };
  }
  if (origin.collection && origin.key && origin.arg) {
    const wanted = args[origin.arg];
    if (wanted === undefined || wanted === null || wanted === '') throw new ToolError('invalid_arguments', `Give ${origin.arg}${origin.latArg ? ` or ${origin.latArg} and ${origin.lngArg}` : ''}.`);
    const found = ctx.data.all(origin.collection).find((record) => String(record[origin.key!]).toLowerCase() === String(wanted).toLowerCase());
    if (!found) throw new ToolError('not_found', `No ${origin.collection} record with ${origin.key} ${wanted}.`);
    return { lat: Number(found[origin.latField ?? 'lat']), lng: Number(found[origin.lngField ?? 'lng']), label: String(found[origin.key]) };
  }
  throw new ToolError('invalid_arguments', 'Say where from.');
}

function matches(records: Rec[], search: TextSearch, filters: Filter[] | undefined, args: Rec): Array<{ record: Rec; score: number }> {
  const query = String(args[search.arg] ?? '');
  return records
    .filter((record) => passes(record, filters, args))
    .map((record) => ({ record, score: scoreText(record, search, query) }))
    .filter((entry) => entry.score > 0);
}

function nextId(existing: Rec[], idField: string, prefix: string, width: number): string {
  let highest = 0;
  for (const record of existing) {
    const id = String(record[idField] ?? '');
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isFinite(n) && n > highest) highest = n;
    }
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}

export function runOp(op: Op, args: Rec, ctx: EngineContext): Rec {
  const base = { ok: true as const, connector: ctx.connectorId };

  switch (op.kind) {
    case 'find': {
      const all = ctx.data.all(op.collection);
      let found: Array<{ record: Rec; score?: number }>;
      if (op.text && args[op.text.arg] !== undefined && String(args[op.text.arg]).trim() !== '') {
        found = matches(all, op.text, op.filters, args).sort((a, b) => b.score - a.score || compare(op.sort)(a.record, b.record));
      } else {
        found = all.filter((record) => passes(record, op.filters, args)).map((record) => ({ record })).sort((a, b) => compare(op.sort)(a.record, b.record));
      }
      const limit = clampLimit(op.limit, args);
      return { ...base, total: found.length, returned: Math.min(found.length, limit), records: found.slice(0, limit).map((entry) => pick(entry.record, op.select)) };
    }

    case 'get': {
      const all = ctx.data.all(op.collection);
      const keys = [{ key: op.key, arg: op.arg }, ...(op.altKeys ?? [])];
      let found: Rec | undefined;
      let asked = false;
      for (const { key, arg } of keys) {
        const wanted = args[arg];
        if (wanted === undefined || wanted === null || wanted === '') continue;
        asked = true;
        found = all.find((record) => String(record[key]).toLowerCase() === String(wanted).toLowerCase());
        if (!found) throw new ToolError('not_found', `No ${op.collection} record with ${key} ${wanted}.`);
        break;
      }
      if (!asked || !found) throw new ToolError('invalid_arguments', `Give ${keys.map((entry) => entry.arg).join(' or ')}.`);
      const record: Rec = pick(found, op.select);
      for (const include of op.include ?? []) {
        record[include.as] = ctx.data.all(include.collection).filter((child) => child[include.foreignKey] === found![op.key]).slice(0, include.limit ?? 100);
      }
      return { ...base, record };
    }

    case 'create': {
      const input: Rec = {};
      for (const [field, spec] of Object.entries(op.fields)) {
        const value = args[spec.arg];
        if ((value === undefined || value === null || value === '') && spec.required) throw new ToolError('invalid_arguments', `${spec.arg} is required.`);
        if (value !== undefined) input[field] = value;
      }
      const copied: Rec = {};
      for (const check of op.validate ?? []) {
        const wanted = args[check.arg];
        if (wanted === undefined) continue;
        const found = ctx.data.all(check.collection).find((record) => String(record[check.field]).toLowerCase() === String(wanted).toLowerCase());
        if (!found) throw new ToolError('not_found', check.message.replace('{value}', String(wanted)));
        for (const [to, from] of Object.entries(check.copy ?? {})) copied[to] = found[from];
      }
      const stamp = ctx.now().toISOString();
      const record: Rec = {
        [op.idField]: nextId(ctx.data.all(op.collection), op.idField, op.idPrefix, op.idWidth),
        ...(op.defaults ?? {}),
        ...copied,
        ...input,
        ...Object.fromEntries((op.stamp ?? []).map((field) => [field, stamp])),
        sample: true,
        createdThroughTool: true,
      };
      ctx.data.add(op.collection, record);
      return { ...base, created: true, record };
    }

    case 'aggregate': {
      const rows = ctx.data.all(op.collection).filter((record) => passes(record, op.filters, args));
      const groups = new Map<string, Rec[]>();
      for (const record of rows) {
        const key = op.groupBy ? String(record[op.groupBy]) : 'all';
        const bucket = groups.get(key);
        if (bucket) bucket.push(record); else groups.set(key, [record]);
      }
      const out: Rec[] = [...groups.entries()].map(([key, members]) => {
        const row: Rec = op.groupBy ? { [op.groupBy]: key } : {};
        for (const metric of op.metrics) {
          const values = metric.field ? members.map((member) => Number(member[metric.field!])).filter((n) => Number.isFinite(n)) : [];
          switch (metric.op) {
            case 'count': row[metric.name] = members.length; break;
            case 'sum': row[metric.name] = Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100; break;
            case 'avg': row[metric.name] = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null; break;
            case 'min': row[metric.name] = values.length ? Math.min(...values) : null; break;
            case 'max': row[metric.name] = values.length ? Math.max(...values) : null; break;
          }
        }
        return row;
      });
      out.sort(compare(op.sort));
      const limit = clampLimit(op.limit, args);
      return { ...base, total: out.length, returned: Math.min(out.length, limit), rows: out.slice(0, limit) };
    }

    case 'nearest': {
      const from = position(op.from, args, ctx);
      const ranked = ctx.data.all(op.collection)
        .map((record) => ({ ...record, distanceKm: Math.round(haversineKm(from.lat, from.lng, Number(record[op.latField]), Number(record[op.lngField])) * 10) / 10 }))
        .filter((record) => Number.isFinite(record.distanceKm))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      const limit = clampLimit(op.limit, args);
      return { ...base, total: ranked.length, returned: Math.min(ranked.length, limit), records: ranked.slice(0, limit) };
    }

    case 'drive': {
      const from = position(op.from, args, ctx);
      const to = position(op.to, args, ctx);
      const straight = haversineKm(from.lat, from.lng, to.lat, to.lng);
      const road = straight * op.roadFactor;
      return {
        ...base,
        record: {
          from: from.label ?? { lat: from.lat, lng: from.lng }, to: to.label,
          straightLineKm: Math.round(straight * 10) / 10, roadKm: Math.round(road * 10) / 10,
          minutes: Math.max(1, Math.round((road / op.avgKmh) * 60)), estimate: true, sample: true,
        },
      };
    }

    case 'match': {
      const query = String(args[op.text.arg] ?? '').trim();
      if (!query) throw new ToolError('invalid_arguments', `${op.text.arg} is required.`);
      const records = ctx.data.all(op.collection);
      // A match has every word of the text in it; suggestions are records that share some of the words.
      const exact = matches(records, { ...op.text, mode: 'all' }, undefined, args).sort((a, b) => b.score - a.score);
      const best = exact[0];
      const valid = Boolean(best && best.score >= op.minScore);
      const partial = matches(records, { ...op.text, mode: 'any' }, undefined, args).sort((a, b) => b.score - a.score).filter((entry) => !valid || entry.record !== best.record);
      return { ...base, valid, match: valid ? best.record : null, suggestions: partial.slice(0, op.suggestions).map((entry) => entry.record) };
    }
  }
}
