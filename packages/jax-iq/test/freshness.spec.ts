import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import * as jaxIq from '@journeyax/jax-iq';
import {
  MemoryFreshnessCache, buildFreshnessLimits, cachedFieldsCover, callFreshnessLimit, cutAnswerForCache, freshnessCacheKey, freshnessSettingKey, isCutTo,
  isWithinLimit, judgeFreshness, lookupCachedCall, retrievalAgeMs, storeCachedCall,
} from '../src/freshness';
import type { CacheKeyParts, CachedCall, FreshnessCache } from '../src/freshness';
import type { JaxOntologyRelease, SettingDef } from '../src/model';
import { SampleConnectorServer } from '../../connectors-sample/src/server';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';
import { minimalDictionary } from './fixtures/minimal.dictionary';

/**
 * Freshness: the limit of each kind of fact comes from the setting `freshness.<kind>`; an unset limit stores nothing and reads nothing;
 * the key of a stored answer holds the person asking; and an answer is cut to the fields the person may see before it is stored.
 * Every limit below is a TEST FIXTURE ONLY value made up for the test. No shipped dictionary sets one.
 */
const suite = createSuite('jax-iq: freshness limits and the cache of tool answers');

const TENANT = 'placemakers';
const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));

/** TEST FIXTURE ONLY: a freshness setting with a made-up value. */
const fixtureSetting = (kind: string, value: number | null, unit: SettingDef['unit'] = 'seconds'): SettingDef => ({
  key: freshnessSettingKey(kind), label: 'TEST FIXTURE ONLY', kind: 'freshness', unit, ownerRole: 'test', value,
});

const T0 = new Date('2026-10-29T09:00:00.000Z');
const after = (milliseconds: number) => new Date(T0.getTime() + milliseconds);

const parts: CacheKeyParts = { tenantId: TENANT, environmentId: 'dev', system: 'ace-erp', tool: 'account_balance', argsHash: 'hash-of-args', viewerKey: 'person-1|finance' };
const keyFor = (viewerKey: string) => freshnessCacheKey({ ...parts, viewerKey });

/** What the sample ERP really answers: every field of the account row. */
async function erpAnswer(): Promise<any> {
  const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
  const reply: any = await server.handle('ace-erp', TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'account_balance', arguments: { accountId: 'ACC-0001' } } });
  return reply.result.structuredContent;
}

const entry = (overrides: Partial<CachedCall> = {}): CachedCall => ({
  answer: { record: { tier: 'silver' } }, fields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString(), sourceUpdatedAt: null, ...overrides,
});

