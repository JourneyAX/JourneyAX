import assert from 'node:assert/strict';
import { haversineKm, runOp, scoreText, type Collections } from '../src/engine';
import { ToolError, type Op, type Rec } from '../src/types';
import { validateArguments } from '../src/validate';
import { resolveExample } from '../src/examples';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Sample connectors: engine operations');

function store(data: Record<string, Rec[]>): Collections & { added: Rec[] } {
  const rows = new Map(Object.entries(data).map(([k, v]) => [k, structuredClone(v)]));
  const added: Rec[] = [];
  return { added, all: (c) => rows.get(c) ?? [], add: (c, r) => { (rows.get(c) ?? rows.set(c, []).get(c)!).push(r); added.push(r); } };
}
const ctx = (data: Collections) => ({ connectorId: 'demo', data, now: () => new Date('2026-09-01T10:00:00Z') });
const run = (op: Op, args: Rec, data: Collections) => runOp(op, args, ctx(data));
const code = (fn: () => unknown) => { try { fn(); } catch (err) { return err instanceof ToolError ? err.code : 'other'; } return 'none'; };

const things = [
  { id: 'T-1', name: 'Oak table', kind: 'furniture', tags: ['wood', 'dining'], price: 120, date: '2026-08-01', lat: -36.8, lng: 174.7 },
  { id: 'T-2', name: 'Oak chair', kind: 'furniture', tags: ['wood'], price: 40, date: '2026-08-15', lat: -41.3, lng: 174.8 },
  { id: 'T-3', name: 'Steel shelf', kind: 'storage', tags: ['metal'], price: 75, date: '2026-09-01', lat: -45.9, lng: 170.5 },
  { id: 'T-4', name: 'Chair cushion', kind: 'soft', tags: ['fabric', 'chair'], price: 15, date: '2026-07-01', lat: -43.5, lng: 172.6 },
];
const find = (extra: Partial<Extract<Op, { kind: 'find' }>> = {}): Op => ({ kind: 'find', collection: 'things', limit: { arg: 'limit', default: 2, max: 3 }, ...extra } as Op);

check('every result has the same outline: ok and connector, then records, record or rows', () => {
  const data = store({ things });
  assert.deepEqual(Object.keys(run(find(), {}, data)).slice(0, 2), ['ok', 'connector']);
  const result = run(find(), {}, data);
  assert.equal(result.ok, true);
  assert.equal(result.connector, 'demo');
  assert.ok(Array.isArray(result.records));
});

check('find: words must all match (or any), a word at the start of a field counts double, filters are exact and case-insensitive, limit is clamped', () => {
  const data = store({ things });
  const text = { arg: 'q', fields: [{ field: 'name', weight: 3 }, { field: 'tags', weight: 1 }] };
  const names = (op: Op, args: Rec) => run(op, args, data).records.map((r: Rec) => r.id);
  assert.deepEqual(names(find({ text, limit: { default: 10, max: 10 } }), { q: 'oak' }), ['T-1', 'T-2']);
  assert.deepEqual(names(find({ text, limit: { default: 10, max: 10 } }), { q: 'oak chair' }), ['T-2'], 'all words');
  assert.deepEqual(names(find({ text: { ...text, mode: 'any' }, limit: { default: 10, max: 10 } }), { q: 'oak chair' }).sort(), ['T-1', 'T-2', 'T-4']);
  assert.deepEqual(names(find({ text, limit: { default: 10, max: 10 } }), { q: 'chair' }), ['T-2', 'T-4'], 'a name that starts with the word ranks first');
  assert.deepEqual(names(find({ filters: [{ arg: 'kind', field: 'kind' }], limit: { default: 10, max: 10 } }), { kind: 'FURNITURE' }), ['T-1', 'T-2']);
  assert.deepEqual(names(find({ filters: [{ arg: 'max', field: 'price', match: 'lte' }, { arg: 'min', field: 'price', match: 'gte' }], limit: { default: 10, max: 10 } }), { min: 40, max: 80 }), ['T-2', 'T-3']);
  assert.deepEqual(names(find({ filters: [{ arg: 'from', field: 'date', match: 'gte' }], limit: { default: 10, max: 10 } }), { from: '2026-08-10' }), ['T-2', 'T-3'], 'dates compare as text');
  assert.equal(run(find(), {}, data).returned, 2, 'the default limit');
  assert.equal(run(find(), { limit: 99 }, data).returned, 3, 'clamped to the maximum');
  assert.equal(run(find(), { limit: 99 }, data).total, 4);
  assert.deepEqual(names(find({ sort: { field: 'price', order: 'desc' }, limit: { default: 10, max: 10 } }), {}), ['T-1', 'T-3', 'T-2', 'T-4']);
  assert.deepEqual(Object.keys(run(find({ select: ['id'] }), {}, data).records[0]), ['id']);
  assert.deepEqual(run(find({ text, limit: { default: 10, max: 10 } }), { q: 'zzz' }, data).records, []);
  assert.equal(scoreText(things[0], text, ''), 0);
});

