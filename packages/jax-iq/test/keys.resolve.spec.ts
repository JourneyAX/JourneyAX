import './setup/no-world';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DuplicateKeyError, MemoryDb, createSuite } from '@journeyax/test-support';
import * as jaxIq from '@journeyax/jax-iq';
import {
  MAX_PATTERN_INPUT_LENGTH, MemoryKeyRepository, checkKeyRow, checkKeyUniqueness, contactCanonicalId, contactKeyHash, contactKeyValue, isKeyedUnder, keyKindRulesOf, nameContainsWords,
  parseKeyMapping, resolveSubject,
} from '../src/keys';
import type { KeyKindRule, KeyRepository, KeyRow, KeyScope, ResolveDeps, ResolveResult, ResolveSystemAnswer } from '../src/keys';
import { nameWords, normaliseName } from '../src/keys/normalise';
import { SampleConnectorServer } from '../../connectors-sample/src/server';

/**
 * Who is "the one"? A name only finds candidates. The resolver says `one` for a key whose row is matched, or for a name when every system
 * that should know the account answered, nothing was cut, and the hits join through the key table to exactly one account whose rows are
 * all matched. Anything else is `several` with a note, `none`, or `refused`. It never chooses. The near-duplicate names come from the
 * sample ERP and the sample Salesforce, asked in the same process through their real tool.
 */
const suite = createSuite('jax-iq: the key table, the resolver and name normalisation');

const WORKTREE = path.resolve(__dirname, '../../..');
const TENANT = 'placemakers';
const ENV = 'dev';
const NOW = '2026-10-29T09:00:00Z';
const scope: KeyScope = { tenantId: TENANT, environmentId: ENV, thing: 'Account' };
const mapping = parseKeyMapping(JSON.parse(readFileSync(path.join(WORKTREE, 'docs/agent-instructions/jax-iq/account-keys.mapping.json'), 'utf8')));
const kinds = keyKindRulesOf(mapping);
const BOTH = ['ace-erp', 'salesforce'];

const erpAccounts: Array<{ accountId: string; name: string }> = JSON.parse(readFileSync(path.join(WORKTREE, 'packages/connectors-sample/connectors/ace-erp/seed.json'), 'utf8')).collections.account_balances;
const salesforceAccounts: Array<{ accountId: string; name: string }> = JSON.parse(readFileSync(path.join(WORKTREE, 'packages/connectors-sample/connectors/salesforce/seed.json'), 'utf8')).collections.accounts;
const nameOf = (accountId: string) => erpAccounts.find((account) => account.accountId === accountId)!.name;
/** TEST FIXTURE ONLY: a made-up 15-character Salesforce id for a sample account (the sample Salesforce uses the account number as its id). */
const sfId = (accountId: string) => `001TEST0000${accountId.slice(-4)}`;

const row = (over: Partial<KeyRow> & Pick<KeyRow, 'canonicalId' | 'system' | 'keyKind' | 'systemKey'>): KeyRow => ({
  tenantId: TENANT, environmentId: ENV, thing: 'Account', role: 'primary', evidence: 'real_field', status: 'matched', firstSeenAt: NOW, lastVerifiedAt: NOW,
  builtBy: { runId: 'run-1', releaseVersion: 'test-release', releaseChecksum: 'test-checksum' }, ...over,
});
/** The key table the sample systems would give: every account in the ERP and in Salesforce, joined by the account number in the Salesforce note. */
const sampleRows = (): KeyRow[] => erpAccounts.flatMap((account) => [
  row({ canonicalId: account.accountId, system: 'ace-erp', keyKind: 'account_number', systemKey: account.accountId }),
  row({ canonicalId: account.accountId, system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId(account.accountId), evidence: 'text_note' }),
]);

async function tableWith(rows: KeyRow[]): Promise<MemoryKeyRepository> {
  const repository = new MemoryKeyRepository();
  const written = await repository.upsertMany(rows);
  assert.equal(written.ok, true, JSON.stringify(written));
  return repository;
}
const depsOf = (repository: KeyRepository, rules: KeyKindRule[] = kinds): ResolveDeps => ({ repository, scope, kinds: rules });

