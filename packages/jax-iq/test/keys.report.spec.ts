import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import {
  KEY_REPORT_CATEGORIES, KEY_REPORT_REASONS, buildKeyReport, canonicalRuleOf, contactKeyValue, extractNoteKey, keyKindRulesOf, parseKeyMapping,
} from '../src/keys';
import type { KeyKindRule, KeyReport, KeyReportItem, KeyReportOptions, KeyReportReason, KeySourceRecord } from '../src/keys';

/**
 * The key report: what a person reads before any key row is written. Every record and every account number lands in one of four
 * categories (unmatched, matched twice, matched only by name, ok) and the report holds ids only. The records below are made up for the
 * test, except the last test, which is built from the accounts in the sample ERP and the sample Salesforce.
 */
const suite = createSuite('jax-iq: the key report');

const WORKTREE = path.resolve(__dirname, '../../..');
const mapping = parseKeyMapping(JSON.parse(readFileSync(path.join(WORKTREE, 'docs/agent-instructions/jax-iq/account-keys.mapping.json'), 'utf8')));
const rules = keyKindRulesOf(mapping);
const canonical = canonicalRuleOf(mapping);
const ALL = ['ace-erp', 'commercetools', 'salesforce', 'zendesk'];
/** The same rules with one planned field read: what the mapping will say once the platform holds the field and the connector reads it. */
const readyFor = (system: string, kind: string): KeyKindRule[] => rules.map((rule) => (rule.system === system && rule.kind === kind ? { ...rule, ready: true } : rule));
/** The Salesforce field Account_Number__c once it exists: it holds the account number, the same key kind the ERP's account id holds. */
const withRealField = readyFor('salesforce', 'account_number');
/** The sample ERP's pointer to its Salesforce record once the link is filled. */
const withErpPointer = readyFor('ace-erp', 'sf_account_id');

const options = (expectedIn: string[] = ALL, kinds: KeyKindRule[] = rules): KeyReportOptions => ({ thing: 'Account', expectedIn, kinds, canonical });
const pad = (n: number) => String(n).padStart(4, '0');
const num = (n: number) => `ACC-${pad(n)}`;
const unit = (n: number) => `acc-${pad(n)}`;
/** TEST FIXTURE ONLY: a made-up 15-character Salesforce id. */
const sfId = (n: number) => `001TEST0000${pad(n)}`;

const erp = (n: number, name = `Account ${n}`): KeySourceRecord => ({ system: 'ace-erp', recordId: num(n), name, keys: [{ keyKind: 'account_number', value: num(n) }, { keyKind: 'ct_unit_key', value: unit(n) }] });
const ct = (n: number): KeySourceRecord => ({ system: 'commercetools', recordId: unit(n), keys: [{ keyKind: 'ct_unit_key', value: unit(n) }, { keyKind: 'ct_account_number', value: num(n) }] });
const sf = (n: number, note: string | null = num(n), name?: string): KeySourceRecord => ({
  system: 'salesforce', recordId: sfId(n), ...(name ? { name } : {}), keys: [{ keyKind: 'sf_account_id', value: sfId(n) }, { keyKind: 'sf_account_note', value: note }],
});
const zd = (n: number): KeySourceRecord => ({ system: 'zendesk', recordId: unit(n), keys: [{ keyKind: 'zd_tag', value: unit(n) }] });

const reasons = (report: KeyReport, reason: KeyReportReason): KeyReportItem[] => report.items.filter((item) => item.reason === reason);
const refs = (item: KeyReportItem) => item.records.map((record) => `${record.system}:${record.recordId}`);
const shape = (report: KeyReport) => report.items.map((item) => [item.reason, item.canonicalIds.join('+'), refs(item).join(','), (item.missingFrom ?? []).join(',')]);
const countsAddUp = (report: KeyReport) => {
  const tally: Record<string, number> = { unmatched: 0, matched_twice: 0, name_only: 0, ok: 0 };
  for (const item of report.items) tally[item.category]++;
  assert.deepEqual(report.counts, tally);
  for (const item of report.items) assert.equal(item.category, KEY_REPORT_REASONS[item.reason].category, item.reason);
};

/** A fixed shuffle: the same seed always gives the same order. */
function shuffled<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