check('get: by key (case-insensitive), by an alternative key, with children included; not found and missing arguments are told apart', () => {
  const data = store({ things, parts: [{ thingId: 'T-1', part: 'leg' }, { thingId: 'T-1', part: 'top' }, { thingId: 'T-2', part: 'seat' }] });
  const op: Op = { kind: 'get', collection: 'things', key: 'id', arg: 'id', altKeys: [{ key: 'name', arg: 'name' }], include: [{ collection: 'parts', foreignKey: 'thingId', as: 'parts' }] };
  const one = run(op, { id: 't-1' }, data);
  assert.equal(one.record.name, 'Oak table');
  assert.deepEqual(one.record.parts.map((p: Rec) => p.part), ['leg', 'top']);
  assert.equal(run(op, { name: 'steel shelf' }, data).record.id, 'T-3');
  assert.equal(code(() => run(op, { id: 'T-99' }, data)), 'not_found');
  assert.equal(code(() => run(op, {}, data)), 'invalid_arguments');
});

check('create: new id after the highest, defaults and stamps, validation against another collection with copied fields, required arguments; the seed is not touched', () => {
  const data = store({ things, notes: [{ noteId: 'N-007', thingId: 'T-1' }] });
  const op: Op = {
    kind: 'create', collection: 'notes', idField: 'noteId', idPrefix: 'N-', idWidth: 3,
    fields: { thingId: { arg: 'thingId', required: true }, text: { arg: 'text' } }, defaults: { status: 'new' }, stamp: ['createdAt'],
    validate: [{ arg: 'thingId', collection: 'things', field: 'id', message: 'No thing {value}.', copy: { thingName: 'name' } }],
  };
  const made = run(op, { thingId: 't-2', text: 'hi' }, data);
  assert.equal(made.created, true);
  assert.deepEqual(made.record, { noteId: 'N-008', status: 'new', thingName: 'Oak chair', thingId: 't-2', text: 'hi', createdAt: '2026-09-01T10:00:00.000Z', sample: true, createdThroughTool: true });
  assert.equal(run(op, { thingId: 'T-1' }, data).record.noteId, 'N-009');
  assert.equal(code(() => run(op, { thingId: 'T-404' }, data)), 'not_found');
  assert.equal(code(() => run(op, { text: 'x' }, data)), 'invalid_arguments');
  assert.equal(data.added.length, 2, 'failed attempts add nothing');
  assert.equal(data.all('things').length, 4);
});

check('aggregate: groups, counts, sums, averages, minimum and maximum, sorted and limited', () => {
  const data = store({ things });
  const op: Op = { kind: 'aggregate', collection: 'things', groupBy: 'kind', metrics: [{ name: 'n', op: 'count' }, { name: 'total', op: 'sum', field: 'price' }, { name: 'avg', op: 'avg', field: 'price' }, { name: 'low', op: 'min', field: 'price' }, { name: 'high', op: 'max', field: 'price' }], sort: { field: 'total', order: 'desc' }, limit: { default: 2, max: 5 } };
  const result = run(op, {}, data);
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows, [{ kind: 'furniture', n: 2, total: 160, avg: 80, low: 40, high: 120 }, { kind: 'storage', n: 1, total: 75, avg: 75, low: 75, high: 75 }]);
  const whole = run({ kind: 'aggregate', collection: 'things', metrics: [{ name: 'n', op: 'count' }] }, {}, data);
  assert.deepEqual(whole.rows, [{ n: 4 }]);
});

