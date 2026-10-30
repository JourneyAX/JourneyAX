import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { KeyKindDefSchema } from '../src/model';
import {
  KEY_MAPPING_VERSION, KeyMappingSchema, MAX_PATTERN_INPUT_LENGTH, canonicalRuleOf, checkKeyMapping, extractNoteKey, keyKindDefsOf, keyKindRulesOf, normaliseKeyValue,
  parseKeyMapping,
} from '../src/keys';
import type { KeyMapping, KeyMappingEntry } from '../src/keys';

/**
 * The table of which platform field feeds which key kind, read from the dictionary folder. The file is data: this code only parses and
 * checks it. The fields the platforms do not hold yet are marked `ready: false` and the key code ignores them. The pattern that reads the
 * account number out of a description is the connector's own.
 */
const suite = createSuite('jax-iq: the account key mapping and the note key');

const WORKTREE = path.resolve(__dirname, '../../..');
const MAPPING_FILE = path.join(WORKTREE, 'docs/agent-instructions/jax-iq/account-keys.mapping.json');
const raw = JSON.parse(readFileSync(MAPPING_FILE, 'utf8'));
const mapping = parseKeyMapping(raw);
const clone = <T>(value: T): T => structuredClone(value);
const erpSeed = JSON.parse(readFileSync(path.join(WORKTREE, 'packages/connectors-sample/connectors/ace-erp/seed.json'), 'utf8'));
const readSource = (relative: string) => readFileSync(path.join(WORKTREE, relative), 'utf8');

/** system, field, kind, use, evidence, ready: the plan's list, one row per field. */
const EXPECTED: Array<[string, string, string, string, string, boolean]> = [
  ['ace-erp', 'accountId', 'account_number', 'number', 'real_field', true],
  ['ace-erp', 'commercetoolsUnitKey', 'ct_unit_key', 'reference', 'real_field', true],
  ['ace-erp', 'salesforceAccountId', 'sf_account_id', 'reference', 'real_field', false],
  ['ace-erp', 'zendeskOrganizationId', 'zd_org_id', 'reference', 'real_field', false],
  ['commercetools', 'unitKey', 'ct_unit_key', 'own_id', 'real_field', true],
  ['commercetools', 'accountNumber', 'ct_account_number', 'number', 'real_field', true],
  ['commercetools', 'salesforceAccountId', 'sf_account_id', 'reference', 'real_field', true],
  ['salesforce', 'accountId', 'sf_account_id', 'own_id', 'real_field', true],
  ['salesforce', 'Description', 'sf_account_note', 'number', 'text_note', true],
  ['salesforce', 'Account_Number__c', 'account_number', 'number', 'real_field', false],
  ['salesforce', 'Commercetools_Unit_Key__c', 'ct_unit_key', 'reference', 'real_field', false],
  ['zendesk', 'tags', 'zd_tag', 'number', 'tag', true],
  ['zendesk', 'organization.id', 'zd_org_id', 'own_id', 'real_field', false],
  ['zendesk', 'organization.external_id', 'account_number', 'number', 'real_field', false],
  ['zendesk', 'organization_fields.commercetools_unit_key', 'ct_unit_key', 'reference', 'real_field', false],
  ['zendesk', 'organization_fields.salesforce_account_id', 'sf_account_id', 'reference', 'real_field', false],
];

const entryOf = (system: string, kind: string): KeyMappingEntry => mapping.keys.find((entry) => entry.system === system && entry.kind === kind)!;
const problemsAfter = (change: (copy: KeyMapping) => void): string[] => {
  const copy = clone(mapping);
  change(copy);
  return checkKeyMapping(copy);
};
const mentions = (problems: string[], text: string) => problems.some((problem) => problem.includes(text));