const server = new SampleConnectorServer({ tenants: [TENANT], now: () => new Date('2026-09-01T10:00:00Z') });
/** Asks a sample system's own account finder, as the engine will, and reduces the answer to what the resolver reads. */
async function ask(system: 'ace-erp' | 'salesforce', query: string, limit?: number): Promise<ResolveSystemAnswer> {
  const reply: any = await server.handle(system, TENANT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_account', arguments: { query, ...(limit ? { limit } : {}) } } });
  const content = reply.result.structuredContent;
  assert.equal(content.ok, true);
  return {
    system, answered: true, cut: content.total > content.returned,
    hits: content.records.map((record: any) => (system === 'ace-erp'
      ? { keyKind: 'account_number', systemKey: record.accountId, name: record.name }
      : { keyKind: 'sf_account_id', systemKey: sfId(record.accountId), name: record.name })),
  };
}
const byName = (words: string, answers: ResolveSystemAnswer[], expectedIn: string[] = BOTH) => ({ by: 'name' as const, words, expectedIn, answers });
const ids = (result: ResolveResult) => result.candidates.map((candidate) => candidate.canonicalId);
const keyRequest = (keyKind: string, value: unknown) => ({ by: 'key' as const, keyKind, value });

/** A fixed random stream: the same seed always gives the same numbers. */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // ── name normalisation ─────────────────────────────────────────────────────────────────────
  await suite.test('name normalisation, as rules with pairs: NFKC, lower case, "&" is "and", punctuation is a space, spaces collapse, order kept, no suffix stripped', () => {
    const pairs: Array<[string, string, string]> = [
      ['Talbot & Nguyen Concrete Ltd', 'talbot and nguyen concrete ltd', 'ampersand is the word and'],
      ['Talbot and Nguyen Concrete Ltd', 'talbot and nguyen concrete ltd', 'the word and is the same token'],
      ['Talbot&Nguyen', 'talbot and nguyen', 'an ampersand with no spaces still splits the words'],
      ['TALBOT  &   NGUYEN', 'talbot and nguyen', 'case folds and spaces collapse'],
      ['  Talbot & Nguyen  ', 'talbot and nguyen', 'the ends are trimmed'],
      ["O'Brien-Smith (NZ) Ltd.", 'o brien smith nz ltd', 'every other mark is a space'],
      ['Smith, Jones; and Co.', 'smith jones and co', 'commas and semicolons'],
      ['ＴＡＬＢＯＴ ＆ ＮＧＵＹＥＮ', 'talbot and nguyen', 'full-width letters and a full-width ampersand (NFKC)'],
      ['ﬁsher & son', 'fisher and son', 'a ligature (NFKC)'],
      ['Café Müller', 'café müller', 'letters with accents are letters'],
      ['Café', 'café', 'a combining accent is composed (NFKC) and kept'],
      ['Ltd', 'ltd', 'a suffix word is a word'],
      ['Ngata & Whittle', 'ngata and whittle', 'word order is kept'],
      ['!!! ... ---', '', 'marks alone are nothing'],
      ['   ', '', 'blank'],
      ['', '', 'empty'],
      ['Unit 12 Rd', 'unit 12 rd', 'digits are kept'],
    ];
    for (const [input, expected, why] of pairs) assert.equal(normaliseName(input), expected, why);
    assert.equal(normaliseName(undefined as any), '');
    assert.equal(normaliseName(12 as any), '');
    assert.notEqual(normaliseName('Whittle & Ngata'), normaliseName('Ngata & Whittle'), 'two names with the same words in another order are different names');
    assert.notEqual(normaliseName('Hartley Ltd'), normaliseName('Hartley'), 'no suffix word is stripped');
    assert.deepEqual(nameWords('Talbot & Nguyen'), ['talbot', 'and', 'nguyen']);
    assert.deepEqual(nameWords('...'), []);
    for (const [input] of pairs) assert.equal(normaliseName(normaliseName(input)), normaliseName(input), 'normalising twice changes nothing');
  });

  await suite.test('a name matches when the normalised words are a contiguous run of whole words inside the normalised name', () => {
    const name = 'Talbot & Nguyen Concrete Ltd';
    for (const query of ['Talbot & Nguyen', 'talbot and nguyen', 'Talbot', 'Nguyen Concrete', 'concrete ltd', 'Talbot & Nguyen Concrete Ltd', 'TALBOT&NGUYEN', '& Nguyen']) {
      assert.equal(nameContainsWords(name, query), true, query);
    }
    for (const [query, why] of [
      ['Talbot Nguyen', 'the "and" between them is a word of the name'], ['Nguyen & Talbot', 'order is part of the name'], ['Talbot Concrete', 'not a contiguous run'],
      ['Talb', 'a part of a word is not a word'], ['Nguy', 'a part of a word is not a word'], ['Concrete Nguyen', 'order'], ['Talbot & Nguyen Concrete Ltd Extra', 'longer than the name'],
      ['', 'no words matches nothing'], ['   ', 'blank matches nothing'], ['!!!', 'marks alone match nothing'],
    ] as Array<[string, string]>) assert.equal(nameContainsWords(name, query), false, `${query}: ${why}`);
    assert.equal(nameContainsWords('', 'Talbot'), false);
    assert.equal(nameContainsWords(undefined as any, 'Talbot'), false);
    assert.equal(nameContainsWords('Ngata & Whittle Roofing Ltd', 'Whittle & Ngata'), false, 'Whittle & Ngata and Ngata & Whittle are different names');
    assert.equal(nameContainsWords('Whittle & Ngata Plumbing Ltd', 'Ngata & Whittle'), false);
    assert.equal(nameContainsWords('Whittle & Ngata Plumbing Ltd', 'Whittle & Ngata'), true);
  });

  // ── the key table: U1, U2 and the rest ─────────────────────────────────────────────────────
  await suite.test('the key table refuses a second owner for a system record (U1), all or nothing, and a refresh keeps the first time seen', async () => {
    const table = new MemoryKeyRepository();
    const first = row({ canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001' });
    assert.deepEqual(await table.upsertMany([first]), { ok: true, inserted: 1, updated: 0 });
    const clash = await table.upsertMany([
      row({ canonicalId: 'ACC-0002', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0002' }),
      row({ canonicalId: 'ACC-0002', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001' }),
    ]);
    assert.equal(clash.ok, false);
    assert.equal((clash as any).problem.rule, 'U1');
    assert.equal((clash as any).problem.index, 1);
    assert.equal(await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0002'), undefined, 'the first row of the refused batch was not written either');
    assert.equal((await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0001'))!.canonicalId, 'ACC-0001');
    const refreshed = await table.upsertMany([{ ...first, firstSeenAt: '2026-11-01T00:00:00Z', lastVerifiedAt: '2026-11-01T00:00:00Z', builtBy: { runId: 'run-2', releaseVersion: 'v2', releaseChecksum: 'c2' } }]);
    assert.deepEqual(refreshed, { ok: true, inserted: 0, updated: 1 });
    const stored = (await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0001'))!;
    assert.equal(stored.firstSeenAt, NOW, 'the earlier first-seen time is kept');
    assert.equal(stored.lastVerifiedAt, '2026-11-01T00:00:00Z');
    assert.equal(stored.builtBy.runId, 'run-2');
    assert.equal((await table.findByCanonicalId(scope, 'ACC-0001')).length, 1, 'a refresh is not a second row');
    const twice = await table.upsertMany([row({ canonicalId: 'ACC-0003', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0003' }), row({ canonicalId: 'ACC-0004', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0003' })]);
    assert.equal((twice as any).problem.rule, 'U1', 'the same system key twice in one batch is refused too');
    assert.equal(await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0003'), undefined);
  });

  await suite.test('a retired row at a system key can be replaced by a live row of another canonical id; a live row cannot be taken over', async () => {
    const table = await tableWith([row({ canonicalId: 'ACC-0001', system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId('ACC-0001') })]);
    const takeover = row({ canonicalId: 'ACC-0002', system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId('ACC-0001') });
    assert.equal(((await table.upsertMany([takeover])) as any).problem.rule, 'U1');
    assert.equal(await table.retireRun(TENANT, ENV, 'run-1'), 1);
    assert.deepEqual(await table.upsertMany([takeover]), { ok: true, inserted: 0, updated: 1 });
    const now = (await table.findBySystemKey(scope, 'salesforce', 'sf_account_id', sfId('ACC-0001')))!;
    assert.deepEqual([now.canonicalId, now.status], ['ACC-0002', 'matched']);
    assert.equal((await table.findByCanonicalId(scope, 'ACC-0001')).length, 0, 'the old canonical id no longer holds the row');
  });

  await suite.test('U2: a canonical id has one matched primary key per system and key kind; a division, an alias, a candidate and a retired row may repeat', async () => {
    const primary = row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004' });
    const table = await tableWith([primary]);
    const second = row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004-b' });
    const refused: any = await table.upsertMany([second]);
    assert.equal(refused.ok, false);
    assert.equal(refused.problem.rule, 'U2');
    assert.match(refused.problem.message, /ACC-0004/);
    assert.equal(await table.findBySystemKey(scope, 'commercetools', 'ct_unit_key', 'acc-0004-b'), undefined);
    const allowed = await table.upsertMany([
      { ...second, systemKey: 'acc-0004-div1', role: 'division', parentSystemKey: 'acc-0004' },
      { ...second, systemKey: 'acc-0004-alias', role: 'alias' },
      { ...second, systemKey: 'acc-0004-maybe', status: 'candidate', evidence: 'name_only' },
      { ...second, systemKey: 'acc-0004-gone', status: 'retired' },
      { ...second, system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId('ACC-0004') },
      { ...second, keyKind: 'ct_account_number', systemKey: 'ACC-0004' },
    ]);
    assert.deepEqual(allowed, { ok: true, inserted: 6, updated: 0 });
    assert.equal((await table.findByCanonicalId(scope, 'ACC-0004')).length, 7);
    const sameBatch: any = await new MemoryKeyRepository().upsertMany([primary, second]);
    assert.equal(sameBatch.problem.rule, 'U2', 'two primaries in one batch');
    assert.equal(sameBatch.problem.index, 1);
    const swapped = await table.upsertMany([{ ...primary, status: 'conflict' }, second]);
    assert.deepEqual(swapped, { ok: true, inserted: 1, updated: 1 }, 'once the first primary is no longer matched, another may be');
  });

  await suite.test('U2 holds in code where a database cannot hold it: the test database has no partial index, and the code check is what refuses', async () => {
    const columns = { tenantId: 1, environmentId: 1, thing: 1, system: 1, keyKind: 1, systemKey: 1 };
    const primary = row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004' });
    const second = row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004-b' });
    const division = row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004-div1', role: 'division', parentSystemKey: 'acc-0004' });
    const db = new MemoryDb();
    const u1 = db.collection('jaxiq_keys');
    await u1.createIndex(columns, { unique: true });
    await u1.insertOne({ ...primary });
    await u1.insertOne({ ...second });
    assert.equal(u1.docs.length, 2, 'U1 alone lets a second primary in');
    assert.equal(checkKeyUniqueness(second, [primary])!.rule, 'U2', 'the code check refuses it');
    assert.equal(checkKeyUniqueness(division, [primary]), undefined, 'and lets a division through');
    // The U2 columns as a plain unique index would refuse the division as well, because a partial filter is ignored.
    const u2 = db.collection('u2_without_filter');
    await u2.createIndex({ tenantId: 1, environmentId: 1, thing: 1, canonicalId: 1, system: 1, keyKind: 1 }, { unique: true });
    await u2.insertOne({ ...primary });
    await assert.rejects(u2.insertOne({ ...division }), DuplicateKeyError);
    assert.equal(checkKeyUniqueness(primary, [primary]), undefined, 'a row is never a clash with itself');
    assert.equal(checkKeyUniqueness({ ...second, tenantId: 'other' }, [primary]), undefined, 'another tenant');
    assert.equal(checkKeyUniqueness({ ...second, environmentId: 'test' }, [primary]), undefined, 'another environment');
    assert.equal(checkKeyUniqueness({ ...second, thing: 'Contact' }, [primary]), undefined, 'another thing');
    assert.equal(checkKeyUniqueness({ ...primary, canonicalId: 'ACC-0005' }, [primary])!.rule, 'U1');
    assert.equal(checkKeyUniqueness({ ...primary, canonicalId: 'ACC-0005' }, [{ ...primary, status: 'retired' }]), undefined, 'a retired row no longer owns the key');
  });

  await suite.test('tenant, environment and thing separate every read and write; a run is retired as a unit and its rows stop being live', async () => {
    const mine = row({ canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001' });
    const table = await tableWith([
      mine, { ...mine, tenantId: 'other-tenant' }, { ...mine, environmentId: 'production' }, { ...mine, thing: 'Contact' },
      row({ canonicalId: 'ACC-0002', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0002', builtBy: { runId: 'run-2', releaseVersion: 'r', releaseChecksum: 'c' } }),
    ]);
    assert.equal((await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0001'))!.tenantId, TENANT);
    assert.equal(await table.findBySystemKey({ ...scope, tenantId: 'nobody' }, 'ace-erp', 'account_number', 'ACC-0001'), undefined);
    assert.equal((await table.findByCanonicalId({ ...scope, environmentId: 'staging' }, 'ACC-0001')).length, 0);
    assert.equal(await table.retireRun('other-tenant', ENV, 'run-1'), 1, 'only the rows of that tenant');
    assert.equal(await table.retireRun(TENANT, ENV, 'run-1'), 2, 'the account row and the contact-thing row of this tenant and environment');
    assert.equal(await table.retireRun(TENANT, ENV, 'run-1'), 0, 'already retired');
    assert.equal(await table.retireRun(TENANT, ENV, 'run-unknown'), 0);
    assert.equal((await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0001'))!.status, 'retired');
    assert.equal((await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0002'))!.status, 'matched', 'another run is untouched');
    assert.equal((await table.findBySystemKey({ ...scope, environmentId: 'production' }, 'ace-erp', 'account_number', 'ACC-0001'))!.status, 'matched', 'another environment is untouched');
    const out = (await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0002'))!;
    out.status = 'conflict';
    assert.equal((await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0002'))!.status, 'matched', 'a row read out is a copy');
  });

  await suite.test('a row is checked before it is written: unknown fields, a name, an email address, a name-only link marked matched, a division without its parent, bad times', async () => {
    const good = row({ canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001' });
    assert.deepEqual(checkKeyRow(good), []);
    const problems = (change: (copy: any) => void): string => {
      const copy: any = structuredClone(good);
      change(copy);
      return checkKeyRow(copy).join(' | ');
    };
    assert.match(problems((copy) => { copy.name = 'Talbot & Nguyen'; }), /no field called name/);
    assert.match(problems((copy) => { copy.email = 'a@b.test'; }), /no field called email/);
    assert.match(problems((copy) => { copy.systemKey = 'grace@example.test'; }), /looks like an email address/);
    assert.match(problems((copy) => { copy.canonicalId = 'ACC-0001:grace@example.test'; }), /looks like an email address/);
    assert.match(problems((copy) => { copy.evidence = 'name_only'; }), /only ever a candidate/);
    assert.equal(problems((copy) => { copy.evidence = 'name_only'; copy.status = 'candidate'; }), '');
    assert.equal(problems((copy) => { copy.evidence = 'name_only'; copy.status = 'retired'; }), '');
    assert.match(problems((copy) => { copy.role = 'division'; }), /names its parent/);
    assert.match(problems((copy) => { copy.parentSystemKey = 'acc-0001'; }), /Only a division/);
    assert.match(problems((copy) => { copy.role = 'boss'; }), /role must be/);
    assert.match(problems((copy) => { copy.status = 'maybe'; }), /status must be/);
    assert.match(problems((copy) => { copy.firstSeenAt = '2026-10-29'; }), /firstSeenAt must be a time/);
    assert.match(problems((copy) => { copy.lastVerifiedAt = 'yesterday'; }), /lastVerifiedAt must be a time/);
    assert.match(problems((copy) => { delete copy.builtBy; }), /builtBy is required/);
    assert.match(problems((copy) => { copy.builtBy.runId = ''; }), /builtBy.runId is required/);
    assert.match(problems((copy) => { copy.builtBy.secret = 'x'; }), /builtBy has no field called secret/);
    assert.match(problems((copy) => { copy.tenantId = ''; }), /tenantId is required/);
    assert.match(problems((copy) => { copy.systemKey = 'A'.repeat(MAX_PATTERN_INPUT_LENGTH + 1); }), /longer than the longest text/);
    assert.deepEqual(checkKeyRow(null), ['A key row is an object.']);
    assert.deepEqual(checkKeyRow([good]), ['A key row is an object.']);
    const table = new MemoryKeyRepository();
    const refused: any = await table.upsertMany([good, { ...good, systemKey: 'x@y.test', canonicalId: 'ACC-0009' }]);
    assert.equal(refused.problem.rule, 'shape');
    assert.equal(refused.problem.index, 1);
    assert.ok(!refused.problem.message.includes('x@y.test'), 'the refusal never repeats the value');
    assert.equal(await table.findBySystemKey(scope, 'ace-erp', 'account_number', 'ACC-0001'), undefined, 'nothing was written');
  });

  await suite.test('a contact is keyed by its account and a salted hash of the lower-case email: the table holds no readable address; no email, no key', async () => {
    const SALT = 'TEST FIXTURE ONLY salt';
    const expected = createHmac('sha256', SALT).update('grace.hartley@example.test', 'utf8').digest('hex');
    const hash = contactKeyHash('Grace.Hartley@Example.TEST', SALT)!;
    assert.equal(hash, expected, 'an HMAC-SHA-256 of the lower-case address, keyed by the salt');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(contactKeyHash('  grace.hartley@example.test ', SALT), hash, 'case and the ends do not change the key');
    assert.notEqual(contactKeyHash('grace.hartley@example.test', 'another salt'), hash, 'the salt matters');
    assert.notEqual(contactKeyHash('grace.hartley2@example.test', SALT), hash);
    for (const none of ['', '   ', undefined, null]) assert.equal(contactKeyHash(none as any, SALT), undefined, `${none}`);
    for (const salt of ['', '   ', undefined, null, 42]) assert.throws(() => contactKeyHash('a@b.test', salt as any), /needs a salt/, `${salt}`);
    assert.throws(() => contactKeyValue('ACC-0001', undefined, ''), /needs a salt/, 'no salt, no default, even with no email');
    assert.ok(!hash.includes('hartley') && !hash.includes('@'));

    const key = contactKeyValue('ACC-0001', 'grace.hartley@example.test', SALT)!;
    assert.equal(key, contactCanonicalId('ACC-0001', hash));
    assert.equal(key, `ACC-0001:${hash}`);
    assert.equal(contactKeyValue('ACC-0001', '', SALT), undefined);
    assert.equal(contactKeyValue('ACC-0001', null, SALT), undefined);
    assert.notEqual(contactKeyValue('ACC-0002', 'grace.hartley@example.test', SALT), key, 'one person at two accounts is two contacts');
    assert.equal(isKeyedUnder(key, 'ACC-0001'), true);
    assert.equal(isKeyedUnder(key, 'ACC-0002'), false);
    assert.equal(isKeyedUnder(key, 'ACC-000'), false);
    assert.equal(isKeyedUnder('ACC-0001', 'ACC-0001'), false, 'the account itself is not keyed under itself');
    assert.equal(isKeyedUnder('ACC-00011:abc', 'ACC-0001'), false);

    const table = new MemoryKeyRepository();
    const contact = row({ thing: 'Contact', canonicalId: key, system: 'salesforce', keyKind: 'contact_key', systemKey: 'CONTACT-0001' });
    assert.deepEqual(await table.upsertMany([contact]), { ok: true, inserted: 1, updated: 0 });
    const stored = JSON.stringify(await table.findByCanonicalId({ ...scope, thing: 'Contact' }, key));
    assert.ok(!/grace|hartley|example\.test|@/i.test(stored), 'nothing readable about the person is stored');
    const withEmail: any = await table.upsertMany([{ ...contact, systemKey: 'CONTACT-0002', canonicalId: 'ACC-0001:grace.hartley@example.test' }]);
    assert.equal(withEmail.problem.rule, 'shape', 'a row that carries the address itself is refused');
  });

  await suite.test('the deletion path removes the rows of one account in one tenant and environment, and the rows keyed under it, and nothing else', async () => {
    const SALT = 'TEST FIXTURE ONLY salt';
    const contactOf = (account: string, email: string, tenantId = TENANT, environmentId: any = ENV) => row({
      tenantId, environmentId, thing: 'Contact', canonicalId: contactKeyValue(account, email, SALT)!, system: 'salesforce', keyKind: 'contact_key', systemKey: `C-${account}-${email.length}`,
    });
    const account = (id: string, tenantId = TENANT, environmentId: any = ENV) => [
      row({ tenantId, environmentId, canonicalId: id, system: 'ace-erp', keyKind: 'account_number', systemKey: id }),
      row({ tenantId, environmentId, canonicalId: id, system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId(id) }),
      row({ tenantId, environmentId, canonicalId: id, system: 'commercetools', keyKind: 'ct_unit_key', systemKey: id.toLowerCase(), role: 'primary' }),
      row({ tenantId, environmentId, canonicalId: id, system: 'commercetools', keyKind: 'ct_unit_key', systemKey: `${id.toLowerCase()}-div1`, role: 'division', parentSystemKey: id.toLowerCase() }),
    ];
    const table = await tableWith([
      ...account('ACC-0001'), ...account('ACC-0002'), ...account('ACC-0001', 'other-tenant'), ...account('ACC-0001', TENANT, 'production'),
      contactOf('ACC-0001', 'a@example.test'), contactOf('ACC-0001', 'bb@example.test'), contactOf('ACC-0002', 'a@example.test'),
      contactOf('ACC-0001', 'a@example.test', 'other-tenant'), contactOf('ACC-0001', 'a@example.test', TENANT, 'production'),
    ]);
    const contactScope: KeyScope = { ...scope, thing: 'Contact' };
    assert.equal(await table.deleteByAccount(scope, 'ACC-0001'), 4, 'without keyedUnder only the account\'s own rows, divisions included');
    assert.equal((await table.findByCanonicalId(scope, 'ACC-0001')).length, 0);
    assert.equal((await table.findByCanonicalId(contactScope, contactKeyValue('ACC-0001', 'a@example.test', SALT)!)).length, 1, 'the contact rows are still there');
    assert.equal(await table.deleteByAccount(scope, 'ACC-0001', ['Contact']), 2, 'then the contacts keyed under the account');
    assert.equal((await table.findByCanonicalId(contactScope, contactKeyValue('ACC-0001', 'a@example.test', SALT)!)).length, 0);
    assert.equal((await table.findByCanonicalId(contactScope, contactKeyValue('ACC-0002', 'a@example.test', SALT)!)).length, 1, 'another account\'s contact stays');
    assert.equal((await table.findByCanonicalId(scope, 'ACC-0002')).length, 4, 'another account stays');
    assert.equal((await table.findByCanonicalId({ ...scope, tenantId: 'other-tenant' }, 'ACC-0001')).length, 4, 'another tenant stays');
    assert.equal((await table.findByCanonicalId({ ...scope, environmentId: 'production' }, 'ACC-0001')).length, 4, 'another environment stays');
    assert.equal(await table.deleteByAccount(scope, 'ACC-0001'), 0, 'nothing left to delete');
  });

  // ── resolving by a key ─────────────────────────────────────────────────────────────────────
  await suite.test('by a key: one when its row is matched, in the key kind\'s case and trimmed; none when no row holds it; the same canonical id through two systems is one', async () => {
    const table = await tableWith(sampleRows());
    const deps = depsOf(table);
    for (const value of ['ACC-0001', 'acc-0001', '  ACC-0001  ']) {
      const result = await resolveSubject(deps, keyRequest('account_number', value));
      assert.equal(result.outcome, 'one', value);
      assert.equal(result.canonicalId, 'ACC-0001');
      assert.equal(result.by, 'key');
      assert.deepEqual(result.candidates, [{ canonicalId: 'ACC-0001', status: 'matched', evidence: ['real_field'], systems: [{ system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001' }] }]);
      assert.deepEqual([result.notes, result.setAside, result.missing, result.cut], [[], [], [], []]);
    }
    const bySalesforce = await resolveSubject(deps, keyRequest('sf_account_id', sfId('ACC-0012')));
    assert.equal(bySalesforce.outcome, 'one');
    assert.equal(bySalesforce.canonicalId, 'ACC-0012');
    assert.deepEqual(bySalesforce.candidates[0].evidence, ['text_note'], 'the evidence of the row is passed on');
    const missing = await resolveSubject(deps, keyRequest('account_number', 'ACC-0999'));
    assert.equal(missing.outcome, 'none');
    assert.deepEqual(missing.candidates, []);
    assert.equal(missing.canonicalId, undefined);
    assert.match(missing.notes.join(' '), /No key row holds that account_number in ace-erp/);
    // The same kind held by two systems that agree.
    const twoSystems: KeyKindRule[] = [
      { kind: 'shared_id', system: 'sys-a', use: 'own_id', caseRule: 'as_is', ready: true }, { kind: 'shared_id', system: 'sys-b', use: 'own_id', caseRule: 'as_is', ready: true },
    ];
    const shared = await tableWith([
      row({ canonicalId: 'ACC-0001', system: 'sys-a', keyKind: 'shared_id', systemKey: 'X1' }), row({ canonicalId: 'ACC-0001', system: 'sys-b', keyKind: 'shared_id', systemKey: 'X1' }),
    ]);
    const agreed = await resolveSubject(depsOf(shared, twoSystems), keyRequest('shared_id', 'X1'));
    assert.deepEqual([agreed.outcome, agreed.canonicalId, agreed.candidates.length, agreed.candidates[0].systems.length], ['one', 'ACC-0001', 1, 2]);
    const disagreed = await tableWith([
      row({ canonicalId: 'ACC-0001', system: 'sys-a', keyKind: 'shared_id', systemKey: 'X1' }), row({ canonicalId: 'ACC-0002', system: 'sys-b', keyKind: 'shared_id', systemKey: 'X1' }),
    ]);
    const split = await resolveSubject(depsOf(disagreed, twoSystems), keyRequest('shared_id', 'X1'));
    assert.equal(split.outcome, 'several', 'two systems give two accounts for one key');
    assert.deepEqual(ids(split), ['ACC-0001', 'ACC-0002']);
    assert.equal(split.canonicalId, undefined);
    assert.match(split.notes.join(' '), /More than one account fits/);
  });

  await suite.test('by a key whose row is not matched: a candidate or a conflict is several with a note, a retired row is no row', async () => {
    const make = async (status: KeyRow['status'], evidence: KeyRow['evidence'] = 'real_field') => depsOf(await tableWith([
      row({ canonicalId: 'ACC-0001', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0001', status, evidence }),
    ]));
    const candidate = await resolveSubject(await make('candidate', 'name_only'), keyRequest('account_number', 'ACC-0001'));
    assert.equal(candidate.outcome, 'several');
    assert.equal(candidate.canonicalId, undefined, 'a candidate is never "the one"');
    assert.deepEqual(candidate.candidates.map((entry) => [entry.canonicalId, entry.status, entry.evidence]), [['ACC-0001', 'candidate', ['name_only']]]);
    assert.match(candidate.notes.join(' '), /rests on a name alone/);
    const conflict = await resolveSubject(await make('conflict'), keyRequest('account_number', 'ACC-0001'));
    assert.equal(conflict.outcome, 'several');
    assert.equal(conflict.candidates[0].status, 'conflict');
    assert.match(conflict.notes.join(' '), /systems disagree/);
    const retired = await resolveSubject(await make('retired'), keyRequest('account_number', 'ACC-0001'));
    assert.equal(retired.outcome, 'none', 'a retired row stops resolving');
  });

  await suite.test('by a key that cannot be tried: an unknown kind, a kind only a reference, a kind no system holds yet, a value of the wrong shape or too long', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const refusal = async (keyKind: string, value: unknown) => {
      const result = await resolveSubject(deps, keyRequest(keyKind, value));
      assert.equal(result.outcome, 'refused', `${keyKind} ${String(value).slice(0, 20)}`);
      assert.deepEqual([result.candidates, result.canonicalId], [[], undefined]);
      assert.equal(result.notes.length, 1);
      assert.ok(!result.notes[0].includes(String(value).slice(0, 12)) || String(value).length < 3, 'the note does not repeat the value');
      return result.refusal;
    };
    assert.equal(await refusal('nonsense', 'ACC-0001'), 'unknown_key_kind');
    assert.equal(await refusal('zd_org_id', '123'), 'key_not_ready', 'the organisation id: the ERP only points at it, and Zendesk has no organisations yet');
    assert.equal(await refusal('sf_account_number', 'ACC-0001'), 'unknown_key_kind', 'the planned Salesforce field holds the account number, a kind of its own it is not');
    assert.equal(await refusal('zd_org_external_id', 'ACC-0001'), 'unknown_key_kind', 'nor is the planned Zendesk external id');
    const plannedOnly = kinds.map((rule) => (rule.system === 'ace-erp' && rule.kind === 'account_number' ? { ...rule, ready: false } : rule));
    const planned = await resolveSubject(depsOf(await tableWith(sampleRows()), plannedOnly), keyRequest('account_number', 'ACC-0001'));
    assert.deepEqual([planned.outcome, planned.refusal], ['refused', 'key_not_ready'], 'a kind whose every field is planned');
    for (const value of ['ACC-1', 'ACC-00001', 'Talbot & Nguyen', '', '   ', null, undefined, 1.5, {}, [], 'A'.repeat(MAX_PATTERN_INPUT_LENGTH + 1)]) assert.equal(await refusal('account_number', value), 'bad_key_value');
    const onlyReference: KeyKindRule[] = [{ kind: 'only_ref', system: 'sys-a', use: 'reference', caseRule: 'as_is', ready: true }];
    const result = await resolveSubject(depsOf(new MemoryKeyRepository(), onlyReference), keyRequest('only_ref', 'X'));
    assert.deepEqual([result.outcome, result.refusal], ['refused', 'unknown_key_kind'], 'a reference names another system\'s record: it is not a way to look an account up');
  });

  await suite.test('the account number is one kind in three systems: a lookup asks the systems whose field is ready, and a planned Salesforce or Zendesk field joins once it is', async () => {
    const sharedRows = (salesforceOwner = 'ACC-0001') => [
      ...sampleRows(),
      row({ canonicalId: salesforceOwner, system: 'salesforce', keyKind: 'account_number', systemKey: 'ACC-0001' }),
      row({ canonicalId: 'ACC-0001', system: 'zendesk', keyKind: 'account_number', systemKey: 'ACC-0001' }),
    ];
    const readyIn = (...systems: string[]) => kinds.map((rule) => (rule.kind === 'account_number' && systems.includes(rule.system) ? { ...rule, ready: true } : rule));
    const systemsOf = (result: ResolveResult) => result.candidates.flatMap((candidate) => candidate.systems.map((ref) => ref.system));
    const table = await tableWith(sharedRows());

    const today = await resolveSubject(depsOf(table), keyRequest('account_number', 'ACC-0001'));
    assert.equal(today.outcome, 'one');
    assert.deepEqual(systemsOf(today), ['ace-erp'], 'only the ERP\'s field is ready: the planned fields are not asked, though rows for them exist');
    const later = await resolveSubject(depsOf(table, readyIn('salesforce', 'zendesk')), keyRequest('account_number', ' acc-0001 '));
    assert.deepEqual([later.outcome, later.canonicalId], ['one', 'ACC-0001']);
    assert.deepEqual(systemsOf(later), ['ace-erp', 'salesforce', 'zendesk'], 'the same kind is looked up in every system whose field is ready');
    const onlySalesforce = await resolveSubject(depsOf(table, readyIn('salesforce')), keyRequest('account_number', 'ACC-0001'));
    assert.deepEqual(systemsOf(onlySalesforce), ['ace-erp', 'salesforce']);

    const disagreeing = await resolveSubject(depsOf(await tableWith(sharedRows('ACC-0002')), readyIn('salesforce')), keyRequest('account_number', 'ACC-0001'));
    assert.deepEqual([disagreeing.outcome, disagreeing.canonicalId, ids(disagreeing)], ['several', undefined, ['ACC-0001', 'ACC-0002']], 'two systems that name different accounts for one number: it never chooses');
    assert.match(disagreeing.notes.join(' '), /More than one account fits/);

    // By name: a hit that Salesforce names by its account number field joins only once that field is ready.
    const erp = await ask('ace-erp', 'Talbot & Nguyen');
    const salesforce = await ask('salesforce', 'Talbot & Nguyen');
    const byField: ResolveSystemAnswer = { ...salesforce, hits: salesforce.hits.map((hit) => ({ ...hit, keyKind: 'account_number', systemKey: 'acc-0001' })) };
    const request = byName('Talbot & Nguyen', [erp, byField], ['ace-erp', 'salesforce']);
    const before = await resolveSubject(depsOf(table), request);
    assert.equal(before.outcome, 'several', 'the planned field is not ready: the hit joins nothing');
    assert.deepEqual(before.candidates.map((candidate) => candidate.canonicalId), ['ACC-0001', null]);
    const after = await resolveSubject(depsOf(table, readyIn('salesforce')), request);
    assert.deepEqual([after.outcome, after.canonicalId, systemsOf(after)], ['one', 'ACC-0001', ['ace-erp', 'salesforce']], 'ready: the hit is read in the kind\'s case and joins its row');
    assert.deepEqual(after.candidates[0].systems.map((ref) => ref.systemKey), ['ACC-0001', 'ACC-0001']);
  });

  // ── resolving by a name, against the sample systems ────────────────────────────────────────
  await suite.test('the sample systems know the same 30 accounts, and ask for a name returns what their own finder returns', async () => {
    assert.deepEqual(salesforceAccounts.map((account) => account.accountId).sort(), erpAccounts.map((account) => account.accountId).sort());
    const erpHits = await ask('ace-erp', 'Hartley');
    const sfHits = await ask('salesforce', 'Hartley');
    assert.deepEqual(erpHits.hits.map((hit) => hit.systemKey).sort(), ['ACC-0012', 'ACC-0024']);
    assert.deepEqual(sfHits.hits.map((hit) => hit.systemKey).sort(), [sfId('ACC-0002'), sfId('ACC-0012'), sfId('ACC-0024')].sort(), 'Salesforce also finds a contact called Grace Hartley, on ACC-0002');
    assert.equal(salesforceAccounts.find((account) => account.accountId === 'ACC-0002')!.name.toLowerCase().includes('hartley'), false, 'ACC-0002 has no Hartley in its name');
    assert.deepEqual([erpHits.cut, sfHits.cut], [false, false]);
  });

  await suite.test('"Hartley": a word that two account names share gives several, never one, and the match through a contact is set aside, not dropped', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const result = await resolveSubject(deps, byName('Hartley', [await ask('ace-erp', 'Hartley'), await ask('salesforce', 'Hartley')]));
    assert.equal(result.outcome, 'several');
    assert.equal(result.canonicalId, undefined);
    assert.deepEqual(ids(result), ['ACC-0012', 'ACC-0024'], 'Hartley & Sutherland and Hartley & Hartley');
    assert.ok(result.candidates.every((candidate) => candidate.status === 'matched' && candidate.systems.length === 2), 'each is known to both systems, and both rows are matched');
    assert.deepEqual(result.setAside, [{ system: 'salesforce', keyKind: 'sf_account_id', systemKey: sfId('ACC-0002') }], 'the hit through the contact Grace Hartley');
    assert.match(result.notes.join(' '), /More than one account fits/);
    assert.match(result.notes.join(' '), /without these words in the name/);
    assert.deepEqual([result.missing, result.cut], [[], []]);
    assert.ok(!JSON.stringify(result).includes('Hartley'), 'no name is in the result');
  });

  await suite.test('the more of the name is given, the fewer fit: Hartley & Sutherland, Hartley & Hartley, Ormond & Harlow with Builders or Joinery', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const resolve = async (words: string) => resolveSubject(deps, byName(words, [await ask('ace-erp', words), await ask('salesforce', words)]));
    const cases: Array<[string, string, string[]]> = [
      ['Hartley & Sutherland', 'one', ['ACC-0012']], ['Hartley & Hartley', 'one', ['ACC-0024']], ['hartley & hartley concrete', 'one', ['ACC-0024']],
      ['Ormond & Harlow', 'several', ['ACC-0008', 'ACC-0026']], ['Ormond & Harlow Builders', 'one', ['ACC-0008']], ['Ormond & Harlow Joinery', 'one', ['ACC-0026']],
      ['Whittle & Ngata', 'one', ['ACC-0004']], ['Ngata & Whittle', 'one', ['ACC-0007']],
      ['Talbot & Nguyen', 'one', ['ACC-0001']], ['Talbot & Nguyen Concrete Ltd', 'one', ['ACC-0001']],
    ];
    for (const [words, outcome, expected] of cases) {
      const result = await resolve(words);
      assert.equal(result.outcome, outcome, words);
      assert.deepEqual(ids(result), expected, words);
      assert.equal(result.canonicalId, outcome === 'one' ? expected[0] : undefined, words);
      assert.equal(result.by, 'name');
    }
  });

  await suite.test('the word "and" and the sign "&" are one token: the words may be typed either way, whichever way the system\'s own finder was asked', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const answers = [await ask('ace-erp', 'Talbot & Nguyen'), await ask('salesforce', 'Talbot & Nguyen')];
    for (const words of ['Talbot & Nguyen', 'talbot and nguyen', 'TALBOT AND NGUYEN', 'Talbot&Nguyen', 'talbot  and  nguyen concrete']) {
      const result = await resolveSubject(deps, byName(words, answers));
      assert.deepEqual([result.outcome, result.canonicalId], ['one', 'ACC-0001'], words);
    }
    const typedWithAnd = await ask('ace-erp', 'Talbot and Nguyen');
    assert.deepEqual(typedWithAnd.hits, [], 'the sample finder looks for the word "and" in the name and finds none: the engine must ask it without the joining word');
  });

  await suite.test('"Whittle & Ngata" and "Ngata & Whittle" are different names: the systems find both for either, the name rule keeps the one; the shared words give several', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const sameBag = await ask('ace-erp', 'Whittle & Ngata');
    assert.deepEqual(sameBag.hits.map((hit) => hit.systemKey).sort(), ['ACC-0004', 'ACC-0007'], 'the finder ignores word order');
    const a = await resolveSubject(deps, byName('Whittle & Ngata', [sameBag, await ask('salesforce', 'Whittle & Ngata')]));
    assert.deepEqual([a.outcome, a.canonicalId], ['one', 'ACC-0004']);
    assert.deepEqual(a.setAside.map((ref) => ref.systemKey).sort(), ['ACC-0007', sfId('ACC-0007')].sort());
    const b = await resolveSubject(deps, byName('Ngata & Whittle', [await ask('ace-erp', 'Ngata & Whittle'), await ask('salesforce', 'Ngata & Whittle')]));
    assert.deepEqual([b.outcome, b.canonicalId], ['one', 'ACC-0007']);
    for (const word of ['Whittle', 'Ngata']) {
      const result = await resolveSubject(deps, byName(word, [await ask('ace-erp', word), await ask('salesforce', word)]));
      const expected = erpAccounts.filter((account) => nameContainsWords(account.name, word)).map((account) => account.accountId).sort();
      assert.equal(result.outcome, 'several', word);
      assert.deepEqual(ids(result), expected, word);
      assert.ok(expected.includes('ACC-0004') && expected.includes('ACC-0007'), word);
    }
  });

  await suite.test('"Talbot & Nguyen" is ACC-0001 only with full coverage and a matched row; one system silent, one answer cut, or no expected system at all gives several', async () => {
    const table = await tableWith(sampleRows());
    const deps = depsOf(table);
    const [erp, salesforce] = [await ask('ace-erp', 'Talbot & Nguyen'), await ask('salesforce', 'Talbot & Nguyen')];
    const full = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce]));
    assert.deepEqual([full.outcome, full.canonicalId, full.missing, full.cut, full.notes], ['one', 'ACC-0001', [], [], []]);
    assert.deepEqual(full.candidates[0].systems.map((ref) => ref.system), ['ace-erp', 'salesforce']);

    const silent = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, { system: 'salesforce', answered: false, hits: [] }]));
    assert.deepEqual([silent.outcome, silent.canonicalId, silent.missing], ['several', undefined, ['salesforce']]);
    assert.deepEqual(ids(silent), ['ACC-0001'], 'the candidate is shown, not chosen');
    assert.match(silent.notes.join(' '), /salesforce did not answer/);
    const silentErp = await resolveSubject(deps, byName('Talbot & Nguyen', [{ system: 'ace-erp', answered: false, hits: erp.hits }, salesforce]));
    assert.deepEqual([silentErp.outcome, silentErp.missing], ['several', ['ace-erp']], 'the hits of a system that did not answer are ignored');
    assert.deepEqual(silentErp.candidates.map((candidate) => candidate.systems.map((ref) => ref.system)), [['salesforce']]);
    const absent = await resolveSubject(deps, byName('Talbot & Nguyen', [erp]));
    assert.deepEqual([absent.outcome, absent.missing], ['several', ['salesforce']], 'a system with no answer at all is missing');

    const cut = await resolveSubject(deps, byName('Talbot & Nguyen', [{ ...erp, cut: true }, salesforce]));
    assert.deepEqual([cut.outcome, cut.cut, cut.canonicalId], ['several', ['ace-erp'], undefined]);
    assert.match(cut.notes.join(' '), /ace-erp returned only part of its matches/);
    const realCut = [await ask('ace-erp', 'Talbot', 1), await ask('salesforce', 'Talbot', 1)];
    assert.deepEqual(realCut.map((answer) => answer.cut), [true, true], 'asking for one of several makes the sample finder\'s own totals differ from what it returned');
    const cutResult = await resolveSubject(deps, byName('Harlow & Talbot', [await ask('ace-erp', 'Harlow & Talbot', 1), await ask('salesforce', 'Harlow & Talbot', 1)]));
    assert.equal(cutResult.outcome, 'one', 'one real hit that is not cut is complete');
    const notExpectedButCut = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce, { system: 'zendesk', answered: true, cut: true, hits: [] }]));
    assert.deepEqual([notExpectedButCut.outcome, notExpectedButCut.cut], ['several', ['zendesk']], 'a cut answer from any system that did answer counts');
    const noneExpected = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce], []));
    assert.equal(noneExpected.outcome, 'several');
    assert.match(noneExpected.notes.join(' '), /No system is named as holding a record/);

    const withZendesk = ['ace-erp', 'salesforce', 'zendesk'];
    const quiet = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce, { system: 'zendesk', answered: true, hits: [] }], withZendesk));
    assert.equal(quiet.outcome, 'one', 'a system that answered with no match is covered');
    const noAnswer = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce], withZendesk));
    assert.deepEqual([noAnswer.outcome, noAnswer.missing], ['several', ['zendesk']]);
    const twice = await resolveSubject(deps, byName('Talbot & Nguyen', [erp, salesforce, { system: 'salesforce', answered: false, hits: [] }]));
    assert.deepEqual([twice.outcome, twice.missing], ['several', ['salesforce']], 'if a system is listed twice, one silence makes it silent');
  });

  await suite.test('a name that no hit carries is none; a name with the right words in the wrong form is none, with the hits set aside to be shown', async () => {
    const deps = depsOf(await tableWith(sampleRows()));
    const nobody = await resolveSubject(deps, byName('Zzyzx Holdings', [await ask('ace-erp', 'Zzyzx'), await ask('salesforce', 'Zzyzx')]));
    assert.deepEqual([nobody.outcome, nobody.candidates, nobody.setAside], ['none', [], []]);
    const noAnswer = await resolveSubject(deps, byName('Zzyzx Holdings', [{ system: 'ace-erp', answered: false, hits: [] }, await ask('salesforce', 'Zzyzx')]));
    assert.deepEqual([noAnswer.outcome, noAnswer.missing], ['none', ['ace-erp']], 'none, but the note says the search did not cover every system');
    assert.match(noAnswer.notes.join(' '), /ace-erp did not answer/);
    const noAnd = await resolveSubject(deps, byName('Talbot Nguyen', [await ask('ace-erp', 'Talbot Nguyen'), await ask('salesforce', 'Talbot Nguyen')]));
    assert.equal(noAnd.outcome, 'none', 'Talbot Nguyen is not a run of the words of "Talbot & Nguyen Concrete Ltd"');
    assert.equal(noAnd.setAside.length, 2, 'both systems found it, and both hits are listed');
    for (const words of ['', '   ', '!!! ...', undefined, null, 12]) {
      const result = await resolveSubject(deps, byName(words as any, [await ask('ace-erp', 'Talbot')]));
      assert.deepEqual([result.outcome, result.refusal, result.candidates], ['refused', 'no_words', []], String(words));
    }
  });

  await suite.test('a hit the key table does not know, a hit with an unreadable id, and a link that is only a candidate, a conflict or points elsewhere all stop "one"', async () => {
    const erp = await ask('ace-erp', 'Talbot & Nguyen');
    const salesforce = await ask('salesforce', 'Talbot & Nguyen');
    const without = (system: string, keyKind: string) => sampleRows().filter((entry) => !(entry.system === system && entry.keyKind === keyKind && entry.canonicalId === 'ACC-0001'));
    const notInTable = await resolveSubject(depsOf(await tableWith(without('salesforce', 'sf_account_id'))), byName('Talbot & Nguyen', [erp, salesforce]));
    assert.equal(notInTable.outcome, 'several', 'the Salesforce record might be another account: it is not in the key table');
    assert.deepEqual(notInTable.candidates.map((candidate) => [candidate.canonicalId, candidate.status]), [['ACC-0001', 'matched'], [null, 'none']]);
    assert.match(notInTable.notes.join(' '), /salesforce returned a record that is not in the key table/);

    const unreadable: ResolveSystemAnswer = { ...salesforce, hits: salesforce.hits.map((hit) => ({ ...hit, systemKey: 'not an id' })) };
    const bad = await resolveSubject(depsOf(await tableWith(sampleRows())), byName('Talbot & Nguyen', [erp, unreadable]));
    assert.deepEqual([bad.outcome, bad.candidates.map((candidate) => candidate.canonicalId)], ['several', ['ACC-0001', null]]);
    const plannedField: ResolveSystemAnswer = { ...salesforce, hits: salesforce.hits.map((hit) => ({ ...hit, keyKind: 'account_number', systemKey: 'ACC-0001' })) };
    const withPlannedRow = [...sampleRows(), row({ canonicalId: 'ACC-0001', system: 'salesforce', keyKind: 'account_number', systemKey: 'ACC-0001' })];
    const planned = await resolveSubject(depsOf(await tableWith(withPlannedRow)), byName('Talbot & Nguyen', [erp, plannedField]));
    assert.equal(planned.outcome, 'several', 'a hit named by a field that is not ready cannot be joined, even when a row for it exists');
    const referenceKind: ResolveSystemAnswer = { system: 'ace-erp', answered: true, hits: erp.hits.map((hit) => ({ ...hit, keyKind: 'ct_unit_key', systemKey: 'acc-0001' })) };
    const reference = await resolveSubject(depsOf(await tableWith(sampleRows())), byName('Talbot & Nguyen', [referenceKind, salesforce]));
    assert.equal(reference.outcome, 'several', 'a reference to another system\'s record does not name a record in this one');

    for (const status of ['candidate', 'conflict'] as const) {
      const rows = sampleRows().map((entry) => (entry.system === 'salesforce' && entry.canonicalId === 'ACC-0001' ? { ...entry, status } : entry));
      const result = await resolveSubject(depsOf(await tableWith(rows)), byName('Talbot & Nguyen', [erp, salesforce]));
      assert.equal(result.outcome, 'several', status);
      assert.deepEqual(result.candidates.map((candidate) => [candidate.canonicalId, candidate.status]), [['ACC-0001', status]], 'the weakest row sets the status');
      assert.equal(result.canonicalId, undefined);
    }
    const retired = sampleRows().map((entry) => (entry.system === 'salesforce' && entry.canonicalId === 'ACC-0001' ? { ...entry, status: 'retired' as const } : entry));
    const gone = await resolveSubject(depsOf(await tableWith(retired)), byName('Talbot & Nguyen', [erp, salesforce]));
    assert.equal(gone.outcome, 'several', 'a retired row is no row: the Salesforce hit is not in the key table');
    assert.deepEqual(gone.candidates.map((candidate) => candidate.canonicalId), ['ACC-0001', null]);

    const elsewhere = sampleRows().map((entry) => (entry.system === 'salesforce' && entry.canonicalId === 'ACC-0001' ? { ...entry, canonicalId: 'ACC-0002', role: 'alias' as const } : entry));
    const stale = await resolveSubject(depsOf(await tableWith(elsewhere)), byName('Talbot & Nguyen', [erp, salesforce]));
    assert.equal(stale.outcome, 'several', 'the two systems\' rows name two different accounts');
    assert.deepEqual(ids(stale), ['ACC-0001', 'ACC-0002']);
    assert.match(stale.notes.join(' '), /More than one account fits/);
  });

  await suite.test('a division and its parent are one account; a record listed twice is one hit', async () => {
    const accountRows = [
      row({ canonicalId: 'ACC-0004', system: 'ace-erp', keyKind: 'account_number', systemKey: 'ACC-0004' }),
      row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004' }),
      row({ canonicalId: 'ACC-0004', system: 'commercetools', keyKind: 'ct_unit_key', systemKey: 'acc-0004-div1', role: 'division', parentSystemKey: 'acc-0004' }),
    ];
    const deps = depsOf(await tableWith(accountRows));
    const name = nameOf('ACC-0004');
    const erp: ResolveSystemAnswer = { system: 'ace-erp', answered: true, hits: [{ keyKind: 'account_number', systemKey: 'ACC-0004', name }, { keyKind: 'account_number', systemKey: 'acc-0004', name }] };
    const commercetools: ResolveSystemAnswer = {
      system: 'commercetools', answered: true,
      hits: [{ keyKind: 'ct_unit_key', systemKey: 'acc-0004', name }, { keyKind: 'ct_unit_key', systemKey: 'ACC-0004-DIV1', name: `${name} - Division 1` }, { keyKind: 'ct_unit_key', systemKey: 'acc-0004-div1', name: `${name} - Division 1` }],
    };
    const result = await resolveSubject(deps, byName('Whittle & Ngata Plumbing', [erp, commercetools], ['ace-erp', 'commercetools']));
    assert.deepEqual([result.outcome, result.canonicalId, result.candidates.length], ['one', 'ACC-0004', 1]);
    assert.deepEqual(result.candidates[0].systems.map((ref) => `${ref.system}:${ref.systemKey}`), ['ace-erp:ACC-0004', 'commercetools:acc-0004', 'commercetools:acc-0004-div1'], 'listed once each, in the key kind\'s case');
  });

  await suite.test('the resolver only reads: it calls findBySystemKey and nothing else, and leaves the table as it found it', async () => {
    const inner = await tableWith(sampleRows());
    const calls: string[] = [];
    const spy = new Proxy(inner, { get: (target, property, receiver) => { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? (...args: unknown[]) => { calls.push(String(property)); return value.apply(target, args); } : value; } }) as KeyRepository;
    const deps = depsOf(spy);
    await resolveSubject(deps, keyRequest('account_number', 'ACC-0001'));
    await resolveSubject(deps, keyRequest('account_number', 'ACC-0999'));
    await resolveSubject(deps, byName('Hartley', [await ask('ace-erp', 'Hartley'), await ask('salesforce', 'Hartley')]));
    await resolveSubject(deps, byName('', []));
    assert.ok(calls.length > 4);
    assert.deepEqual([...new Set(calls)], ['findBySystemKey']);
    const all = await Promise.all(erpAccounts.flatMap((account) => [inner.findBySystemKey(scope, 'ace-erp', 'account_number', account.accountId), inner.findBySystemKey(scope, 'salesforce', 'sf_account_id', sfId(account.accountId))]));
    assert.ok(all.every((entry) => entry && entry.status === 'matched' && entry.lastVerifiedAt === NOW), 'no row changed');
  });

  await suite.test('it never chooses: over random hits, rows and coverage, "one" is exactly the case the rule allows, and the order of the input changes nothing', async () => {
    const systems = ['sys-a', 'sys-b', 'sys-c'];
    const rules: KeyKindRule[] = systems.map((system) => ({ kind: 'rec_id', system, use: 'own_id', caseRule: 'as_is', ready: true }));
    const canonicals = ['ACC-0001', 'ACC-0002', 'ACC-0003'];
    const names = ['Alpha & Beta Ltd', 'Alpha Co', 'Beta Alpha', 'Gamma'];
    const queries = ['Alpha', 'Alpha & Beta', 'Beta', 'Gamma'];
    const statuses: Array<KeyRow['status'] | 'missing'> = ['matched', 'matched', 'matched', 'candidate', 'conflict', 'retired', 'missing'];
    let ones = 0;
    let severalCount = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const next = stream(seed);
      const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)];
      const rows: KeyRow[] = [];
      const answers: ResolveSystemAnswer[] = systems.map((system) => {
        const hits = Array.from({ length: Math.floor(next() * 4) }, () => ({ keyKind: 'rec_id', systemKey: `${system}-${Math.floor(next() * 3)}`, name: pick(names) }));
        return { system, answered: next() > 0.1, cut: next() < 0.1, hits };
      });
      for (const system of systems) for (let index = 0; index < 3; index++) {
        const status = pick(statuses);
        if (status !== 'missing') rows.push(row({ canonicalId: pick(canonicals), system, keyKind: 'rec_id', systemKey: `${system}-${index}`, role: 'alias', status, evidence: status === 'matched' || status === 'retired' || status === 'conflict' ? 'real_field' : 'name_only' }));
      }
      const expectedIn = systems.filter(() => next() > 0.3);
      const words = pick(queries);
      const table = await tableWith(rows);
      const request = byName(words, answers, expectedIn);
      const result = await resolveSubject(depsOf(table, rules), request);

      // The rule, written out again from the rows themselves.
      const live = new Map(rows.filter((entry) => entry.status !== 'retired').map((entry) => [`${entry.system}|${entry.systemKey}`, entry] as const));
      const heard = answers.filter((answer) => answer.answered);
      const covered = expectedIn.length > 0 && expectedIn.every((system) => answers.filter((answer) => answer.system === system).every((answer) => answer.answered)) && heard.every((answer) => !answer.cut);
      const matching = heard.flatMap((answer) => answer.hits.filter((hit) => nameContainsWords(hit.name, words)).map((hit) => live.get(`${answer.system}|${hit.systemKey}`)));
      const everyJoined = matching.length > 0 && matching.every((entry) => entry !== undefined && entry.status === 'matched');
      const accounts = new Set(matching.filter((entry) => entry !== undefined).map((entry) => entry!.canonicalId));
      const allowed = covered && everyJoined && accounts.size === 1;
      assert.equal(result.outcome === 'one', allowed, `seed ${seed}`);
      if (allowed) {
        ones++;
        assert.equal(result.canonicalId, [...accounts][0], `seed ${seed}`);
        assert.equal(result.candidates.length, 1, `seed ${seed}`);
      } else {
        assert.equal(result.canonicalId, undefined, `seed ${seed}`);
        if (matching.length > 0) severalCount++;
        assert.equal(result.outcome, matching.length > 0 ? 'several' : 'none', `seed ${seed}`);
      }
      if (accounts.size > 1) assert.notEqual(result.outcome, 'one', `seed ${seed}: two accounts fit`);

      // The same input in another order is the same answer.
      const reordered = await resolveSubject(depsOf(table, rules), byName(words, [...answers].reverse().map((answer) => ({ ...answer, hits: [...answer.hits].reverse() })), [...expectedIn].reverse()));
      assert.deepEqual(reordered, result, `seed ${seed}`);
      const sorted = ids(result).filter((entry): entry is string => entry !== null);
      assert.deepEqual(sorted, [...sorted].sort(), `seed ${seed}: candidates are listed in id order, not in a chosen order`);
    }
    assert.ok(ones > 20 && severalCount > 100, `the random scenarios reach both outcomes (${ones} one, ${severalCount} several)`);
  });

  // ── the module as a whole ──────────────────────────────────────────────────────────────────
  await suite.test('the module is pure and neutral: it reaches no file, socket or environment, imports only its own files, the model and node:crypto, and holds none of the words the repository guard bans', () => {
    const folder = path.join(WORKTREE, 'packages/jax-iq/src/keys');
    const files = readdirSync(folder).filter((file) => file.endsWith('.ts'));
    assert.deepEqual(files.sort(), ['index.ts', 'memory-repository.ts', 'normalise.ts', 'platform-mapping.ts', 'report.ts', 'repository.ts', 'resolve.ts', 'types.ts']);
    const guard = JSON.parse(readFileSync(path.join(WORKTREE, 'scripts/guard-config.json'), 'utf8'));
    const banned = new RegExp(`\\b(?:${[...guard.forbiddenIndustryTerms, ...guard.forbiddenAttributeNames].join('|')})\\b`, 'i');
    for (const file of files) {
      const source = readFileSync(path.join(folder, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) assert.ok(specifier.startsWith('./') || ['../model', 'node:crypto', 'zod'].includes(specifier), `${file} imports ${specifier}`);
      assert.ok(!/process\.env|\bfetch\(|node:(fs|net|http|https|path|child_process)|require\(/.test(source), `${file} reaches the outside`);
      assert.ok(!/(?:journeys|agents|policies|candidates|stages)\[0\]/.test(source), `${file} picks by position`);
      assert.ok(!banned.test(source), `${file} holds a banned industry word`);
      assert.ok(!/PlaceMakers|Caroma|placemakers|localhost|127\.0\.0\.1|\/Users\/|https?:\/\//.test(source), `${file} names a tenant, address or path`);
    }
  });

  await suite.test('the module index exports the key table, the resolver, the report and the mapping, under names no other module uses', () => {
    const names = ['KEY_ROLES', 'KEY_STATUSES', 'KEY_USES', 'KEY_EVIDENCE_VALUES', 'MAX_PATTERN_INPUT_LENGTH', 'contactCanonicalId', 'contactKeyHash', 'contactKeyValue', 'extractNoteKey', 'isKeyedUnder',
      'nameContainsWords', 'normaliseKeyValue', 'KEY_MAPPING_VERSION', 'KeyMappingEntrySchema', 'KeyMappingSchema', 'canonicalRuleOf', 'checkKeyMapping', 'keyKindDefsOf', 'keyKindRulesOf',
      'parseKeyMapping', 'canonicalKeyId', 'checkKeyRow', 'checkKeyUniqueness', 'systemKeyId', 'MemoryKeyRepository', 'resolveSubject', 'KEY_REPORT_CATEGORIES', 'KEY_REPORT_REASONS', 'buildKeyReport'];
    for (const name of names) assert.ok(name in jaxIq, `${name} is exported from the package`);
    for (const generic of ['resolve', 'normaliseName', 'nameWords', 'applyCaseRule', 'compareIds']) assert.ok(!(generic in jaxIq), `${generic} is not exported by the keys module`);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