async function main() {
  await suite.test('each reason belongs to the category of the specification, and the four categories are the ones the loaders print', () => {
    assert.deepEqual([...KEY_REPORT_CATEGORIES], ['unmatched', 'matched_twice', 'name_only', 'ok']);
    const expected: Record<string, string> = {
      source_record_without_id: 'unmatched', canonical_missing_in_system: 'unmatched', number_only_in_one_system: 'unmatched',
      duplicate_in_system: 'matched_twice', disagree: 'matched_twice', name_only: 'name_only', ok: 'ok',
    };
    assert.deepEqual(Object.fromEntries(Object.entries(KEY_REPORT_REASONS).map(([reason, entry]) => [reason, entry.category])), expected);
    assert.equal(KEY_REPORT_REASONS.ok.term, 'OK');
    assert.equal(KEY_REPORT_REASONS.disagree.term, 'Disagree');
    assert.equal(KEY_REPORT_REASONS.duplicate_in_system.term, 'Duplicate');
    for (const entry of Object.values(KEY_REPORT_REASONS)) assert.ok(entry.term.length > 0);
  });

  await suite.test('ok: an account number held by every system that should hold it, and nothing disputes it', () => {
    const report = buildKeyReport([erp(1), ct(1), sf(1), zd(1), erp(2), ct(2), sf(2), zd(2)], options());
    assert.equal(report.items.length, 2);
    assert.deepEqual(report.items.map((item) => [item.category, item.reason, item.canonicalIds]), [['ok', 'ok', ['ACC-0001']], ['ok', 'ok', ['ACC-0002']]]);
    assert.deepEqual(refs(report.items[0]), ['ace-erp:ACC-0001', 'commercetools:acc-0001', 'salesforce:001TEST00000001', 'zendesk:acc-0001']);
    assert.equal(report.items[0].missingFrom, undefined);
    assert.deepEqual(report.counts, { unmatched: 0, matched_twice: 0, name_only: 0, ok: 2 });
    assert.deepEqual(report.warnings, []);
    assert.equal(buildKeyReport([], options()).items.length, 0);
    countsAddUp(report);
  });

  await suite.test('unmatched: a number only one system holds, and a number a system that should hold it lacks (one row for each system lacking it)', () => {
    const only = buildKeyReport([erp(99)], options());
    assert.equal(only.items.length, 1);
    assert.equal(only.items[0].reason, 'number_only_in_one_system');
    assert.deepEqual(only.items[0].missingFrom, ['commercetools', 'salesforce', 'zendesk']);
    const oneLacking = buildKeyReport([erp(2), ct(2), sf(2)], options());
    assert.deepEqual(shape(oneLacking), [['canonical_missing_in_system', 'ACC-0002', 'ace-erp:ACC-0002,commercetools:acc-0002,salesforce:001TEST00000002', 'zendesk']]);
    const twoLacking = buildKeyReport([erp(2), sf(2)], options());
    assert.deepEqual(twoLacking.items.map((item) => item.missingFrom), [['commercetools'], ['zendesk']]);
    assert.ok(twoLacking.items.every((item) => item.reason === 'canonical_missing_in_system'));
    const fewer = buildKeyReport([erp(2), sf(2)], options(['ace-erp', 'salesforce']));
    assert.deepEqual(fewer.items.map((item) => item.reason), ['ok'], 'a system that is not expected is not missing');
    countsAddUp(only);
    countsAddUp(twoLacking);
  });

  await suite.test('matched twice (Duplicate): two records of one system claim one number; the number is then not ok in any system', () => {
    const report = buildKeyReport([erp(3), ct(3), sf(3), sf(33, num(3)), zd(3)], options());
    assert.deepEqual(shape(report), [['duplicate_in_system', 'ACC-0003', 'salesforce:001TEST00000003,salesforce:001TEST00000033', '']]);
    assert.equal(report.items[0].category, 'matched_twice');
    assert.equal(reasons(report, 'ok').length, 0);
    const sameSystem = buildKeyReport([erp(4), { ...erp(5), keys: [{ keyKind: 'account_number', value: num(4) }] }], options(['ace-erp']));
    assert.deepEqual(shape(sameSystem), [['duplicate_in_system', 'ACC-0004', 'ace-erp:ACC-0004,ace-erp:ACC-0005', '']]);
    const otherSystems = buildKeyReport([erp(6), sf(6), sf(7, num(6))], options(['ace-erp', 'salesforce']));
    assert.equal(reasons(otherSystems, 'duplicate_in_system').length, 1);
    const spread = buildKeyReport([erp(8), ct(8), sf(8), zd(8)], options());
    assert.equal(reasons(spread, 'duplicate_in_system').length, 0, 'one record in each of four systems is not a duplicate');
    countsAddUp(report);
  });

  await suite.test('matched twice (Disagree): one record claims two numbers, a division claims another number than its parent, or a record points at a record that claims another', () => {
    const own = buildKeyReport([erp(4), ct(4), { ...sf(4, num(4)), keys: [{ keyKind: 'sf_account_id', value: sfId(4) }, { keyKind: 'sf_account_note', value: num(4) }, { keyKind: 'account_number', value: num(5) }] }, zd(4)], options(ALL, withRealField));
    const two = reasons(own, 'disagree');
    assert.equal(two.length, 1);
    assert.deepEqual(two[0].canonicalIds, ['ACC-0004', 'ACC-0005']);
    assert.deepEqual(refs(two[0]), ['salesforce:001TEST00000004']);
    assert.equal(reasons(own, 'ok').length, 0, 'neither number is ok while the record disagrees with itself');

    const division: KeySourceRecord = { system: 'commercetools', recordId: 'acc-0006-div1', parentSystemKey: unit(6), keys: [{ keyKind: 'ct_unit_key', value: 'acc-0006-div1' }, { keyKind: 'ct_account_number', value: num(7) }] };
    const wrongDivision = buildKeyReport([erp(6), ct(6), division], options(['ace-erp', 'commercetools']));
    assert.deepEqual(shape(wrongDivision), [['disagree', 'ACC-0006+ACC-0007', 'commercetools:acc-0006,commercetools:acc-0006-div1', '']]);

    const pointing: KeySourceRecord = { ...erp(8), keys: [{ keyKind: 'account_number', value: num(8) }, { keyKind: 'sf_account_id', value: sfId(88) }] };
    const reference = buildKeyReport([pointing, sf(88, num(9))], options(['ace-erp', 'salesforce'], withErpPointer));
    assert.deepEqual(shape(reference), [['disagree', 'ACC-0008+ACC-0009', 'ace-erp:ACC-0008,salesforce:001TEST00000088', '']]);
    const agreeing = buildKeyReport([pointing, sf(88, num(8))], options(['ace-erp', 'salesforce'], withErpPointer));
    assert.deepEqual(shape(agreeing), [['ok', 'ACC-0008', 'ace-erp:ACC-0008,salesforce:001TEST00000088', '']], 'the same pointer to a record that agrees is fine');
    const unit8: KeySourceRecord = { ...erp(8), keys: [{ keyKind: 'account_number', value: num(8) }, { keyKind: 'ct_unit_key', value: unit(8) }] };
    const crossed = buildKeyReport([unit8, { ...ct(8), keys: [{ keyKind: 'ct_unit_key', value: unit(8) }, { keyKind: 'ct_account_number', value: num(10) }] }], options(['ace-erp', 'commercetools']));
    assert.equal(reasons(crossed, 'disagree').length, 1, 'a unit key that points to another number');
    const dangling = buildKeyReport([pointing], options(['ace-erp'], withErpPointer));
    assert.deepEqual(shape(dangling), [['ok', 'ACC-0008', 'ace-erp:ACC-0008', '']], 'a pointer to a record nobody sent is not a disagreement');
    for (const report of [own, wrongDivision, reference, agreeing, crossed, dangling]) countsAddUp(report);
  });

  await suite.test('matched only by name: a record with no number whose normalised name equals that of a numbered record in another system; never used to answer', () => {
    const report = buildKeyReport([erp(1, 'Talbot & Nguyen Concrete Ltd'), ct(1), sf(1, null, 'Talbot and Nguyen Concrete Ltd.')], options(['ace-erp', 'commercetools', 'salesforce']));
    assert.deepEqual(shape(report), [
      ['canonical_missing_in_system', 'ACC-0001', 'ace-erp:ACC-0001,commercetools:acc-0001', 'salesforce'],
      ['name_only', 'ACC-0001', 'salesforce:001TEST00000001', ''],
    ]);
    assert.equal(reasons(report, 'name_only')[0].category, 'name_only');
    assert.equal(reasons(report, 'ok').length, 0, 'a name does not make the number ok');
    const differs = buildKeyReport([erp(1, 'Talbot & Nguyen Concrete Ltd'), sf(1, null, 'Talbot & Nguyen Concrete')], options(['ace-erp', 'salesforce']));
    assert.equal(reasons(differs, 'name_only').length, 0, 'one word less is a different name: no score, no threshold');
    assert.equal(reasons(differs, 'source_record_without_id').length, 1);
    const reordered = buildKeyReport([erp(4, 'Whittle & Ngata Plumbing Ltd'), sf(4, null, 'Ngata & Whittle Plumbing Ltd')], options(['ace-erp', 'salesforce']));
    assert.equal(reasons(reordered, 'name_only').length, 0, 'word order is part of the name');
    const sameSystem = buildKeyReport([erp(1, 'Talbot & Nguyen'), { ...erp(2, 'Talbot & Nguyen'), keys: [] }], options(['ace-erp']));
    assert.equal(reasons(sameSystem, 'name_only').length, 0, 'a name match counts only across systems');
    const noName = buildKeyReport([erp(1), sf(1, null)], options(['ace-erp', 'salesforce']));
    assert.equal(reasons(noName, 'name_only').length, 0);
    countsAddUp(report);
  });

  await suite.test('unmatched (No id): a missing note is absent, never zero; a value of the wrong shape is listed too, and the warning never holds the value', () => {
    const secret = 'SECRET-VALUE-XYZ';
    for (const absent of [undefined, null, '', '   ']) {
      const report = buildKeyReport([{ ...sf(1), keys: [{ keyKind: 'sf_account_id', value: sfId(1) }, { keyKind: 'sf_account_note', value: absent }] }], options(['salesforce']));
      assert.deepEqual(shape(report), [['source_record_without_id', '', 'salesforce:001TEST00000001', '']], String(absent));
      assert.deepEqual(report.warnings, [], 'an absent note is not a problem with the input');
    }
    const zero = buildKeyReport([{ ...sf(1), keys: [{ keyKind: 'sf_account_id', value: sfId(1) }, { keyKind: 'sf_account_note', value: 0 as any }] }], options(['salesforce']));
    assert.equal(reasons(zero, 'source_record_without_id').length, 1, 'a zero is not a number');
    const wrong = buildKeyReport([sf(1, secret)], options(['salesforce']));
    assert.equal(reasons(wrong, 'source_record_without_id').length, 1);
    assert.equal(wrong.warnings.length, 1);
    assert.ok(!JSON.stringify(wrong).includes(secret), 'the value is in neither the items nor the warnings');
    const long = buildKeyReport([sf(1, 'A'.repeat(5000))], options(['salesforce']));
    assert.ok(long.warnings[0].includes('too long'));
    assert.ok(!JSON.stringify(long).includes('AAAAAAAAAA'));
    const cased = buildKeyReport([sf(1, 'acc-0001')], options(['salesforce']));
    assert.deepEqual(shape(cased), [['ok', 'ACC-0001', 'salesforce:001TEST00000001', '']], 'a number is read in its kind\'s case');
    countsAddUp(wrong);
  });

  await suite.test('an edited description note breaks the note key but not a real field', () => {
    const noteRule = mapping.keys.find((entry) => entry.kind === 'sf_account_note')!;
    const noteKey = (description: string | undefined): string | undefined => {
      const read = extractNoteKey(description, noteRule.extract!, noteRule);
      return read.ok ? read.value : undefined;
    };
    const salesforce = (n: number, description: string | undefined, field?: string): KeySourceRecord => ({
      system: 'salesforce', recordId: sfId(n),
      keys: [{ keyKind: 'sf_account_id', value: sfId(n) }, { keyKind: 'sf_account_note', value: noteKey(description) }, ...(field ? [{ keyKind: 'account_number', value: field }] : [])],
    });
    const only = ['ace-erp', 'salesforce'];
    const records = [
      erp(1), salesforce(1, `Account number ${num(1)}. commercetools unit ${unit(1)}.`, num(1)),
      erp(2), salesforce(2, 'Account no. ACC-0002 (edited)', num(2)),
      erp(3), salesforce(3, 'Account no. ACC-0003 (edited)'),
      erp(4), salesforce(4, `Account number ${num(4)}.`, num(5)),
    ];
    const report = buildKeyReport(records, options(only, withRealField));
    assert.deepEqual(reasons(report, 'ok').map((item) => item.canonicalIds), [['ACC-0001'], ['ACC-0002']], 'the edited note does not matter while the real field holds the number');
    assert.deepEqual(shape({ ...report, items: reasons(report, 'source_record_without_id') }), [['source_record_without_id', '', 'salesforce:001TEST00000003', '']], 'edited and no real field: no number');
    assert.deepEqual(reasons(report, 'number_only_in_one_system').map((item) => [item.canonicalIds, item.missingFrom]), [[['ACC-0003'], ['salesforce']]], 'the ERP is then the only system that holds the number');
    assert.deepEqual(reasons(report, 'disagree').map((item) => item.canonicalIds), [['ACC-0004', 'ACC-0005']], 'the note and the real field of one record disagree');
    const without = buildKeyReport(records, options(only));
    assert.deepEqual(without.warnings, ['salesforce: the key kind account_number is not read yet (ready is false) and was ignored.'], 'the real field is ignored until it is ready, and the report says so');
    countsAddUp(report);
  });

  await suite.test('the six terms of the Salesforce plan can be read from the items: OK, Number only in Salesforce, Disagree, Duplicate, No note, Missing in Salesforce', () => {
    const three = ['ace-erp', 'commercetools', 'salesforce'];
    const report = buildKeyReport([
      erp(1), ct(1), sf(1),                                                       // OK
      sf(2),                                                                      // the number is only in Salesforce
      erp(3), ct(3),                                                              // two systems have it, Salesforce does not
      erp(4),                                                                     // only the ERP has it
      erp(5), ct(5), sf(5), sf(55, num(5)),                                       // two Salesforce records claim it
      sf(6, null),                                                                // a Salesforce record with no note
      { ...erp(8), keys: [{ keyKind: 'account_number', value: num(8) }, { keyKind: 'sf_account_id', value: sfId(88) }] }, ct(8), sf(88, num(9)),  // the ERP points at a record with another number
    ], options(three, withErpPointer));
    const onlySalesforce = (item: KeyReportItem) => item.records.every((record) => record.system === 'salesforce');
    const term = (item: KeyReportItem): string => {
      if (item.reason === 'ok') return 'OK';
      if (item.reason === 'disagree') return 'Disagree';
      if (item.reason === 'duplicate_in_system') return 'Duplicate';
      if (item.reason === 'source_record_without_id') return 'No note';
      if (item.reason === 'number_only_in_one_system' && onlySalesforce(item)) return 'Number only in Salesforce';
      if (item.missingFrom?.includes('salesforce')) return 'Missing in Salesforce';
      return 'other';
    };
    const read = report.items.map((item) => `${item.canonicalIds.join('+') || '-'}: ${term(item)}`).sort();
    assert.deepEqual(read, [
      '-: No note',
      'ACC-0001: OK',
      'ACC-0002: Number only in Salesforce',
      'ACC-0003: Missing in Salesforce',
      'ACC-0004: Missing in Salesforce',
      'ACC-0005: Duplicate',
      'ACC-0008+ACC-0009: Disagree',
    ]);
    countsAddUp(report);
  });

  await suite.test('a division rolls up under its parent: it is not a second record of the number, and a division with no usable parent has no number', () => {
    const division = (n: number, suffix: string, parent = unit(n), number?: string): KeySourceRecord => ({
      system: 'commercetools', recordId: `${unit(n)}-${suffix}`, parentSystemKey: parent,
      keys: [{ keyKind: 'ct_unit_key', value: `${unit(n)}-${suffix}` }, ...(number ? [{ keyKind: 'ct_account_number', value: number }] : [])],
    });
    const two = ['ace-erp', 'commercetools'];
    const rolled = buildKeyReport([erp(4), ct(4), division(4, 'div1'), division(4, 'div2')], options(two));
    assert.deepEqual(shape(rolled), [['ok', 'ACC-0004', 'ace-erp:ACC-0004,commercetools:acc-0004,commercetools:acc-0004-div1,commercetools:acc-0004-div2', '']]);
    assert.equal(rolled.items[0].records.filter((record) => record.role === 'division').length, 2);
    assert.equal(rolled.items[0].records.find((record) => record.recordId === 'acc-0004-div1')!.parentSystemKey, 'acc-0004');
    const same = buildKeyReport([erp(4), ct(4), division(4, 'div1', unit(4), num(4))], options(two));
    assert.deepEqual(reasons(same, 'ok').length, 1, 'a division that repeats its parent\'s number agrees with it');
    const orphan = buildKeyReport([erp(4), ct(4), division(4, 'div1', 'acc-9999')], options(two));
    assert.deepEqual(shape({ ...orphan, items: reasons(orphan, 'source_record_without_id') }), [['source_record_without_id', '', 'commercetools:acc-0004-div1', '']]);
    const chain = buildKeyReport([erp(4), ct(4), division(4, 'div1'), division(4, 'div1-a', 'acc-0004-div1')], options(two));
    assert.equal(chain.items.length, 1, 'a division of a division rolls up all the way');
    assert.equal(chain.items[0].records.length, 4);
    const loop = buildKeyReport([division(5, 'a', 'acc-0005-b'), division(5, 'b', 'acc-0005-a')], options(two));
    assert.deepEqual(reasons(loop, 'source_record_without_id').length, 2, 'two units that name each other as parent end, with no number');
    const duplicate = buildKeyReport([erp(4), ct(4), { ...ct(4), recordId: 'acc-0004-other', keys: [{ keyKind: 'ct_account_number', value: num(4) }] }], options(two));
    assert.equal(reasons(duplicate, 'duplicate_in_system').length, 1, 'a second unit that claims the number itself is a duplicate, not a division');
    for (const report of [rolled, same, orphan, chain, loop, duplicate]) countsAddUp(report);
  });

  await suite.test('a field that is not ready, a key kind the mapping does not know and a value of the wrong shape are ignored with a warning that holds no value', () => {
    const secret = 'SECRET-VALUE-XYZ';
    const odd: KeySourceRecord = { ...erp(1), keys: [{ keyKind: 'account_number', value: num(1) }, { keyKind: 'mystery_kind', value: secret }, { keyKind: 'ct_unit_key', value: secret }] };
    const planned: KeySourceRecord = { ...sf(1), keys: [{ keyKind: 'sf_account_id', value: sfId(1) }, { keyKind: 'account_number', value: secret }] };
    const report = buildKeyReport([odd, planned], options(['ace-erp', 'salesforce']));
    assert.deepEqual(report.warnings, [
      'ace-erp ACC-0001: ct_unit_key is not a usable value (wrong shape).',
      'ace-erp: the key kind mystery_kind is not in the mapping and was ignored.',
      'salesforce: the key kind account_number is not read yet (ready is false) and was ignored.',
    ]);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.deepEqual(shape(report), [
      ['number_only_in_one_system', 'ACC-0001', 'ace-erp:ACC-0001', 'salesforce'],
      ['source_record_without_id', '', 'salesforce:001TEST00000001', ''],
    ], 'ignored fields give no number');
    const listedTwice = buildKeyReport([erp(1), erp(1), sf(1)], options(['ace-erp', 'salesforce']));
    assert.deepEqual(listedTwice.warnings, ['ace-erp ACC-0001 is listed more than once; the first is used.']);
    assert.deepEqual(reasons(listedTwice, 'ok').length, 1);
  });

  await suite.test('the account number is one key kind in the ERP, Salesforce and Zendesk: the planned fields of the last two are ignored until ready, then claim the number like the ERP\'s', () => {
    const three = ['ace-erp', 'salesforce', 'zendesk'];
    const salesforceField = (n: number, number: string): KeySourceRecord => ({ ...sf(n), keys: [{ keyKind: 'sf_account_id', value: sfId(n) }, { keyKind: 'account_number', value: number }] });
    const zendeskOrganisation = (n: number, number: string, recordId = `org-${n}`): KeySourceRecord => ({ system: 'zendesk', recordId, keys: [{ keyKind: 'account_number', value: number }] });
    const records = [erp(1), salesforceField(1, num(1)), zendeskOrganisation(1, num(1))];

    const planned = buildKeyReport(records, options(three));
    assert.deepEqual(planned.warnings, [
      'salesforce: the key kind account_number is not read yet (ready is false) and was ignored.',
      'zendesk: the key kind account_number is not read yet (ready is false) and was ignored.',
    ]);
    assert.equal(reasons(planned, 'ok').length, 0, 'planned fields give no number');
    assert.deepEqual(reasons(planned, 'source_record_without_id').map(refs).sort(), [['salesforce:001TEST00000001'], ['zendesk:org-1']]);

    const bothReady = rules.map((rule) => (rule.kind === 'account_number' ? { ...rule, ready: true } : rule));
    const ready = buildKeyReport(records, options(three, bothReady));
    assert.deepEqual(shape(ready), [['ok', 'ACC-0001', 'ace-erp:ACC-0001,salesforce:001TEST00000001,zendesk:org-1', '']]);
    assert.deepEqual(ready.warnings, []);
    const lower = buildKeyReport([erp(1), zendeskOrganisation(1, 'acc-0001')], options(['ace-erp', 'zendesk'], bothReady));
    assert.deepEqual(shape(lower), [['ok', 'ACC-0001', 'ace-erp:ACC-0001,zendesk:org-1', '']], 'the external id is read in the key kind\'s case, like the ERP\'s');
    const twice = buildKeyReport([erp(1), zendeskOrganisation(1, num(1)), zendeskOrganisation(1, num(1), 'org-2')], options(['ace-erp', 'zendesk'], bothReady));
    assert.deepEqual(shape(twice), [['duplicate_in_system', 'ACC-0001', 'zendesk:org-1,zendesk:org-2', '']], 'two organisations with one external id are a duplicate');
    const wrong = buildKeyReport([erp(1), zendeskOrganisation(1, 'ACC-1')], options(['ace-erp', 'zendesk'], bothReady));
    assert.deepEqual(wrong.warnings, ['zendesk org-1: account_number is not a usable value (wrong shape).']);
    for (const report of [planned, ready, lower, twice, wrong]) countsAddUp(report);
  });

  await suite.test('the sample ERP\'s Salesforce and Zendesk links are planned until filled: ignored with one warning each, while its unit key is read; read, a wrong Salesforce pointer is a disagreement', () => {
    const pointing: KeySourceRecord = { ...erp(8), keys: [{ keyKind: 'account_number', value: num(8) }, { keyKind: 'ct_unit_key', value: unit(8) }, { keyKind: 'sf_account_id', value: sfId(88) }, { keyKind: 'zd_org_id', value: '4001' }] };
    const alone = buildKeyReport([pointing], options(['ace-erp']));
    assert.deepEqual(alone.warnings, [
      'ace-erp: the key kind sf_account_id is not read yet (ready is false) and was ignored.',
      'ace-erp: the key kind zd_org_id is not read yet (ready is false) and was ignored.',
    ], 'the unit key is read and gives no warning');
    assert.deepEqual(shape(alone), [['ok', 'ACC-0008', 'ace-erp:ACC-0008', '']]);

    const records = [pointing, sf(88, num(9))];
    const ignored = buildKeyReport(records, options(['ace-erp', 'salesforce']));
    assert.equal(reasons(ignored, 'disagree').length, 0, 'the pointer is not read yet, so it cannot be a disagreement');
    const filled = buildKeyReport(records, options(['ace-erp', 'salesforce'], withErpPointer));
    assert.deepEqual(shape(filled), [['disagree', 'ACC-0008+ACC-0009', 'ace-erp:ACC-0008,salesforce:001TEST00000088', '']]);
    assert.deepEqual(filled.warnings, ['ace-erp: the key kind zd_org_id is not read yet (ready is false) and was ignored.'], 'only the link that was filled is read');
    for (const report of [alone, ignored, filled]) countsAddUp(report);
  });

  await suite.test('the report does not depend on the order of the records', () => {
    const records: KeySourceRecord[] = [
      erp(1, 'One Ltd'), ct(1), sf(1), zd(1),
      erp(2), ct(2), sf(2),
      erp(3), sf(3), sf(33, num(3)),
      { ...erp(4), keys: [{ keyKind: 'account_number', value: num(4) }, { keyKind: 'sf_account_id', value: sfId(44) }] }, sf(44, num(5)),
      erp(6, 'Six and Co'), sf(6, null, 'Six & Co.'),
      sf(7, null, 'Nobody'), erp(8), { system: 'commercetools', recordId: 'acc-0008-div1', parentSystemKey: unit(8), keys: [{ keyKind: 'ct_unit_key', value: 'acc-0008-div1' }] }, ct(8),
      erp(99),
    ];
    const first = buildKeyReport(records, options(ALL, withErpPointer));
    assert.ok(first.items.length >= 8);
    const kinds = new Set(first.items.map((item) => item.reason));
    for (const reason of ['ok', 'canonical_missing_in_system', 'number_only_in_one_system', 'duplicate_in_system', 'disagree', 'name_only', 'source_record_without_id']) assert.ok(kinds.has(reason as KeyReportReason), reason);
    for (let seed = 1; seed <= 40; seed++) assert.deepEqual(buildKeyReport(shuffled(records, seed), options(ALL, withErpPointer)), first, `seed ${seed}`);
    assert.deepEqual(buildKeyReport(records, options(shuffled(ALL, 3), withErpPointer)).items.map((item) => item.reason).sort(), first.items.map((item) => item.reason).sort(), 'the order of the expected systems changes no reason');
    countsAddUp(first);
  });

  await suite.test('the report holds record ids and account numbers only: no name, no email address, no free text', () => {
    const names = ['Quentin Zephyr Holdings', 'Mirabel Quux Partners'];
    const email = 'someone.private@example.test';
    const records: KeySourceRecord[] = [
      erp(1, names[0]), { ...sf(1, null, 'Quentin Zephyr Holdings Ltd'), name: names[1] }, { ...sf(2, 'free text, not a number'), name: email },
    ];
    const text = JSON.stringify(buildKeyReport(records, options(['ace-erp', 'salesforce'])));
    for (const secret of [...names, email, 'someone', 'free text', 'Zephyr', 'Mirabel']) assert.ok(!text.includes(secret), secret);
  });

  await suite.test('a contact is keyed by its account and a salted hash of the email, so the report holds no address; a contact with no email is listed, not keyed', () => {
    const SALT = 'TEST FIXTURE ONLY salt';
    const pattern = '^ACC-\\d{4}:[0-9a-f]{64}$';
    const contactRules: KeyKindRule[] = ['salesforce', 'commercetools'].map((system) => ({ kind: 'contact_key', system, use: 'number', caseRule: 'as_is', pattern, ready: true }));
    const contact = (system: string, recordId: string, account: string, email: string | undefined): KeySourceRecord => ({
      system, recordId, keys: [{ keyKind: 'contact_key', value: contactKeyValue(account, email, SALT) }],
    });
    const report = buildKeyReport([
      contact('salesforce', 'sf-contact-1', 'ACC-0001', 'Grace.Hartley@Example.test'),
      contact('commercetools', 'ct-person-1', 'ACC-0001', '  grace.hartley@example.TEST '),
      contact('salesforce', 'sf-contact-2', 'ACC-0001', undefined),
      contact('salesforce', 'sf-contact-3', 'ACC-0002', 'grace.hartley@example.test'),
      contact('commercetools', 'ct-person-3', 'ACC-0001', ''),
    ], { thing: 'Contact', expectedIn: ['salesforce', 'commercetools'], kinds: contactRules, canonical: { caseRule: 'as_is', pattern } });
    assert.deepEqual(reasons(report, 'ok').map(refs), [['commercetools:ct-person-1', 'salesforce:sf-contact-1']], 'the same person at the same account in two systems');
    assert.deepEqual(reasons(report, 'number_only_in_one_system').map(refs), [['salesforce:sf-contact-3']], 'the same address at another account is another contact');
    assert.deepEqual(reasons(report, 'source_record_without_id').map(refs).sort(), [['commercetools:ct-person-3'], ['salesforce:sf-contact-2']], 'no email: listed, not keyed');
    assert.ok(reasons(report, 'ok')[0].canonicalIds[0].startsWith('ACC-0001:'));
    assert.ok(reasons(report, 'number_only_in_one_system')[0].canonicalIds[0].startsWith('ACC-0002:'));
    assert.notEqual(reasons(report, 'ok')[0].canonicalIds[0], reasons(report, 'number_only_in_one_system')[0].canonicalIds[0]);
    const text = JSON.stringify(report);
    assert.ok(!/@|hartley|example/i.test(text), 'no part of the address is in the report');
    assert.equal(report.warnings.length, 0);
  });

  await suite.test('built from the accounts of the sample ERP and the sample Salesforce: all ok, until a description is edited', () => {
    const erpAccounts: any[] = JSON.parse(readFileSync(path.join(WORKTREE, 'packages/connectors-sample/connectors/ace-erp/seed.json'), 'utf8')).collections.account_balances;
    const salesforceAccounts: any[] = JSON.parse(readFileSync(path.join(WORKTREE, 'packages/connectors-sample/connectors/salesforce/seed.json'), 'utf8')).collections.accounts;
    assert.deepEqual(salesforceAccounts.map((account) => account.accountId).sort(), erpAccounts.map((account) => account.accountId).sort(), 'both sample systems know the same accounts');
    const noteRule = mapping.keys.find((entry) => entry.kind === 'sf_account_note')!;
    const two = ['ace-erp', 'salesforce'];
    const erpRecords: KeySourceRecord[] = erpAccounts.map((account) => ({
      system: 'ace-erp', recordId: account.accountId, name: account.name,
      keys: [{ keyKind: 'account_number', value: account.accountId }, { keyKind: 'ct_unit_key', value: account.commercetoolsUnitKey }, { keyKind: 'sf_account_id', value: account.salesforceAccountId }],
    }));
    const salesforceRecords = (edit?: string): KeySourceRecord[] => salesforceAccounts.map((account, index) => {
      const description = `Trade type: ${account.tradeType}. Account number ${account.accountId}. commercetools unit ${String(account.accountId).toLowerCase()}. Sample data.`;
      const read = extractNoteKey(account.accountId === edit ? description.replace('Account number', 'Account no.') : description, noteRule.extract!, noteRule);
      const id = sfId(index + 1);
      return { system: 'salesforce', recordId: id, name: account.name, keys: [{ keyKind: 'sf_account_id', value: id }, { keyKind: 'sf_account_note', value: read.ok ? read.value : undefined }] };
    });
    const clean = buildKeyReport([...erpRecords, ...salesforceRecords()], options(two));
    assert.equal(clean.counts.ok, erpAccounts.length);
    assert.deepEqual(clean.counts, { unmatched: 0, matched_twice: 0, name_only: 0, ok: erpAccounts.length });
    assert.deepEqual(clean.warnings, ['ace-erp: the key kind sf_account_id is not read yet (ready is false) and was ignored.'], 'the ERP\'s Salesforce link is planned: ignored, and said so once');
    const linked = buildKeyReport([...erpRecords, ...salesforceRecords()], options(two, withErpPointer));
    assert.deepEqual(linked.counts, clean.counts, 'the ERP link is empty in the sample: read, it adds nothing');
    assert.deepEqual(linked.warnings, [], 'an empty link is absent, not a problem with the input');
    const edited = buildKeyReport([...erpRecords, ...salesforceRecords('ACC-0012')], options(two));
    assert.equal(edited.counts.ok, erpAccounts.length - 1);
    assert.deepEqual(shape({ ...edited, items: edited.items.filter((item) => item.reason !== 'ok') }).map((row) => [row[0], row[1], row[3]]), [
      ['number_only_in_one_system', 'ACC-0012', 'salesforce'],
      ['name_only', 'ACC-0012', ''],
    ], 'the account whose note was edited is matched by its name only, and the ERP number is then held by the ERP alone');
    countsAddUp(clean);
    countsAddUp(edited);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