async function main() {
  await suite.test('the mapping file parses, is consistent and is for the Account with the ERP number as the canonical id', () => {
    assert.equal(mapping.mappingVersion, KEY_MAPPING_VERSION);
    assert.equal(mapping.thing, 'Account');
    assert.deepEqual(mapping.canonical, { kind: 'account_number', system: 'ace-erp' });
    assert.deepEqual(checkKeyMapping(mapping), []);
    assert.deepEqual(KeyMappingSchema.parse(raw), raw, 'the schema adds, drops and rewrites nothing');
  });

  await suite.test('it holds exactly the platform fields of the plan, per platform, and only the planned ones are not ready', () => {
    assert.deepEqual(mapping.keys.map((entry) => [entry.system, entry.field, entry.kind, entry.use, entry.evidence, entry.ready]), EXPECTED);
    assert.deepEqual(
      mapping.keys.filter((entry) => !entry.ready).map((entry) => `${entry.system}:${entry.field}`),
      ['ace-erp:salesforceAccountId', 'ace-erp:zendeskOrganizationId', 'salesforce:Account_Number__c', 'salesforce:Commercetools_Unit_Key__c', 'zendesk:organization.id',
        'zendesk:organization.external_id', 'zendesk:organization_fields.commercetools_unit_key', 'zendesk:organization_fields.salesforce_account_id'],
    );
    assert.deepEqual([...new Set(mapping.keys.map((entry) => entry.system))], ['ace-erp', 'commercetools', 'salesforce', 'zendesk']);
  });

  await suite.test('it follows the plan\'s "mapped into the key table" column, platform by platform: the one account number kind in three systems, and only the ERP\'s unit key ready of the sample ERP\'s links', () => {
    const at = (system: string, field: string) => mapping.keys.find((entry) => entry.system === system && entry.field === field)!;
    const read = (system: string, field: string) => { const entry = at(system, field); return [entry.kind, entry.ready]; };
    // Salesforce: Account_Number__c is the account number, Commercetools_Unit_Key__c the unit key (both planned), the description note its own kind.
    assert.deepEqual(read('salesforce', 'Account_Number__c'), ['account_number', false]);
    assert.deepEqual(read('salesforce', 'Commercetools_Unit_Key__c'), ['ct_unit_key', false]);
    assert.deepEqual(read('salesforce', 'Description'), ['sf_account_note', true]);
    // commercetools.
    assert.deepEqual(read('commercetools', 'unitKey'), ['ct_unit_key', true]);
    assert.deepEqual(read('commercetools', 'accountNumber'), ['ct_account_number', true]);
    assert.deepEqual(read('commercetools', 'salesforceAccountId'), ['sf_account_id', true]);
    // Zendesk: the organisation external id is the account number (planned), the tag its own kind.
    assert.deepEqual(read('zendesk', 'organization.external_id'), ['account_number', false]);
    assert.deepEqual(read('zendesk', 'tags'), ['zd_tag', true]);
    // Sample ERP: the unit key is ready, the other two links are not until they are filled.
    assert.deepEqual(read('ace-erp', 'commercetoolsUnitKey'), ['ct_unit_key', true]);
    assert.deepEqual(read('ace-erp', 'salesforceAccountId'), ['sf_account_id', false]);
    assert.deepEqual(read('ace-erp', 'zendeskOrganizationId'), ['zd_org_id', false]);
    assert.deepEqual(
      mapping.keys.filter((entry) => entry.system === 'ace-erp' && entry.use === 'reference' && entry.ready).map((entry) => entry.field),
      ['commercetoolsUnitKey'],
      'of the sample ERP\'s links only the unit key is ready',
    );
    // The account number is one kind everywhere it is held, so a row and a lookup by that kind mean the same thing in every system.
    assert.deepEqual(
      mapping.keys.filter((entry) => entry.kind === 'account_number').map((entry) => [entry.system, entry.field, entry.ready]),
      [['ace-erp', 'accountId', true], ['salesforce', 'Account_Number__c', false], ['zendesk', 'organization.external_id', false]],
    );
    for (const retired of ['sf_account_number', 'zd_org_external_id']) assert.ok(!mapping.keys.some((entry) => entry.kind === retired), `${retired} is not a key kind of the plan`);
  });

  await suite.test('the key kind definitions are what a thing\'s keyKinds list holds: the model\'s own schema reads them, in the file\'s order', () => {
    const defs = keyKindDefsOf(mapping);
    assert.equal(defs.length, mapping.keys.length);
    assert.ok(defs.length <= 20, 'a thing holds at most 20 key kinds');
    for (const [index, def] of defs.entries()) {
      assert.deepEqual(KeyKindDefSchema.parse(def), def, `${index}`);
      assert.deepEqual(Object.keys(def).sort(), ['caseRule', 'evidence', 'kind', 'pattern', 'ready', 'system'], 'no mapping-only column leaks into the thing');
      assert.equal(def.kind, mapping.keys[index].kind);
      assert.equal(def.ready, mapping.keys[index].ready);
    }
    const rules = keyKindRulesOf(mapping);
    assert.deepEqual(rules.map((rule) => [rule.system, rule.kind, rule.use, rule.ready]), mapping.keys.map((entry) => [entry.system, entry.kind, entry.use, entry.ready]));
    assert.deepEqual(canonicalRuleOf(mapping), { caseRule: 'upper', pattern: entryOf('ace-erp', 'account_number').pattern });
  });

  await suite.test('a reference always has an own id of the same kind to be checked against, and a number always has a pattern', () => {
    for (const entry of mapping.keys.filter((candidate) => candidate.use === 'reference')) {
      assert.ok(mapping.keys.some((other) => other.use === 'own_id' && other.kind === entry.kind), `${entry.system} ${entry.kind}`);
    }
    for (const entry of mapping.keys.filter((candidate) => candidate.use === 'number')) assert.ok(entry.pattern, `${entry.system} ${entry.kind}`);
    assert.equal(mapping.keys.filter((entry) => entry.evidence === 'name_only').length, 0, 'a name is never a mapped field');
  });

  await suite.test('every account in the sample ERP seed reads as a canonical id, and its commercetools unit key as a unit key; empty links read as absent', () => {
    const accounts: any[] = erpSeed.collections.account_balances;
    assert.ok(accounts.length >= 30);
    const number = keyKindRulesOf(mapping).find((rule) => rule.system === 'ace-erp' && rule.kind === 'account_number')!;
    const unit = keyKindRulesOf(mapping).find((rule) => rule.system === 'ace-erp' && rule.kind === 'ct_unit_key')!;
    const salesforce = keyKindRulesOf(mapping).find((rule) => rule.system === 'ace-erp' && rule.kind === 'sf_account_id')!;
    for (const account of accounts) {
      assert.deepEqual(normaliseKeyValue(account.accountId, number), { ok: true, value: account.accountId }, account.accountId);
      assert.deepEqual(normaliseKeyValue(account.commercetoolsUnitKey, unit), { ok: true, value: account.commercetoolsUnitKey }, account.accountId);
      assert.deepEqual(normaliseKeyValue(account.salesforceAccountId, salesforce), { ok: false, reason: 'absent' }, 'the sample has no Salesforce link yet');
    }
    assert.deepEqual(normaliseKeyValue(' acc-0001 ', number), { ok: true, value: 'ACC-0001' }, 'the number is written in upper case');
    assert.deepEqual(normaliseKeyValue('ACC-1', number), { ok: false, reason: 'pattern' });
  });

  await suite.test('the number is read from a description with the connector\'s own pattern, and from the description the loader writes', () => {
    const note = entryOf('salesforce', 'sf_account_note');
    const connector = /const NUMBER_NOTE = \/(.+)\/;/.exec(readSource('packages/connectors-real/src/connectors/salesforce.ts'));
    assert.ok(connector, 'the connector\'s NUMBER_NOTE pattern is still where it was');
    assert.equal(note.extract!.pattern, connector[1], 'the mapping uses the connector\'s pattern, character for character');
    const loader = readSource('packages/connectors-real/scripts/loaders/salesforce.ts');
    assert.ok(loader.includes('Account number ${account.accountId}.'), 'the loader writes the sentence the pattern reads');
    const written = 'Trade type: concreter. Tier: silver. Home branch: 224. Account manager: Hemi Ashworth. Credit limit: 10000. Terms: 20th of the month. Account number ACC-0001. commercetools unit acc-0001. Sample data.';
    assert.ok(written.length < MAX_PATTERN_INPUT_LENGTH, 'a description the loader writes is within the limit');
    assert.deepEqual(extractNoteKey(written, note.extract!, note), { ok: true, value: 'ACC-0001' });
    assert.deepEqual(extractNoteKey('Account number acc-0007. later text', note.extract!, note), { ok: true, value: 'ACC-0007' }, 'read in the key kind\'s case');
  });

  await suite.test('an edited note breaks the note key but not a real field; a missing note is absent, never zero', () => {
    const note = entryOf('salesforce', 'sf_account_note');
    const salesforceId = entryOf('salesforce', 'sf_account_id');
    const edited = ['Account no. ACC-0001.', 'Account number ACC-0001', 'account number ACC-0001.', 'Account number .', 'Account number ACC 0001.', 'Account number ACC-1.', 'Trade type: concreter.'];
    for (const text of edited) {
      const result = extractNoteKey(text, note.extract!, note);
      assert.equal(result.ok, false, text);
      assert.equal((result as any).reason, 'pattern', text);
    }
    for (const missing of [undefined, null, '', '   ', 0, {}, []]) {
      assert.deepEqual(extractNoteKey(missing, note.extract!, note), { ok: false, reason: 'absent' }, String(missing));
    }
    assert.deepEqual(extractNoteKey('Account number ACC-0001.', { pattern: 'Account number ([A-Za-z0-9-]+' }, note), { ok: false, reason: 'pattern' }, 'a pattern that does not compile reads nothing');
    assert.deepEqual(extractNoteKey('Account number ACC-0001.', { pattern: 'Account number ACC-0001\\.' }, note), { ok: false, reason: 'pattern' }, 'no capture group, no value');
    // The real field of the same record is a different key: the edit does not touch it.
    assert.deepEqual(normaliseKeyValue('001TEST00000000ABC', salesforceId), { ok: true, value: '001TEST00000000ABC' });
    assert.deepEqual(normaliseKeyValue(null, salesforceId), { ok: false, reason: 'absent' });
  });

  await suite.test('a pattern is applied only to text up to the one limit; a longer value or note is "too long" and a slow pattern never sees it', () => {
    const note = entryOf('salesforce', 'sf_account_note');
    const number = entryOf('ace-erp', 'account_number');
    const sentence = 'Account number ACC-0001.';
    const atLimit = `${sentence}${' '.repeat(MAX_PATTERN_INPUT_LENGTH - sentence.length)}`;
    assert.equal(atLimit.length, MAX_PATTERN_INPUT_LENGTH);
    assert.deepEqual(extractNoteKey(atLimit, note.extract!, note), { ok: true, value: 'ACC-0001' }, 'exactly at the limit is read');
    assert.deepEqual(extractNoteKey(`${atLimit} `, note.extract!, note), { ok: false, reason: 'too_long' }, 'one more is not');
    assert.deepEqual(normaliseKeyValue('A'.repeat(MAX_PATTERN_INPUT_LENGTH + 1), { caseRule: 'as_is' }), { ok: false, reason: 'too_long' }, 'no pattern, still bounded');
    assert.deepEqual(normaliseKeyValue('ß'.repeat(MAX_PATTERN_INPUT_LENGTH / 2 + 1), { caseRule: 'upper' }), { ok: false, reason: 'too_long' }, 'upper case can make a value longer');
    assert.deepEqual(normaliseKeyValue('A'.repeat(MAX_PATTERN_INPUT_LENGTH), number), { ok: false, reason: 'pattern' }, 'at the limit a pattern is tried and fails');
    // A pattern written to match slowly on a long input of one repeated letter.
    const slow = { caseRule: 'as_is' as const, pattern: '^(a+)+$' };
    const started = Date.now();
    assert.deepEqual(normaliseKeyValue(`${'a'.repeat(MAX_PATTERN_INPUT_LENGTH)}b`, slow), { ok: false, reason: 'too_long' });
    assert.deepEqual(extractNoteKey(`${'a'.repeat(MAX_PATTERN_INPUT_LENGTH)}b`, { pattern: '(a+)+(b)\\.' }, { caseRule: 'as_is' }), { ok: false, reason: 'too_long' });
    assert.ok(Date.now() - started < 200, 'the slow pattern was not run on the long input');
    assert.deepEqual(normaliseKeyValue(12345, { caseRule: 'as_is', pattern: '^\\d+$' }), { ok: true, value: '12345' }, 'a whole number is read as its digits');
    assert.deepEqual(normaliseKeyValue(1.5, { caseRule: 'as_is' }), { ok: false, reason: 'absent' }, 'a fraction is not an id');
    assert.deepEqual(normaliseKeyValue(Number.MAX_SAFE_INTEGER + 2, { caseRule: 'as_is' }), { ok: false, reason: 'absent' }, 'a number too big to be exact is not an id');
  });

  await suite.test('the schema refuses an unknown key, a wrong version, a bad name, no keys and more keys than a thing may hold', () => {
    const refuse = (change: (copy: any) => void, note: string) => {
      const copy: any = clone(raw);
      change(copy);
      assert.throws(() => parseKeyMapping(copy), /not valid/, note);
    };
    refuse((copy) => { copy.extra = 1; }, 'an unknown key on the file');
    refuse((copy) => { copy.keys[0].extra = 1; }, 'an unknown key on an entry');
    refuse((copy) => { copy.canonical.extra = 1; }, 'an unknown key on the canonical entry');
    refuse((copy) => { copy.keys[8].extract.extra = 1; }, 'an unknown key on an extract');
    refuse((copy) => { copy.mappingVersion = '1.0.1'; }, 'another version');
    refuse((copy) => { delete copy.mappingVersion; }, 'no version');
    refuse((copy) => { copy.thing = 'account'; }, 'a thing name in lower case');
    refuse((copy) => { copy.keys = []; }, 'no keys');
    refuse((copy) => { copy.keys = Array.from({ length: 21 }, (_, index) => ({ ...copy.keys[0], field: `field${index}`, kind: `kind_${index}` })); }, 'more than 20 keys');
    refuse((copy) => { copy.keys[0].kind = 'Account Number'; }, 'a key kind with capitals and a space');
    refuse((copy) => { copy.keys[0].system = 'Salesforce'; }, 'a system that is not a connector id');
    refuse((copy) => { copy.keys[0].pattern = '^(ACC'; }, 'a pattern that does not compile');
    refuse((copy) => { copy.keys[0].field = 'bad field'; }, 'a field name with a space');
    refuse((copy) => { copy.keys[0].note = 'two\nlines'; }, 'a note over two lines');
    refuse((copy) => { copy.keys[0].use = 'alias'; }, 'a use that does not exist');
    refuse((copy) => { copy.keys[0].ready = 'yes'; }, 'ready that is not a boolean');
    assert.throws(() => parseKeyMapping('not an object'), /not valid/);
    assert.throws(() => parseKeyMapping(null), /not valid/);
  });

  await suite.test('the consistency check names each problem in plain words', () => {
    assert.ok(mentions(problemsAfter((copy) => { copy.keys[0].evidence = 'name_only'; }), 'name_only'), 'a name is not a mapped field');
    assert.ok(mentions(problemsAfter((copy) => { delete copy.keys[0].pattern; }), 'needs a pattern'), 'a number needs a pattern');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys.find((entry) => entry.kind === 'zd_tag')!.use = 'own_id'; }), 'use must be number'), 'a tag is the number');
    assert.ok(mentions(problemsAfter((copy) => { delete copy.keys.find((entry) => entry.kind === 'sf_account_note')!.extract; }), 'needs an extract'), 'a note needs an extract');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys[0].extract = { pattern: '(ACC)' }; }), 'only a text note'), 'only a note has an extract');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys.find((entry) => entry.kind === 'sf_account_note')!.extract = { pattern: 'Account number [A-Z0-9-]+\\.' }; }), 'exactly one capture group'), 'no group');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys.find((entry) => entry.kind === 'sf_account_note')!.extract = { pattern: '(Account) number ([A-Z0-9-]+)\\.' }; }), 'exactly one capture group'), 'two groups');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys = copy.keys.filter((entry) => !(entry.system === 'salesforce' && entry.kind === 'sf_account_id')); }), 'no own_id entry of that kind'), 'a reference with no owner');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys.push({ ...copy.keys[0], field: 'otherField' }); }), 'is mapped twice for ace-erp'), 'a kind mapped twice for a system');
    assert.ok(mentions(problemsAfter((copy) => { copy.keys.push({ ...copy.keys[1], kind: 'other_kind' }); }), 'the field is mapped twice'), 'a field mapped twice for a system');
    assert.ok(mentions(problemsAfter((copy) => { copy.canonical = { kind: 'account_number', system: 'commercetools' }; }), 'no entry for account_number in commercetools'), 'a canonical entry that is missing');
    assert.deepEqual(problemsAfter((copy) => { copy.canonical = { kind: 'account_number', system: 'salesforce' }; }), [], 'the planned Salesforce field holds the same kind and is a number, so it is a consistent entry');
    assert.ok(mentions(problemsAfter((copy) => { copy.canonical = { kind: 'sf_account_id', system: 'salesforce' }; }), 'must hold the number'), 'a canonical entry that is not a number');
    assert.throws(() => parseKeyMapping({ ...clone(raw), canonical: { kind: 'sf_account_id', system: 'salesforce' } }), /not consistent/);
    const broken = clone(mapping);
    broken.canonical = { kind: 'nothing', system: 'ace-erp' };
    assert.throws(() => canonicalRuleOf(broken), /no entry for the canonical key/);
  });

  await suite.test('every field name is the connector\'s own: the same words are in the connector source and in the loaders', () => {
    const commercetools = readSource('packages/connectors-real/src/connectors/commercetools.ts');
    for (const field of ['unitKey', 'accountNumber', 'salesforceAccountId']) assert.ok(commercetools.includes(field), `commercetools ${field}`);
    const salesforce = readSource('packages/connectors-real/src/connectors/salesforce.ts');
    for (const field of ['accountId', 'Description']) assert.ok(salesforce.includes(field), `salesforce ${field}`);
    assert.ok(readSource('packages/connectors-real/src/connectors/zendesk.ts').includes('tags:${String(args.tag)}'), 'zendesk finds tickets by tag');
    const erp = JSON.parse(readSource('packages/connectors-sample/connectors/ace-erp/connector.json'));
    assert.ok(erp.tools.some((tool: any) => tool.name === 'account_balance'), 'the ERP tool that returns the whole row');
    const fields = new Set(Object.keys(erpSeed.collections.account_balances[0]));
    for (const entry of mapping.keys.filter((candidate) => candidate.system === 'ace-erp')) assert.ok(fields.has(entry.field), `the sample ERP row has ${entry.field}`);
  });

  await suite.test('the file holds no path, address, secret or personal data', () => {
    const text = readFileSync(MAPPING_FILE, 'utf8');
    assert.ok(!/https?:|:\/\/|\/Users\/|localhost|127\.0\.0\.1|\.env/i.test(text), 'no path or address');
    assert.ok(!/secret|token|password|api[_-]?key|bearer/i.test(text), 'no secret');
    assert.ok(!/@/.test(text), 'no email address');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