check('nearest and drive: distances come from the coordinates, from a record or from a point', () => {
  const data = store({ things, places: [{ pid: 'P-1', lat: -36.9, lng: 174.8 }] });
  assert.ok(Math.abs(haversineKm(-36.85, 174.76, -41.29, 174.78) - 494) < 6, 'Auckland to Wellington is about 494 km in a straight line');
  const near: Op = { kind: 'nearest', collection: 'things', latField: 'lat', lngField: 'lng', limit: { arg: 'limit', default: 2, max: 3 }, from: { collection: 'places', key: 'pid', arg: 'pid', latField: 'lat', lngField: 'lng', latArg: 'lat', lngArg: 'lng' } };
  const byRecord = run(near, { pid: 'P-1' }, data);
  assert.deepEqual(byRecord.records.map((r: Rec) => r.id), ['T-1', 'T-2']);
  assert.ok(byRecord.records[0].distanceKm < 15);
  assert.deepEqual(run(near, { lat: -45.8, lng: 170.5 }, data).records.map((r: Rec) => r.id)[0], 'T-3');
  assert.equal(code(() => run(near, {}, data)), 'invalid_arguments');
  assert.equal(code(() => run(near, { pid: 'P-9' }, data)), 'not_found');
  assert.equal(code(() => run(near, { lat: 'x', lng: 1 }, data)), 'invalid_arguments');
  const drive: Op = { kind: 'drive', from: near.kind === 'nearest' ? near.from : {}, to: { collection: 'things', key: 'id', arg: 'id', latField: 'lat', lngField: 'lng' }, roadFactor: 1.5, avgKmh: 60 };
  const trip = run(drive, { pid: 'P-1', id: 'T-2' }, data).record;
  assert.equal(trip.to, 'T-2');
  assert.ok(trip.roadKm > trip.straightLineKm && trip.minutes > 0 && trip.estimate === true);
});

check('match: a text is valid only if one record has all its words; otherwise the close ones are offered', () => {
  const data = store({ things });
  const op: Op = { kind: 'match', collection: 'things', text: { arg: 'text', fields: [{ field: 'name', weight: 3 }] }, minScore: 6, suggestions: 2 };
  const good = run(op, { text: 'oak table' }, data);
  assert.equal(good.valid, true);
  assert.equal(good.match.id, 'T-1');
  assert.ok(!good.suggestions.some((s: Rec) => s.id === 'T-1'));
  const bad = run(op, { text: 'oak bench' }, data);
  assert.equal(bad.valid, false);
  assert.equal(bad.match, null);
  assert.deepEqual(bad.suggestions.map((s: Rec) => s.id).sort(), ['T-1', 'T-2']);
  assert.equal(code(() => run(op, { text: '  ' }, data)), 'invalid_arguments');
});

check('argument checks: required, types, enums and ranges are reported together in plain words', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'integer', minimum: 1, maximum: 5 }, c: { type: 'string', enum: ['x', 'y'] }, d: { type: 'boolean' }, e: { type: 'number' } } };
  assert.deepEqual(validateArguments(schema, { a: 'ok', b: 3, c: 'x', d: true, e: 1.5 }), []);
  assert.deepEqual(validateArguments(schema, {}), ['a is required']);
  assert.deepEqual(validateArguments(schema, { a: 'toolong', b: 9, c: 'z', d: 'yes', e: 'n' }).sort(), ['a is too long', 'b must be at most 5', 'c must be one of x, y', 'd must be true or false', 'e must be a number']);
  assert.deepEqual(validateArguments(schema, { a: 1 }), ['a must be text']);
  assert.deepEqual(validateArguments(schema, null), ['arguments must be an object']);
  assert.deepEqual(validateArguments(schema, { a: 'x', b: 1.5 }), ['b must be a whole number']);
  // an input the tool does not have is reported with the real ones, unless the schema allows extra properties
  assert.deepEqual(validateArguments(schema, { a: 'ok', accountName: 'x' }), ['accountName is not an input of this tool; its inputs are a, b, c, d, e']);
  assert.deepEqual(validateArguments(schema, { a: 'ok', x: 1, y: 2 }), ['x, y are not inputs of this tool; its inputs are a, b, c, d, e']);
  assert.deepEqual(validateArguments({ ...schema, additionalProperties: true }, { a: 'ok', z: 1 }), []);
});

check('example placeholders point at records and fail loudly when there is none', () => {
  const data = store({ things });
  assert.deepEqual(resolveExample({ id: '$first:things.id', second: '$nth:2:things.name', keep: 'as is', n: 3 }, data), { id: 'T-1', second: 'Oak chair', keep: 'as is', n: 3 });
  assert.throws(() => resolveExample({ id: '$first:nothing.id' }, data), /no record 1/);
  assert.throws(() => resolveExample({ id: '$what' }, data), /Unreadable/);
});

console.log(`✅ sample connector engine: ${passed} passed, 0 failed`);