async function main() {
  await suite.test('a kind of freshness maps to the setting freshness.<kind>, in the unit the setting is declared in', () => {
    assert.equal(freshnessSettingKey('credit'), 'freshness.credit');
    const limits = buildFreshnessLimits([
      fixtureSetting('credit', 30), fixtureSetting('price', 1500, 'milliseconds'), fixtureSetting('reference', 2, 'days'), fixtureSetting('order', null),
      { key: 'credit.useWatch', label: 'not a freshness setting', kind: 'threshold', unit: 'ratio', ownerRole: 'test', value: 0.5 },
    ]);
    assert.equal(limits.millisecondsFor('credit'), 30_000);
    assert.equal(limits.millisecondsFor('price'), 1500);
    assert.equal(limits.millisecondsFor('reference'), 172_800_000);
    assert.equal(limits.millisecondsFor('order'), null, 'a setting with no value is no limit');
    assert.equal(limits.millisecondsFor('ticket'), null, 'a kind with no setting is no limit');
    assert.equal(limits.millisecondsFor('useWatch'), null, 'only freshness.* settings are read');
    assert.deepEqual(limits.unusable, []);
  });

  await suite.test('no shipped dictionary sets a limit: every kind that a fact or a binding uses reads as no limit', () => {
    for (const block of [minimalDictionary, accountFixtureDictionary, golden]) {
      const limits = buildFreshnessLimits(block.settings);
      assert.deepEqual(limits.unusable, [], block.ontologyId);
      const kinds = new Set([...block.facts.map((fact) => fact.freshnessKind), ...block.bindings.map((binding) => binding.freshnessKind)]);
      assert.ok(kinds.size > 0);
      for (const kind of kinds) {
        assert.ok(block.settings.some((setting) => setting.key === freshnessSettingKey(kind)), `${block.ontologyId}: freshness.${kind} is declared`);
        assert.equal(limits.millisecondsFor(kind), null, `${block.ontologyId}: freshness.${kind} has no value`);
      }
    }
  });

  await suite.test('zero is a limit; a unit that is not a time, a negative number and a key declared twice are unusable and read as no limit', () => {
    const limits = buildFreshnessLimits([
      fixtureSetting('stock', 0),
      fixtureSetting('tier', 5, 'ratio'),
      fixtureSetting('ticket', -1),
      fixtureSetting('deal', 10), fixtureSetting('deal', 20),
    ]);
    assert.equal(limits.millisecondsFor('stock'), 0, 'zero is a value, not unset');
    assert.equal(limits.millisecondsFor('tier'), null);
    assert.equal(limits.millisecondsFor('ticket'), null);
    assert.equal(limits.millisecondsFor('deal'), null, 'which of two values would be right is not guessed');
    assert.deepEqual([...limits.unusable].sort(), ['freshness.deal', 'freshness.ticket', 'freshness.tier']);
  });

  await suite.test('one call that fills several facts has the shortest of their limits, and none when any fact has none', () => {
    assert.equal(callFreshnessLimit([30_000, 5000, 60_000]), 5000);
    assert.equal(callFreshnessLimit([30_000]), 30_000);
    assert.equal(callFreshnessLimit([0, 30_000]), 0);
    assert.equal(callFreshnessLimit([30_000, null, 5000]), null, 'the fact with no limit must always be read again, and the one call serves them all');
    assert.equal(callFreshnessLimit([null]), null);
    assert.equal(callFreshnessLimit([]), null);
  });

  await suite.test('age and the limit: within at the limit, past one millisecond later, and an unreadable or future read is not within', () => {
    const read = T0.toISOString();
    assert.equal(retrievalAgeMs(read, after(2500)), 2500);
    assert.equal(retrievalAgeMs('not a time', T0), null);
    assert.equal(isWithinLimit(read, 30_000, after(30_000)), true);
    assert.equal(isWithinLimit(read, 30_000, after(30_001)), false);
    assert.equal(isWithinLimit(read, 0, T0), true);
    assert.equal(isWithinLimit(read, 0, after(1)), false);
    assert.equal(isWithinLimit(read, null, T0), false, 'no limit: never within');
    assert.equal(isWithinLimit('not a time', 30_000, T0), false);
    assert.equal(isWithinLimit(after(1000).toISOString(), 30_000, T0), false, 'a read dated after now is not trusted');
  });

  await suite.test('past the limit the value is read again; if that fails the fact is refused unless it allows stale', () => {
    const base = { fromCache: true, retrievedAt: T0.toISOString(), limitMs: 30_000, now: after(31_000) };
    assert.equal(judgeFreshness({ ...base, allowStale: false, refetchFailed: true }), 'refused', 'a fact that does not allow stale is not available');
    assert.equal(judgeFreshness({ ...base, allowStale: true, refetchFailed: true }), 'stale', 'a fact that allows stale shows it marked stale');
    assert.equal(judgeFreshness({ ...base, allowStale: true, refetchFailed: false }), 'refused', 'nobody tried to read it again: an old value is not shown as current');
    assert.equal(judgeFreshness({ ...base, allowStale: false, refetchFailed: false }), 'refused');
    assert.equal(judgeFreshness({ ...base, now: after(30_000), allowStale: false, refetchFailed: false }), 'current', 'at the limit it is still current');
    assert.equal(judgeFreshness({ ...base, limitMs: null, now: T0, allowStale: false, refetchFailed: false }), 'refused', 'a stored copy with no limit is never current');
    assert.equal(judgeFreshness({ ...base, fromCache: false, allowStale: false, refetchFailed: false }), 'current', 'a value read in this query is current, whatever the limit');
    assert.equal(judgeFreshness({ ...base, fromCache: false, limitMs: null, allowStale: false, refetchFailed: false }), 'current');
  });

  await suite.test('the cache key holds the tenant, environment, system, tool, arguments hash and the viewer; two viewers get two keys', () => {
    const key = freshnessCacheKey(parts);
    assert.equal(key, `${TENANT}|dev|ace-erp|account_balance|hash-of-args|person-1\\|finance`);
    for (const value of Object.values(parts)) assert.ok(key.includes(value.replace(/\|/g, '\\|')), value);
    assert.notEqual(keyFor('person-1|finance'), keyFor('person-2|finance'));
    assert.notEqual(keyFor('person-1|finance'), keyFor('person-1|sales'), 'the same person with other rights is another viewer');
    assert.equal(keyFor('person-1|finance'), keyFor('person-1|finance'));
    for (const field of Object.keys(parts) as Array<keyof CacheKeyParts>) {
      assert.notEqual(freshnessCacheKey({ ...parts, [field]: 'other' }), key, `${field} is part of the key`);
    }
  });

  await suite.test('a part that holds the separator cannot make two different calls share a key', () => {
    const a = freshnessCacheKey({ ...parts, tool: 'a|b', argsHash: 'c' });
    const b = freshnessCacheKey({ ...parts, tool: 'a', argsHash: 'b|c' });
    assert.notEqual(a, b);
    assert.notEqual(freshnessCacheKey({ ...parts, tool: 'a\\', argsHash: 'b' }), freshnessCacheKey({ ...parts, tool: 'a', argsHash: '\\b' }));
  });

  await suite.test('a key with no viewer, or any blank part, is refused: a cache must never lose the person', () => {
    for (const field of Object.keys(parts) as Array<keyof CacheKeyParts>) {
      for (const blank of ['', '   ']) assert.throws(() => freshnessCacheKey({ ...parts, [field]: blank }), new RegExp(`${field} is required`));
      assert.throws(() => freshnessCacheKey({ ...parts, [field]: undefined as unknown as string }), new RegExp(`${field} is required`));
    }
  });

  await suite.test('an unset limit stores nothing and reads nothing', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    const input = { answer: { record: { tier: 'silver' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString() };
    assert.equal(await storeCachedCall(cache, key, { ...input, limitMs: null }), false);
    assert.equal(cache.size, 0);
    // An entry that is there (stored when a limit was set) is not read once the limit is unset.
    assert.equal(await storeCachedCall(cache, key, { ...input, limitMs: 30_000 }), true);
    assert.equal(cache.size, 1);
    assert.deepEqual(await lookupCachedCall(cache, key, { limitMs: null, allowedFields: ['record.tier'], now: T0 }), { action: 'fetch' });
    // A fresh cache with every shipped (empty) limit stores nothing for any kind of fact.
    const empty = new MemoryFreshnessCache();
    const limits = buildFreshnessLimits(accountFixtureDictionary.settings);
    const callLimit = callFreshnessLimit(accountFixtureDictionary.facts.map((fact) => limits.millisecondsFor(fact.freshnessKind)));
    assert.equal(callLimit, null);
    assert.equal(await storeCachedCall(empty, key, { ...input, limitMs: callLimit }), false);
    assert.equal(empty.size, 0);
  });

  await suite.test('within the limit the stored answer is used; at the limit too; past it the system is read again and the old entry is offered as stale', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    assert.deepEqual(await lookupCachedCall(cache, key, { limitMs: 30_000, allowedFields: ['record.tier'], now: T0 }), { action: 'fetch' }, 'nothing stored yet');
    assert.equal(await storeCachedCall(cache, key, { answer: { record: { tier: 'silver' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 }), true);
    const look = (now: Date) => lookupCachedCall(cache, key, { limitMs: 30_000, allowedFields: ['record.tier'], now });
    const fresh: any = await look(after(10_000));
    assert.equal(fresh.action, 'use_cached');
    assert.deepEqual(fresh.entry.answer, { record: { tier: 'silver' } });
    assert.equal(((await look(after(30_000))) as any).action, 'use_cached');
    const past: any = await look(after(30_001));
    assert.equal(past.action, 'fetch');
    assert.deepEqual(past.stale.answer, { record: { tier: 'silver' } }, 'a fact that allows stale can still show it if the read fails');
    assert.equal(cache.size, 1, 'the old entry is kept until it is replaced');
    assert.equal(await storeCachedCall(cache, key, { answer: { record: { tier: 'gold' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: after(31_000).toISOString(), limitMs: 30_000 }), true);
    assert.deepEqual(((await look(after(32_000))) as any).entry.answer, { record: { tier: 'gold' } });
    assert.equal(cache.size, 1, 'a new read replaces the old entry');
  });

  await suite.test('a limit of zero stores the answer but uses it only in the same instant', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    assert.equal(await storeCachedCall(cache, key, { answer: { record: { tier: 'silver' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 0 }), true);
    assert.equal(((await lookupCachedCall(cache, key, { limitMs: 0, allowedFields: ['record.tier'], now: T0 })) as any).action, 'use_cached');
    assert.equal(((await lookupCachedCall(cache, key, { limitMs: 0, allowedFields: ['record.tier'], now: after(1) })) as any).action, 'fetch');
  });

  await suite.test('an entry that lacks a field this query needs is not used and not offered as stale', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    await storeCachedCall(cache, key, { answer: { record: { tier: 'silver', name: 'x' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 });
    const wider = { limitMs: 30_000, allowedFields: ['record.tier', 'record.name'], now: after(1000) };
    assert.deepEqual(await lookupCachedCall(cache, key, wider), { action: 'fetch' }, 'a missing field would otherwise read as "not recorded"');
    assert.deepEqual(await lookupCachedCall(cache, key, { ...wider, now: after(60_000) }), { action: 'fetch' });
    assert.equal(((await lookupCachedCall(cache, key, { limitMs: 30_000, allowedFields: ['record.tier'], now: after(1000) })) as any).action, 'use_cached');
    assert.equal(cachedFieldsCover(['record'], ['record.tier', 'record.name']), true, 'a branch covers what is below it');
    assert.equal(cachedFieldsCover(['record.tier'], ['record']), false, 'a leaf does not cover its branch');
    assert.equal(cachedFieldsCover(['record.tier'], ['record.tierName']), false, 'a longer name is not below a shorter one');
    assert.equal(cachedFieldsCover(['record.tier'], []), true);
  });

  await suite.test('two viewers do not share an entry, even for the same call', async () => {
    const cache = new MemoryFreshnessCache();
    await storeCachedCall(cache, keyFor('person-1|finance'), { answer: { record: { balance: 709.82 } }, allowedFields: ['record.balance'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 });
    const mine: any = await lookupCachedCall(cache, keyFor('person-1|finance'), { limitMs: 30_000, allowedFields: ['record.balance'], now: after(1000) });
    assert.equal(mine.action, 'use_cached');
    for (const other of ['person-2|finance', 'person-1|sales', 'person-1']) {
      assert.deepEqual(await lookupCachedCall(cache, keyFor(other), { limitMs: 30_000, allowedFields: ['record.balance'], now: after(1000) }), { action: 'fetch' }, other);
    }
  });

  await suite.test('a cached entry holds no field outside the allowed facts, even when a grouped call returned the whole row', async () => {
    const answer = await erpAnswer();
    assert.equal(answer.ok, true);
    for (const denied of ['creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'currency', 'sample', 'commercetoolsUnitKey']) {
      assert.ok(denied in answer.record, `the ERP returned ${denied}: this is the case D33 is about`);
    }
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-who-reads-tier-and-name');
    assert.equal(await storeCachedCall(cache, key, { answer, allowedFields: ['record.name', 'record.tier'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 }), true);
    const stored: any = await cache.get(key);
    assert.deepEqual(stored.answer, { record: { name: answer.record.name, tier: answer.record.tier } });
    assert.deepEqual(stored.fields, ['record.name', 'record.tier']);
    const text = JSON.stringify(stored);
    for (const secret of ['creditLimit', 'balance', 'overdue', 'lastPaymentAt', 'terms', 'currency', String(answer.record.balance), String(answer.record.creditLimit), 'ACC-0001', 'connector']) {
      assert.ok(!text.includes(secret), `the stored entry does not hold ${secret}`);
    }
    const reread: any = await lookupCachedCall(cache, key, { limitMs: 30_000, allowedFields: ['record.name', 'record.tier'], now: after(1000) });
    assert.equal(reread.action, 'use_cached');
    assert.ok(!JSON.stringify(reread.entry).includes('balance'));
    // The person who may read the balance is another viewer and has an entry of their own.
    assert.deepEqual(await lookupCachedCall(cache, keyFor('person-who-reads-balance'), { limitMs: 30_000, allowedFields: ['record.balance'], now: after(1000) }), { action: 'fetch' });
  });

  await suite.test('nothing is stored when no field is allowed or the answer holds none of the allowed fields', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    const answer = await erpAnswer();
    assert.equal(await storeCachedCall(cache, key, { answer, allowedFields: [], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 }), false);
    assert.equal(await storeCachedCall(cache, key, { answer, allowedFields: ['record.noSuchField'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 }), false);
    assert.equal(cache.size, 0);
  });

  await suite.test('the answer is cut again when it is stored, so a caller that forgot to cut cannot store a denied field', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    const answer = { record: { tier: 'silver', balance: 709.82 }, extra: 1 };
    await storeCachedCall(cache, key, { answer, allowedFields: ['record.tier', 'record.tier'], truncated: true, retrievedAt: T0.toISOString(), sourceUpdatedAt: '2026-10-29T08:00:00Z', limitMs: 30_000 });
    const stored: any = await cache.get(key);
    assert.deepEqual(stored, { answer: { record: { tier: 'silver' } }, fields: ['record.tier'], truncated: true, retrievedAt: T0.toISOString(), sourceUpdatedAt: '2026-10-29T08:00:00Z' });
    assert.deepEqual(answer, { record: { tier: 'silver', balance: 709.82 }, extra: 1 }, 'the caller\'s answer is not changed');
  });

  await suite.test('the memory cache refuses an entry holding a field outside its own list, and neither side can change what is stored', async () => {
    const cache = new MemoryFreshnessCache();
    const key = keyFor('person-1');
    await assert.rejects(cache.put(key, entry({ answer: { record: { tier: 'silver', balance: 1 } } })), /outside the fields it names/);
    await assert.rejects(cache.put(key, entry({ fields: [] })), /outside the fields it names/);
    await assert.rejects(cache.put(key, entry({ answer: { other: 1 } })), /outside the fields it names/);
    assert.equal(cache.size, 0);
    const given = entry();
    await cache.put(key, given);
    (given.answer as any).record.tier = 'changed after put';
    const first: any = await cache.get(key);
    assert.equal(first.answer.record.tier, 'silver', 'a change to the entry that was put does not reach the store');
    first.answer.record.tier = 'changed after get';
    first.fields.push('record.balance');
    const second: any = await cache.get(key);
    assert.deepEqual(second, entry(), 'a change to an entry that was read does not reach the store');
    await cache.delete(key);
    assert.equal(await cache.get(key), undefined);
    await cache.put(key, entry());
    cache.clear();
    assert.equal(cache.size, 0);
  });

  await suite.test('a plain object satisfies the FreshnessCache port, so a shared store can stand in for the memory one', async () => {
    const calls: string[] = [];
    const store = new Map<string, CachedCall>();
    const port: FreshnessCache = {
      async get(key) { calls.push(`get ${key}`); return store.get(key); },
      async put(key, value) { calls.push(`put ${key}`); store.set(key, value); },
      async delete(key) { calls.push(`delete ${key}`); store.delete(key); },
    };
    const key = keyFor('person-1');
    assert.equal(await storeCachedCall(port, key, { answer: { record: { tier: 'silver' } }, allowedFields: ['record.tier'], truncated: false, retrievedAt: T0.toISOString(), limitMs: 30_000 }), true);
    assert.equal(((await lookupCachedCall(port, key, { limitMs: 30_000, allowedFields: ['record.tier'], now: after(1) })) as any).action, 'use_cached');
    assert.deepEqual(calls, [`put ${key}`, `get ${key}`]);
    calls.length = 0;
    assert.deepEqual(await lookupCachedCall(port, key, { limitMs: null, allowedFields: ['record.tier'], now: after(1) }), { action: 'fetch' });
    assert.deepEqual(calls, [], 'with no limit the store is not even asked');
  });

  await suite.test('the cut keeps a branch whole, applies a path below a list to every row, keeps the length of the list, and returns nothing when nothing matches', () => {
    const answer = { ok: true, total: 3, records: [{ orderNumber: 'A1', total: 10, secret: 'x' }, { orderNumber: 'A2' }, { other: 1 }], record: { name: 'n', nested: { a: 1, b: 2 } } };
    assert.deepEqual(cutAnswerForCache(answer, ['records.orderNumber', 'total']), { records: [{ orderNumber: 'A1' }, { orderNumber: 'A2' }, {}], total: 3 });
    assert.deepEqual(cutAnswerForCache(answer, ['record.nested']), { record: { nested: { a: 1, b: 2 } } });
    assert.deepEqual(cutAnswerForCache(answer, ['record.nested.a', 'record.nested']), { record: { nested: { a: 1, b: 2 } } }, 'a branch wins over a leaf below it');
    assert.deepEqual(cutAnswerForCache(answer, ['records']), { records: answer.records });
    assert.deepEqual(cutAnswerForCache({ records: [] }, ['records.orderNumber']), { records: [] }, 'an empty list is still an empty list');
    assert.deepEqual(cutAnswerForCache({ record: { name: null } }, ['record.name']), { record: { name: null } }, 'a field that is present and empty stays');
    assert.equal(cutAnswerForCache(answer, ['nothing.here']), undefined);
    assert.equal(cutAnswerForCache(answer, []), undefined);
    assert.equal(cutAnswerForCache('text', ['a']), undefined);
    const cut: any = cutAnswerForCache(answer, ['record.nested']);
    cut.record.nested.a = 99;
    assert.equal(answer.record.nested.a, 1, 'the cut shares nothing with the answer');
  });

  await suite.test('the cut looks only at the answer\'s own fields and refuses a path that is not a path', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "record": {"name": "n"}}');
    assert.deepEqual(cutAnswerForCache(hostile, ['record.name']), { record: { name: 'n' } });
    assert.equal(cutAnswerForCache({ record: { name: 'n' } }, ['record.toString']), undefined, 'a name the object only inherits is not a field');
    assert.equal(({} as any).polluted, undefined);
    for (const bad of ['', 'records[0].name', 'record..name', '.record', 'record.', 'a+b', 'record.name ', 'a/b']) {
      assert.throws(() => cutAnswerForCache({ record: {} }, [bad]), /path of names joined by dots/, JSON.stringify(bad));
    }
  });

  await suite.test('isCutTo is true only for an answer that holds nothing outside its paths', () => {
    assert.equal(isCutTo({ record: { tier: 'silver' } }, ['record.tier']), true);
    assert.equal(isCutTo({ record: { tier: 'silver', balance: 1 } }, ['record.tier']), false);
    assert.equal(isCutTo({ record: { balance: 1, tier: 'silver' } }, ['record']), true);
    assert.equal(isCutTo({ record: { tier: 'silver' } }, []), false);
    assert.equal(isCutTo({}, ['record.tier']), false);
  });

  await suite.test('the package exports the cache port, its memory implementation and the limits, and nothing is exported twice', () => {
    const exported = jaxIq as Record<string, unknown>;
    for (const name of ['MemoryFreshnessCache', 'buildFreshnessLimits', 'callFreshnessLimit', 'freshnessCacheKey', 'freshnessSettingKey', 'judgeFreshness', 'lookupCachedCall', 'storeCachedCall', 'cutAnswerForCache']) {
      assert.equal(typeof exported[name], 'function', `${name} is exported from @journeyax/jax-iq`);
    }
    assert.equal(exported.MemoryFreshnessCache, MemoryFreshnessCache);
    assert.equal(exported.freshnessCacheKey, freshnessCacheKey);
    assert.equal(exported.judgeFreshness, judgeFreshness);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
