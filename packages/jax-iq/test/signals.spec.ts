import './setup/no-world';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { SignalRuleSchema } from '../src/model';
import type { Formula, JaxOntologyRelease, SettingDef, SignalRule } from '../src/model';
import * as signals from '../src/signals';
import { evaluateSignal, evaluateSignals, signalEvidenceText, signalInputFacts } from '../src/signals';
import type { SignalContext, SignalInputFact, SignalListItem, SignalResult, SignalSource } from '../src/signals';
import { compareExact, divideExact, exact, formatExact, fromJsNumber, parseExact, readAmount, signOf } from '../src/signals/decimal';
import { parseTime, renderFormula } from '../src/signals/formula';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';

/**
 * The signal evaluator. A signal is worked out in plain, fixed terms, with exact arithmetic, from facts that were already read; it says
 * what it could not work out instead of guessing or using zero; and it brings its evidence.
 *
 * TEST FIXTURE ONLY. Every threshold, freshness limit and time below is made up for these tests: the setting keys carry the
 * `testfixture.` prefix, the owner role is 'testfixture-owner' and the currency is the one ISO reserves for testing. None of it is a
 * business value, and no shipped dictionary value is touched. No model, no network, no clock but the injected one.
 */
const suite = createSuite('jax-iq: the signal evaluator and its evidence');

const SRC = path.resolve(__dirname, '../src/signals');
const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));
const NOW = '2026-09-04T10:00:00Z';

/** TEST FIXTURE ONLY: the values the fixture settings take unless a test overrides one. */
const FIXTURE_VALUES: Record<string, number | null> = {
  'testfixture.useWatch': 0.9,
  'testfixture.waitDays': 3,
  'testfixture.waitHours': 72,
  'testfixture.waitMinutes': 4320,
  'testfixture.pileUp': 3,
  'testfixture.three': 3,
  'testfixture.twoPointNine': 2.9,
  'testfixture.oneTenth': 0.1,
  'testfixture.freshness': null,
};
const unitOf = (key: string): SettingDef['unit'] =>
  key.endsWith('freshness') ? 'seconds' : key.includes('waitDays') ? 'days' : key.includes('wait') || key.includes('pileUp') ? 'count' : 'ratio';
const fixtureSettings = (over: Record<string, number | null> = {}): SettingDef[] =>
  Object.entries({ ...FIXTURE_VALUES, ...over }).map(([key, value]) => ({ key, label: `Fixture ${key}`, kind: 'threshold', unit: unitOf(key), ownerRole: 'testfixture-owner', value }));

const release = { version: 'testfixture-release-1', checksum: 'testfixture-checksum' };
const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const stamp = (over: Partial<SignalSource> = {}): SignalSource => ({
  system: 'testfixture-erp', displayName: 'Fixture ERP', sample: true, tool: 'fixture_tool', authority: 'source_of_truth',
  sourceUpdatedAt: '2026-09-04T09:30:00Z', retrievedAt: '2026-09-04T09:59:00Z', fromCache: false, ...over,
});
const ok = (value: unknown, source: SignalSource = stamp()): SignalInputFact => ({ status: 'ok', value, source });
const absent = (reason = 'not_recorded', system?: string): SignalInputFact => ({ status: 'not_available', unavailable: { reason, ...(system ? { system } : {}) } });
const money = (amount: string) => ({ amount, currency: 'XTS' });
const everything = () => true;

function context(over: Partial<SignalContext> = {}): SignalContext {
  return { release, settings: fixtureSettings(), clock: clockAt(NOW), visible: everything, facts: {}, lists: {}, ...over };
}

/** A valid signal around a formula. The schema reads it, so a fixture that is not a legal rule fails here. */
function rule(patch: Partial<SignalRule> & Pick<SignalRule, 'formula'>): SignalRule {
  return SignalRuleSchema.parse({
    signalId: 'testfixture-signal', name: 'Fixture signal', meaning: 'A signal made up for the tests.', appliesTo: 'Account', severity: 'watch',
    inputs: [], settings: [], status: 'active', activatedBy: 'Test Approver', activatedAt: '2026-10-29T09:30:00Z', wording: ['A fixture sentence.'], ...patch,
  });
}

const creditUse = (cmp: 'gt' | 'gte' | 'lt' = 'gte') => rule({
  signalId: 'testfixture-credit-use', name: 'Fixture credit use',
  inputs: [
    { name: 'balance', fact: 'Account.balance', maxAge: 'testfixture.freshness', requireAuthority: 'source_of_truth' },
    { name: 'limit', fact: 'Account.creditLimit', maxAge: 'testfixture.freshness', requireAuthority: 'source_of_truth' },
  ],
  formula: { op: 'compare', cmp, left: { formula: { op: 'ratio', num: { input: 'balance' }, den: { input: 'limit' } } }, right: { setting: 'testfixture.useWatch' } },
  settings: ['testfixture.useWatch'],
});
const creditFacts = (balance: string, limit: string): Record<string, SignalInputFact> => ({
  'Account.balance': ok(money(balance)),
  'Account.creditLimit': ok(money(limit), stamp({ sourceUpdatedAt: null })),
});

/** One input, one test, no setting: the smallest rule. */
const single = (formula: Formula, fact = 'Account.x', extra: Partial<SignalRule['inputs'][number]> = {}) => rule({ inputs: [{ name: 'x', fact, ...extra }], formula });
const statusOf = (signal: SignalRule, ctx: SignalContext): string => evaluateSignal(signal, ctx)?.status ?? 'absent';
const worked = (signal: SignalRule, ctx: SignalContext): SignalResult => {
  const result = evaluateSignal(signal, ctx);
  assert.ok(result, 'the signal is present for this person');
  return result;
};

const ticket = (id: string, priority: string, status: string, created: string): SignalListItem => ({
  key: { value: id },
  facts: { 'Ticket.priority': ok(priority), 'Ticket.status': ok(status), 'Ticket.created': ok(created) },
});
const OPEN = { op: 'compare', cmp: 'eq', left: { input: 'Ticket.status' }, right: { text: 'open' } } as const;
const HIGH = { op: 'compare', cmp: 'eq', left: { input: 'Ticket.priority' }, right: { text: 'high' } } as const;
const OLD = { op: 'compare', cmp: 'gt', left: { formula: { op: 'age', of: { input: 'Ticket.created' }, unit: 'days' } }, right: { setting: 'testfixture.waitDays' } } as const;
const WORDS = {
  high: "Ticket.priority is 'high'",
  open: "Ticket.status is 'open'",
  old: 'the age of Ticket.created in days is above testfixture.waitDays',
};
const oldUrgent = rule({
  signalId: 'testfixture-old-urgent', name: 'Fixture old urgent ticket',
  formula: { op: 'any', of: { over: 'Account.tickets', where: { op: 'and', of: [HIGH, OPEN, OLD] } } },
  settings: ['testfixture.waitDays'],
});
const T1 = ticket('T1', 'high', 'open', '2026-08-25T10:00:00Z');
const T2 = ticket('T2', 'high', 'open', '2026-09-03T10:00:00Z');
const T3 = ticket('T3', 'low', 'open', '2026-08-01T10:00:00Z');
const T4 = ticket('T4', 'high', 'solved', '2026-08-20T10:00:00Z');
const tickets = (items: SignalListItem[], complete = true) => ({ 'Account.tickets': { items, complete } });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

async function main() {
  await suite.test('exact numbers: decimal text is read exactly, 0.1 is one tenth, and what is not a number is refused', () => {
    assert.deepEqual(parseExact('0.1'), exact(1n, 10n));
    assert.deepEqual(parseExact('-12.50'), exact(-25n, 2n));
    assert.deepEqual(parseExact('.5'), exact(1n, 2n));
    assert.deepEqual(parseExact('1e3'), exact(1000n));
    assert.deepEqual(parseExact('1.5e-3'), exact(3n, 2000n));
    assert.deepEqual(parseExact('+7'), exact(7n));
    assert.deepEqual(parseExact('0.00'), exact(0n));
    for (const text of ['', ' 1', '1 ', '1.', '1.2.3', '1e', 'e5', '-', 'NaN', 'Infinity', '1,000', '$5', '0x10', '1e9999', '9'.repeat(201)]) {
      assert.equal(parseExact(text), null, JSON.stringify(text));
    }
    assert.deepEqual(fromJsNumber(0.1), exact(1n, 10n));
    assert.deepEqual(fromJsNumber(2.9), exact(29n, 10n));
    assert.deepEqual(fromJsNumber(1e21), exact(10n ** 21n));
    assert.deepEqual(fromJsNumber(-0), exact(0n));
    assert.notEqual(fromJsNumber(5e-324), null, 'the smallest number a JS number can hold is still read');
    assert.equal(fromJsNumber(Number.NaN), null);
    assert.equal(fromJsNumber(Number.POSITIVE_INFINITY), null);
    assert.deepEqual(readAmount({ amount: '12.50', currency: 'XTS' }), { amount: exact(25n, 2n), currency: 'XTS' });
    assert.deepEqual(readAmount({ amount: 12.5, currency: 'XTS' }), { amount: exact(25n, 2n), currency: 'XTS' });
    for (const bad of [null, 'text', 4, [], {}, { amount: '1' }, { currency: 'XTS' }, { amount: 'abc', currency: 'XTS' }, { amount: '1', currency: '' }, { amount: true, currency: 'XTS' }]) {
      assert.equal(readAmount(bad), null, JSON.stringify(bad));
    }
  });

  await suite.test('exact numbers: a ratio stays exact where floating point drifts, and a third is a third', () => {
    // The same sums in floating point miss the answer: these are the cases the evaluator must not get wrong.
    assert.ok(0.3 / 0.1 < 3, 'floating point says 0.3 / 0.1 is below 3');
    assert.ok(0.29 / 0.1 < 2.9, 'floating point says 0.29 / 0.1 is below 2.9');
    assert.notEqual(0.07 / 0.7, 0.1, 'floating point says 0.07 / 0.7 is not 0.1');
    assert.equal(compareExact(divideExact(parseExact('0.3')!, parseExact('0.1')!)!, exact(3n)), 0);
    assert.equal(compareExact(divideExact(parseExact('0.29')!, parseExact('0.1')!)!, parseExact('2.9')!), 0);
    assert.equal(compareExact(divideExact(parseExact('0.07')!, parseExact('0.7')!)!, parseExact('0.1')!), 0);
    const third = divideExact(exact(1n), exact(3n))!;
    assert.equal(compareExact(third, parseExact('0.3333333333333333')!), 1, 'a third is above every finite string of threes');
    assert.equal(compareExact(third, parseExact('0.3333333333333334')!), -1);
    assert.equal(compareExact(exact(-1n, 3n), exact(1n, -3n)), 0);
    assert.equal(divideExact(exact(1n), exact(0n)), null, 'there is no answer for a zero divisor, and no stand-in for one');
    assert.deepEqual([signOf(exact(-2n)), signOf(exact(0n)), signOf(exact(1n, 7n))], [-1, 0, 1]);
    assert.throws(() => exact(1n, 0n), RangeError);
  });

  await suite.test('exact numbers: a decimal is written out in full, a fraction that has none stays a fraction, nothing is rounded', () => {
    assert.equal(formatExact(exact(5n)), '5');
    assert.equal(formatExact(exact(-5n)), '-5');
    assert.equal(formatExact(exact(1n, 4n)), '0.25');
    assert.equal(formatExact(exact(-7n, 2n)), '-3.5');
    assert.equal(formatExact(exact(9n, 10n)), '0.9');
    assert.equal(formatExact(exact(1n, 1000n)), '0.001');
    assert.equal(formatExact(exact(3n, 2000n)), '0.0015');
    assert.equal(formatExact(exact(1n, 3n)), '1/3');
    assert.equal(formatExact(exact(-1n, 3n)), '-1/3');
    assert.equal(formatExact(exact(0n)), '0');
    assert.equal(formatExact(parseExact('9000.00')!), '9000');
    assert.equal(formatExact(parseExact('1e-7')!), '0.0000001');
  });

  await suite.test('credit use: below, at and above the fixture threshold, to the last cent (gte fires at it, gt does not)', () => {
    const signal = creditUse('gte');
    for (const [balance, expected] of [['8999.99', 'clear'], ['9000.00', 'fired'], ['9000.01', 'fired'], ['0.00', 'clear'], ['10000.00', 'fired'], ['15000.00', 'fired']]) {
      const result = worked(signal, context({ facts: creditFacts(balance, '10000.00') }));
      assert.equal(result.status, expected, `balance ${balance}`);
      assert.equal(result.severity, expected === 'fired' ? 'watch' : undefined);
      assert.equal(result.reason, undefined);
    }
    for (const [balance, expected] of [['8999.99', 'clear'], ['9000.00', 'clear'], ['9000.01', 'fired']]) {
      assert.equal(worked(creditUse('gt'), context({ facts: creditFacts(balance, '10000.00') })).status, expected, `gt, balance ${balance}`);
    }
    assert.equal(worked(signal, context({ facts: creditFacts('9', '10') })).status, 'fired', 'the same ratio from small numbers');
    assert.equal(worked(signal, context({ facts: creditFacts('8.99', '10') })).status, 'clear');
    // The threshold itself moves the answer, and only through the setting.
    assert.equal(worked(signal, context({ settings: fixtureSettings({ 'testfixture.useWatch': 0.95 }), facts: creditFacts('9000.00', '10000.00') })).status, 'clear');
    assert.equal(worked(signal, context({ settings: fixtureSettings({ 'testfixture.useWatch': 0 }), facts: creditFacts('0.00', '10000.00') })).status, 'fired', 'a threshold of zero is a value, not "unset"');
  });

  await suite.test('ratios are exact: sums that floating point gets wrong are right here', () => {
    const ratioTest = (key: string, cmp: 'gte' | 'eq') => rule({
      inputs: [{ name: 'a', fact: 'Account.a' }, { name: 'b', fact: 'Account.b' }],
      formula: { op: 'compare', cmp, left: { formula: { op: 'ratio', num: { input: 'a' }, den: { input: 'b' } } }, right: { setting: key } },
      settings: [key],
    });
    // 0.3 / 0.1, 0.29 / 0.1 and 0.07 / 0.7 are 3, 2.9 and 0.1 exactly.
    for (const [a, b, key, cmp] of [[0.3, 0.1, 'testfixture.three', 'gte'], [0.3, 0.1, 'testfixture.three', 'eq'], [0.29, 0.1, 'testfixture.twoPointNine', 'eq'], [0.07, 0.7, 'testfixture.oneTenth', 'eq']] as const) {
      assert.equal(worked(ratioTest(key, cmp), context({ facts: { 'Account.a': ok(a), 'Account.b': ok(b) } })).status, 'fired', `${a} / ${b} ${cmp} ${key}`);
    }
    assert.equal(worked(ratioTest('testfixture.three', 'eq'), context({ facts: { 'Account.a': ok(0.3), 'Account.b': ok(0.1000001) } })).status, 'clear');
    // A third is not 0.33 and not 0.34, and comparing it to a threshold needs no rounding.
    const third = rule({
      inputs: [{ name: 'a', fact: 'Account.a' }, { name: 'b', fact: 'Account.b' }],
      formula: { op: 'compare', cmp: 'gt', left: { formula: { op: 'ratio', num: { input: 'a' }, den: { input: 'b' } } }, right: { setting: 'testfixture.useWatch' } },
      settings: ['testfixture.useWatch'],
    });
    const thirdWith = (threshold: number) => evaluateSignal(third, context({ settings: fixtureSettings({ 'testfixture.useWatch': threshold }), facts: { 'Account.a': ok(1), 'Account.b': ok(3) } }))!;
    assert.equal(thirdWith(0.3333333333333333).status, 'fired');
    assert.equal(thirdWith(0.3333333333333334).status, 'clear');
    assert.equal(thirdWith(0.3333333333333333).evidence.workings[0], 'a (1) divided by b (3) = 1/3');
  });

  await suite.test('positive: zero is not above zero, a small positive is; the amount may be money, a number or plain text', () => {
    const overdue = single({ op: 'positive', of: { input: 'x' } }, 'Account.overdue');
    const status = (value: unknown) => statusOf(overdue, context({ facts: { 'Account.overdue': ok(value) } }));
    assert.equal(status(money('0.00')), 'clear');
    assert.equal(status(money('0.01')), 'fired');
    assert.equal(status(money('-5.00')), 'clear');
    assert.equal(status(money('1250.00')), 'fired');
    assert.equal(status(0), 'clear');
    assert.equal(status(0.01), 'fired');
    assert.equal(status(1e-9), 'fired');
    assert.equal(status('0.01'), 'fired');
    assert.equal(status('0'), 'clear');
    assert.equal(status('abc'), 'not_worked_out');
    assert.equal(worked(overdue, context({ facts: { 'Account.overdue': ok('abc') } })).reason, 'input_unusable');
  });

  await suite.test('is_past: a date is past once its day is over; a date and time is past once the moment has gone; zones count', () => {
    const due = single({ op: 'is_past', of: { input: 'x' } }, 'Account.dueBy');
    const at = (dueBy: string, now: string) => statusOf(due, context({ clock: clockAt(now), facts: { 'Account.dueBy': ok(dueBy) } }));
    // A date alone: not past on the day (not at its first instant, not at its last), past on the day after.
    assert.equal(at('2026-09-01', '2026-08-31T23:59:59Z'), 'clear', 'the day before');
    assert.equal(at('2026-09-01', '2026-09-01T00:00:00Z'), 'clear', 'the first instant of the day');
    assert.equal(at('2026-09-01', '2026-09-01T10:00:00Z'), 'clear', 'during the day');
    assert.equal(at('2026-09-01', '2026-09-01T23:59:59.999Z'), 'clear', 'the last instant of the day');
    assert.equal(at('2026-09-01', '2026-09-02T00:00:00Z'), 'fired', 'the first instant of the day after');
    assert.equal(at('2026-09-01', '2026-09-02T09:00:00Z'), 'fired', 'the day after');
    assert.equal(at('2026-09-01', '2027-01-01T00:00:00Z'), 'fired', 'long after');
    assert.equal(at('2028-02-29', '2028-03-01T00:00:00Z'), 'fired', 'a leap day');
    assert.equal(at('2028-02-29', '2028-02-29T12:00:00Z'), 'clear');
    // A date and time: past once the moment is behind us, not at the moment itself.
    assert.equal(at('2026-09-01T10:00:00Z', '2026-09-01T09:59:59Z'), 'clear');
    assert.equal(at('2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'), 'clear', 'at the moment');
    assert.equal(at('2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'), 'fired');
    assert.equal(at('2026-09-01T10:00:00.500Z', '2026-09-01T10:00:00.400Z'), 'clear');
    assert.equal(at('2026-09-01T10:00:00.500Z', '2026-09-01T10:00:00.600Z'), 'fired');
    // The same moment written in another zone is the same moment.
    assert.equal(at('2026-09-01T23:00:00+13:00', '2026-09-01T10:00:00Z'), 'clear');
    assert.equal(at('2026-09-01T23:00:00+13:00', '2026-09-01T10:00:01Z'), 'fired');
    assert.equal(at('2026-09-01T05:00:00-05:00', '2026-09-01T10:00:00Z'), 'clear');
    // What is not a date, or has no zone, is not guessed at.
    for (const text of ['soon', '', '2026-02-30', '2026-13-01', '2026-09-01T10:00:00', '2026-09-01 10:00:00Z', '01/09/2026']) {
      const result = worked(due, context({ facts: { 'Account.dueBy': ok(text) } }));
      assert.equal(result.status, 'not_worked_out', JSON.stringify(text));
      assert.equal(result.reason, 'input_unusable', JSON.stringify(text));
      assert.deepEqual(result.names, ['x']);
    }
    assert.equal(worked(due, context({ facts: { 'Account.dueBy': ok(42) } })).reason, 'input_unusable');
    assert.deepEqual(parseTime('2026-09-01'), { ms: Date.UTC(2026, 8, 1), dateOnly: true });
    assert.deepEqual(parseTime('2026-09-01T10:00:00Z'), { ms: Date.UTC(2026, 8, 1, 10), dateOnly: false });
    assert.equal(parseTime('2026-09-01T10:00:00'), null);
    assert.equal(parseTime('2027-02-29'), null);
  });

  await suite.test('age: exact, in the stated unit, past a fixture threshold only by more than the threshold', () => {
    const older = (unit: 'days' | 'hours' | 'minutes', key: string, cmp: 'gt' | 'gte' = 'gt') => rule({
      inputs: [{ name: 'created', fact: 'Account.createdAt' }],
      formula: { op: 'compare', cmp, left: { formula: { op: 'age', of: { input: 'created' }, unit } }, right: { setting: key } },
      settings: [key],
    });
    const run = (signal: SignalRule, created: string, now: string) => statusOf(signal, context({ clock: clockAt(now), facts: { 'Account.createdAt': ok(created) } }));
    const days = older('days', 'testfixture.waitDays');
    assert.equal(run(days, '2026-09-01T10:00:00Z', '2026-09-04T09:59:59Z'), 'clear', 'just under three days');
    assert.equal(run(days, '2026-09-01T10:00:00Z', '2026-09-04T10:00:00Z'), 'clear', 'exactly three days is not above three days');
    assert.equal(run(days, '2026-09-01T10:00:00Z', '2026-09-04T10:00:00.001Z'), 'fired', 'a millisecond more');
    assert.equal(run(older('days', 'testfixture.waitDays', 'gte'), '2026-09-01T10:00:00Z', '2026-09-04T10:00:00Z'), 'fired', 'gte fires at it');
    assert.equal(run(days, '2026-09-01T09:59:59.999Z', '2026-09-04T10:00:00Z'), 'fired', 'created a millisecond earlier');
    assert.equal(run(older('hours', 'testfixture.waitHours'), '2026-09-01T10:00:00Z', '2026-09-04T10:00:00Z'), 'clear', 'the same three days, as 72 hours');
    assert.equal(run(older('hours', 'testfixture.waitHours'), '2026-09-01T10:00:00Z', '2026-09-04T10:00:01Z'), 'fired');
    assert.equal(run(older('minutes', 'testfixture.waitMinutes'), '2026-09-01T10:00:00Z', '2026-09-04T10:00:00Z'), 'clear', 'and as 4320 minutes');
    assert.equal(run(older('minutes', 'testfixture.waitMinutes'), '2026-09-01T10:00:00Z', '2026-09-04T10:01:00Z'), 'fired');
    // A date alone starts at the first instant of its day, in UTC.
    assert.equal(run(days, '2026-09-01', '2026-09-04T00:00:00Z'), 'clear');
    assert.equal(run(days, '2026-09-01', '2026-09-04T00:00:00.001Z'), 'fired');
    // The age in the working is the exact figure, and a future date has a negative age.
    const result = worked(days, context({ clock: clockAt('2026-09-02T10:00:00Z'), facts: { 'Account.createdAt': ok('2026-09-01T10:00:00Z') } }));
    assert.equal(result.evidence.workings[0], "the age of created ('2026-09-01T10:00:00Z') in days = 1");
    const half = worked(days, context({ clock: clockAt('2026-09-01T22:00:00Z'), facts: { 'Account.createdAt': ok('2026-09-01T10:00:00Z') } }));
    assert.equal(half.evidence.workings[0], "the age of created ('2026-09-01T10:00:00Z') in days = 0.5");
    const third = worked(days, context({ clock: clockAt('2026-09-01T18:00:00Z'), facts: { 'Account.createdAt': ok('2026-09-01T10:00:00Z') } }));
    assert.equal(third.evidence.workings[0], "the age of created ('2026-09-01T10:00:00Z') in days = 1/3", 'eight hours is a third of a day, kept as a third');
    assert.equal(run(days, '2026-09-10T10:00:00Z', NOW), 'clear', 'created in the future');
  });

  await suite.test('a list operand counts the rows that pass its test: rows on both sides of it, and the evidence names the ones counted', () => {
    const result = worked(oldUrgent, context({ lists: tickets([T1, T2, T3, T4]) }));
    assert.equal(result.status, 'fired');
    assert.deepEqual(result.evidence.lists, [{
      over: 'Account.tickets', use: 'any', complete: true, conditions: [WORDS.high, WORDS.open, WORDS.old], looked: 4,
      counted: [{ id: 'T1', met: [WORDS.high, WORDS.open, WORDS.old] }],
    }]);
    // Take away the one row that passes: the list is whole, nothing passes, and that is a real "no".
    const none = worked(oldUrgent, context({ lists: tickets([T2, T3, T4]) }));
    assert.equal(none.status, 'clear');
    assert.deepEqual(none.evidence.lists[0].counted, []);
    assert.equal(none.evidence.lists[0].looked, 3);
    // The row exactly at the threshold is not above it; a millisecond older is.
    assert.equal(statusOf(oldUrgent, context({ lists: tickets([ticket('T5', 'high', 'open', '2026-09-01T10:00:00Z')]) })), 'clear');
    assert.equal(statusOf(oldUrgent, context({ lists: tickets([ticket('T6', 'high', 'open', '2026-09-01T09:59:59.999Z')]) })), 'fired');
    // An empty list that is whole is a real zero.
    const empty = worked(oldUrgent, context({ lists: tickets([]) }));
    assert.equal(empty.status, 'clear');
    assert.deepEqual(empty.evidence.lists[0], { over: 'Account.tickets', use: 'any', complete: true, conditions: [WORDS.high, WORDS.open, WORDS.old], looked: 0, counted: [] });
  });

  await suite.test('a count over a list: below, at and above the fixture threshold, and a canonical id is preferred as the row id', () => {
    const pile = rule({
      signalId: 'testfixture-pile',
      formula: { op: 'compare', cmp: 'gte', left: { formula: { op: 'count', of: { over: 'Account.tickets', where: OPEN } } }, right: { setting: 'testfixture.pileUp' } },
      settings: ['testfixture.pileUp'],
    });
    const three = [T1, T2, T3, T4];
    assert.equal(statusOf(pile, context({ lists: tickets(three), settings: fixtureSettings({ 'testfixture.pileUp': 4 }) })), 'clear', 'three open, level four');
    assert.equal(statusOf(pile, context({ lists: tickets(three), settings: fixtureSettings({ 'testfixture.pileUp': 3 }) })), 'fired', 'three open, level three');
    assert.equal(statusOf(pile, context({ lists: tickets(three), settings: fixtureSettings({ 'testfixture.pileUp': 2 }) })), 'fired', 'three open, level two');
    assert.equal(statusOf(pile, context({ lists: tickets([]), settings: fixtureSettings({ 'testfixture.pileUp': 1 }) })), 'clear', 'none at all');
    const withId: SignalListItem = { ...T1, canonicalId: 'canonical-1' };
    const result = worked(pile, context({ lists: tickets([withId, T2, T3, T4]) }));
    assert.deepEqual(result.evidence.lists[0], {
      over: 'Account.tickets', use: 'count', complete: true, conditions: [WORDS.open], looked: 4,
      counted: [{ id: 'canonical-1', met: [WORDS.open] }, { id: 'T2', met: [WORDS.open] }, { id: 'T3', met: [WORDS.open] }],
    });
    assert.equal(result.evidence.workings[0], "the number of Account.tickets where Ticket.status is 'open' = 3");
    // A list used as a plain number counts the rows that pass.
    const asNumber = rule({
      formula: { op: 'compare', cmp: 'eq', left: { over: 'Account.tickets', where: OPEN }, right: { setting: 'testfixture.pileUp' } },
      settings: ['testfixture.pileUp'],
    });
    const used = worked(asNumber, context({ lists: tickets(three) }));
    assert.equal(used.status, 'fired');
    assert.equal(used.evidence.lists[0].use, 'number');
  });

  await suite.test('an or test names which of its parts each counted row met', () => {
    const either = rule({
      formula: { op: 'any', of: { over: 'Account.tickets', where: { op: 'or', of: [HIGH, { op: 'compare', cmp: 'eq', left: { input: 'Ticket.status' }, right: { text: 'solved' } }] } } },
    });
    const result = worked(either, context({ lists: tickets([T1, T3, T4]) }));
    assert.equal(result.status, 'fired');
    assert.deepEqual(result.evidence.lists[0].counted, [
      { id: 'T1', met: [WORDS.high] },
      { id: 'T4', met: [WORDS.high, "Ticket.status is 'solved'"] },
    ]);
    assert.equal(result.evidence.lists[0].looked, 3);
    assert.equal(statusOf(either, context({ lists: tickets([T3]) })), 'clear');
  });

  await suite.test('a list that is cut, or that a system did not answer for, or that was never read, is not worked out: never zero', () => {
    for (const lists of [tickets([T1, T2, T3, T4], false), tickets([], false), {}]) {
      const result = worked(oldUrgent, context({ lists }));
      assert.equal(result.status, 'not_worked_out');
      assert.equal(result.reason, 'signal_input_unavailable');
      assert.deepEqual(result.names, ['Account.tickets']);
      assert.equal(result.result, 'Not worked out: Account.tickets is not available.');
      assert.equal(result.evidence.lists[0].complete, false);
      assert.equal(result.evidence.lists[0].counted, null, 'nothing is counted from a list that is not whole');
    }
    // Even when a row already passes, a list that is not whole settles nothing.
    assert.equal(statusOf(oldUrgent, context({ lists: tickets([T1], false) })), 'not_worked_out');
    // And a count over such a list is not a count of zero.
    const pile = rule({
      formula: { op: 'compare', cmp: 'gte', left: { formula: { op: 'count', of: { over: 'Account.tickets', where: OPEN } } }, right: { setting: 'testfixture.pileUp' } },
      settings: ['testfixture.pileUp'],
    });
    assert.equal(statusOf(pile, context({ lists: tickets([T1, T2, T3], false), settings: fixtureSettings({ 'testfixture.pileUp': 1 }) })), 'not_worked_out');
  });

  await suite.test('a row that lacks a fact the test reads makes the signal not worked out, naming the fact', () => {
    const noDate: SignalListItem = { key: { value: 'T7' }, facts: { 'Ticket.priority': ok('high'), 'Ticket.status': ok('open') } };
    const missing = worked(oldUrgent, context({ lists: tickets([T1, noDate]) }));
    assert.equal(missing.status, 'not_worked_out');
    assert.equal(missing.reason, 'signal_input_unavailable');
    assert.deepEqual(missing.names, ['Ticket.created']);
    const stale: SignalListItem = { ...T2, facts: { ...T2.facts, 'Ticket.created': { status: 'stale', value: '2026-09-03T10:00:00Z', source: stamp() } } };
    assert.deepEqual(worked(oldUrgent, context({ lists: tickets([stale]) })).names, ['Ticket.created']);
    const gone: SignalListItem = { ...T2, facts: { ...T2.facts, 'Ticket.priority': absent() } };
    assert.deepEqual(worked(oldUrgent, context({ lists: tickets([gone]) })).names, ['Ticket.priority']);
    const blank: SignalListItem = { ...T2, facts: { ...T2.facts, 'Ticket.status': { status: 'ok', value: null } } };
    assert.equal(worked(oldUrgent, context({ lists: tickets([blank]) })).reason, 'signal_input_unavailable');
    const odd: SignalListItem = { ...T2, facts: { ...T2.facts, 'Ticket.priority': ok({ nested: true }) } };
    assert.equal(worked(oldUrgent, context({ lists: tickets([odd]) })).reason, 'input_unusable');
  });

  await suite.test('a missing input, a stale input, an input from the wrong kind of source, or one past its age limit: not worked out, naming it, never zero', () => {
    const signal = creditUse();
    const result = worked(signal, context({ facts: { 'Account.balance': absent('not_recorded', 'testfixture-erp'), 'Account.creditLimit': ok(money('10000.00')) } }));
    assert.equal(result.status, 'not_worked_out');
    assert.equal(result.reason, 'signal_input_unavailable');
    assert.deepEqual(result.names, ['balance']);
    assert.equal(result.result, 'Not worked out: balance is not available.');
    assert.equal(result.severity, undefined);
    assert.equal(result.wording, undefined);
    assert.deepEqual(result.evidence.inputs[0], { name: 'balance', fact: 'Account.balance', status: 'not_available', problem: { reason: 'not_recorded', system: 'testfixture-erp' } });
    assert.equal(result.evidence.inputs[1].problem, undefined);
    assert.deepEqual(result.evidence.workings, [], 'nothing was worked out');
    // Both missing: both named. Not supplied at all is the same as missing.
    const both = worked(signal, context({ facts: {} }));
    assert.deepEqual(both.names, ['balance', 'limit']);
    assert.equal(both.result, 'Not worked out: balance, limit are not available.');
    assert.deepEqual(both.evidence.inputs.map((input) => input.problem), [{ reason: 'not_supplied' }, { reason: 'not_supplied' }]);
    // An "ok" fact with no value at all is not a value.
    for (const value of [undefined, null]) {
      const empty = worked(signal, context({ facts: { 'Account.balance': { status: 'ok', value, source: stamp() }, 'Account.creditLimit': ok(money('10000.00')) } }));
      assert.deepEqual(empty.evidence.inputs[0].problem, { reason: 'no_value' });
      assert.deepEqual(empty.names, ['balance']);
    }
    // Stale: the value is shown as stale in the evidence, and the signal is not worked out.
    const stale = worked(signal, context({ facts: { 'Account.balance': { status: 'stale', value: money('9000.00'), source: stamp() }, 'Account.creditLimit': ok(money('10000.00')) } }));
    assert.equal(stale.status, 'not_worked_out');
    assert.equal(stale.evidence.inputs[0].status, 'stale');
    assert.deepEqual(stale.evidence.inputs[0].value, money('9000.00'));
    assert.deepEqual(stale.evidence.inputs[0].problem, { reason: 'stale' });
    // A count that may be higher than the number seen is not a figure to compare against a level.
    const countRule = single({ op: 'compare', cmp: 'gte', left: { input: 'x' }, right: { setting: 'testfixture.pileUp' } }, 'Account.openTickets');
    const exactCount = worked(countRule, context({ facts: { 'Account.openTickets': ok(5) } }));
    assert.equal(exactCount.status, 'fired');
    const atLeast = worked(countRule, context({ facts: { 'Account.openTickets': { ...ok(5), atLeast: true } } }));
    assert.equal(atLeast.status, 'not_worked_out');
    assert.equal(atLeast.reason, 'signal_input_unavailable');
    assert.deepEqual(atLeast.names, ['x']);
    assert.deepEqual(atLeast.evidence.inputs[0].problem, { reason: 'at_least_only' });
    assert.equal(worked(countRule, context({ facts: { 'Account.openTickets': { ...ok(5), atLeast: false } } })).status, 'fired');
    // The rule asks for the source of truth: a cross-check value or a fallback is not accepted.
    for (const authority of ['cross_check', 'fallback'] as const) {
      const wrong = worked(signal, context({ facts: { 'Account.balance': ok(money('9000.00'), stamp({ authority })), 'Account.creditLimit': ok(money('10000.00')) } }));
      assert.deepEqual(wrong.names, ['balance'], authority);
      assert.deepEqual(wrong.evidence.inputs[0].problem, { reason: 'wrong_authority' });
    }
    const unstamped = worked(signal, context({ facts: { 'Account.balance': { status: 'ok', value: money('9000.00') }, 'Account.creditLimit': ok(money('10000.00')) } }));
    assert.deepEqual(unstamped.evidence.inputs[0].problem, { reason: 'wrong_authority' }, 'a value with no source cannot show where it came from');
  });

  await suite.test('an age limit on an input: past it is not worked out, at it is fine, unset means no limit, a limit with no source time is unknown', () => {
    const limited = single({ op: 'positive', of: { input: 'x' } }, 'Account.x', { maxAge: 'testfixture.freshness' });
    const read = (retrievedAt: string, freshness: number | null, extra: Partial<SignalContext> = {}) =>
      worked(limited, context({ settings: fixtureSettings({ 'testfixture.freshness': freshness }), facts: { 'Account.x': ok(5, stamp({ retrievedAt })) }, ...extra }));
    // NOW is 10:00:00; a limit of 60 seconds.
    assert.equal(read('2026-09-04T09:59:00Z', 60).status, 'fired', 'exactly at the limit');
    assert.equal(read('2026-09-04T09:59:01Z', 60).status, 'fired');
    const old = read('2026-09-04T09:58:59Z', 60);
    assert.equal(old.status, 'not_worked_out');
    assert.deepEqual(old.names, ['x']);
    assert.deepEqual(old.evidence.inputs[0].problem, { reason: 'older_than_limit' });
    assert.equal(read('2026-09-04T09:58:59Z', 61).status, 'fired');
    assert.equal(read('2025-01-01T00:00:00Z', null).status, 'fired', 'an unset limit is no limit: the value was read fresh');
    assert.equal(read('2026-09-04T10:05:00Z', 60).status, 'fired', 'read "in the future" is not old');
    // The age is the time since we read it, not the time since the source changed it.
    const changedLongAgo = worked(limited, context({ settings: fixtureSettings({ 'testfixture.freshness': 60 }), facts: { 'Account.x': ok(5, stamp({ sourceUpdatedAt: '2020-01-01T00:00:00Z' })) } }));
    assert.equal(changedLongAgo.status, 'fired');
    // No stamp, or a stamp with no readable time, cannot be aged.
    const noStamp = worked(limited, context({ settings: fixtureSettings({ 'testfixture.freshness': 60 }), facts: { 'Account.x': { status: 'ok', value: 5 } } }));
    assert.deepEqual(noStamp.evidence.inputs[0].problem, { reason: 'unknown_age' });
    assert.deepEqual(read('2026-09-04', 60).evidence.inputs[0].problem, { reason: 'unknown_age' });
    assert.deepEqual(read('yesterday', 60).evidence.inputs[0].problem, { reason: 'unknown_age' });
    // The limit's unit counts: seconds, milliseconds and days are lengths of time, a ratio is not.
    const unitSettings = (unit: SettingDef['unit'], value: number): SettingDef[] => [
      ...fixtureSettings().filter((setting) => setting.key !== 'testfixture.freshness'),
      { key: 'testfixture.freshness', label: 'Fixture age limit', kind: 'freshness', unit, ownerRole: 'testfixture-owner', value },
    ];
    const withUnit = (unit: SettingDef['unit'], value: number, retrievedAt: string) =>
      statusOf(limited, context({ settings: unitSettings(unit, value), facts: { 'Account.x': ok(5, stamp({ retrievedAt })) } }));
    assert.equal(withUnit('milliseconds', 60_000, '2026-09-04T09:59:00Z'), 'fired');
    assert.equal(withUnit('milliseconds', 59_999, '2026-09-04T09:59:00Z'), 'not_worked_out');
    assert.equal(withUnit('days', 1, '2026-09-03T10:00:00Z'), 'fired');
    assert.equal(withUnit('days', 1, '2026-09-03T09:59:59Z'), 'not_worked_out');
    const notTime = worked(limited, context({ settings: unitSettings('ratio', 5), facts: { 'Account.x': ok(5) } }));
    assert.equal(notTime.reason, 'input_unusable');
    assert.equal(notTime.result, 'Not worked out: testfixture.freshness is not a length of time.');
    // A limit the release does not declare at all is a missing setting.
    const undeclared = worked(limited, context({ settings: fixtureSettings().filter((setting) => setting.key !== 'testfixture.freshness'), facts: { 'Account.x': ok(5) } }));
    assert.equal(undeclared.reason, 'setting_missing');
    assert.deepEqual(undeclared.names, ['testfixture.freshness']);
  });

  await suite.test('an unset setting: not worked out, naming the setting and its owner, even when every input is fine', () => {
    const result = worked(creditUse(), context({ settings: fixtureSettings({ 'testfixture.useWatch': null }), facts: creditFacts('9500.00', '10000.00') }));
    assert.equal(result.status, 'not_worked_out');
    assert.equal(result.reason, 'setting_missing');
    assert.deepEqual(result.names, ['testfixture.useWatch']);
    assert.equal(result.result, 'Not worked out: no testfixture.useWatch has been set.');
    assert.deepEqual(result.evidence.settings[0], { key: 'testfixture.useWatch', label: 'Fixture testfixture.useWatch', value: null, ownerRole: 'testfixture-owner', unit: 'ratio' });
    // A setting the release does not declare is named too, with no label or owner to give.
    const undeclared = worked(creditUse(), context({ settings: fixtureSettings().filter((setting) => setting.key !== 'testfixture.useWatch'), facts: creditFacts('9500.00', '10000.00') }));
    assert.deepEqual(undeclared.names, ['testfixture.useWatch']);
    assert.deepEqual(undeclared.evidence.settings[0], { key: 'testfixture.useWatch', label: null, value: null, ownerRole: null, unit: null });
    // A setting only the rule's list names (not its formula) still has to hold a value; so does one only the formula reads.
    const listed = rule({ formula: { op: 'positive', of: { setting: 'testfixture.three' } }, settings: ['testfixture.three', 'testfixture.unlisted'] });
    assert.deepEqual(worked(listed, context({ settings: [...fixtureSettings(), { key: 'testfixture.unlisted', label: 'x', kind: 'threshold', unit: 'count', ownerRole: 'testfixture-owner', value: null }] })).names, ['testfixture.unlisted']);
    const read = rule({ formula: { op: 'positive', of: { setting: 'testfixture.three' } }, settings: [] });
    assert.deepEqual(worked(read, context({ settings: fixtureSettings({ 'testfixture.three': null }) })).names, ['testfixture.three']);
    assert.equal(worked(read, context()).status, 'fired');
    // Several unset: all named.
    const many = rule({
      formula: { op: 'and', of: [{ op: 'positive', of: { setting: 'testfixture.three' } }, { op: 'positive', of: { setting: 'testfixture.pileUp' } }] },
    });
    const manyResult = worked(many, context({ settings: fixtureSettings({ 'testfixture.three': null, 'testfixture.pileUp': null }) }));
    assert.deepEqual(manyResult.names, ['testfixture.three', 'testfixture.pileUp']);
    // A setting is checked before the inputs: with both wrong, the setting is what is named.
    assert.equal(worked(creditUse(), context({ settings: fixtureSettings({ 'testfixture.useWatch': null }), facts: {} })).reason, 'setting_missing');
  });

  await suite.test('a zero or missing divisor: not worked out, naming the divisor, never zero and never a guess', () => {
    const ratio = (cmp: 'gte' | 'lt' = 'gte') => creditUse(cmp);
    for (const limit of ['0.00', '0', '-0.0']) {
      const result = worked(ratio(), context({ facts: creditFacts('9000.00', limit) }));
      assert.equal(result.status, 'not_worked_out', limit);
      assert.equal(result.reason, 'divisor_zero');
      assert.deepEqual(result.names, ['limit']);
      assert.equal(result.result, 'Not worked out: limit is zero or missing.');
    }
    // A divisor of zero must not read as "ratio zero, so below the level".
    assert.equal(worked(ratio('lt'), context({ facts: creditFacts('9000.00', '0.00') })).status, 'not_worked_out');
    assert.equal(worked(ratio(), context({ facts: { 'Account.balance': ok(9000), 'Account.creditLimit': ok(0) } })).reason, 'divisor_zero');
    // A divisor that is a worked-out figure which is zero.
    const nested = rule({
      inputs: [{ name: 'a', fact: 'Account.a' }, { name: 'b', fact: 'Account.b' }],
      formula: { op: 'compare', cmp: 'gt', left: { formula: { op: 'ratio', num: { input: 'a' }, den: { formula: { op: 'ratio', num: { input: 'b' }, den: { input: 'a' } } } } }, right: { setting: 'testfixture.three' } },
      settings: ['testfixture.three'],
    });
    const nestedZero = worked(nested, context({ facts: { 'Account.a': ok(5), 'Account.b': ok(0) } }));
    assert.equal(nestedZero.reason, 'divisor_zero');
    assert.deepEqual(nestedZero.names, ['b divided by a']);
    // A divisor that is missing is an unavailable input, not a zero.
    const missing = worked(ratio(), context({ facts: { 'Account.balance': ok(money('9000.00')), 'Account.creditLimit': absent() } }));
    assert.equal(missing.reason, 'signal_input_unavailable');
    assert.deepEqual(missing.names, ['limit']);
    // A numerator of zero over a real divisor is an ordinary zero.
    assert.equal(worked(ratio(), context({ facts: creditFacts('0.00', '10000.00') })).status, 'clear');
  });

  await suite.test('values of the wrong kind are not guessed at: two currencies, text where a number belongs, an undeclared input, a formula that is not yes or no', () => {
    const currencies = worked(creditUse(), context({ facts: { 'Account.balance': ok({ amount: '9000.00', currency: 'XTS' }), 'Account.creditLimit': ok({ amount: '10000.00', currency: 'XTT' }) } }));
    assert.equal(currencies.status, 'not_worked_out');
    assert.equal(currencies.reason, 'input_unusable');
    assert.equal(currencies.result, 'Not worked out: balance and limit are in different currencies.');
    assert.deepEqual(currencies.names, ['balance', 'limit']);
    // Money against a plain number (a setting has no currency) is fine; money against money of the same currency is fine.
    assert.equal(worked(creditUse(), context({ facts: { 'Account.balance': ok(money('9000.00')), 'Account.creditLimit': ok(10000) } })).status, 'fired');
    const words = worked(creditUse(), context({ facts: { 'Account.balance': ok('lots'), 'Account.creditLimit': ok(money('10000.00')) } }));
    assert.equal(words.reason, 'input_unusable');
    assert.deepEqual(words.names, ['balance']);
    assert.equal(worked(creditUse(), context({ facts: { 'Account.balance': ok({ not: 'money' }), 'Account.creditLimit': ok(money('10000.00')) } })).reason, 'input_unusable');
    const undeclared = worked(rule({ formula: { op: 'positive', of: { input: 'ghost' } } }), context());
    assert.equal(undeclared.reason, 'input_unusable');
    assert.equal(undeclared.result, 'Not worked out: the formula reads ghost, which the rule does not declare.');
    const notYesNo = worked(single({ op: 'ratio', num: { input: 'x' }, den: { input: 'x' } }), context({ facts: { 'Account.x': ok(5) } }));
    assert.equal(notYesNo.reason, 'input_unusable');
    assert.match(notYesNo.result, /does not give a yes or no/);
    const inAnd = worked(single({ op: 'and', of: [{ op: 'positive', of: { input: 'x' } }, { op: 'ratio', num: { input: 'x' }, den: { input: 'x' } }] }), context({ facts: { 'Account.x': ok(5) } }));
    assert.equal(inAnd.reason, 'input_unusable');
  });

  await suite.test('comparing: numbers as numbers, a text as a number only against a number, texts equal or not, dates as dates, yes/no equal or not', () => {
    const two = (cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq') => rule({
      inputs: [{ name: 'a', fact: 'Account.a' }, { name: 'b', fact: 'Account.b' }],
      formula: { op: 'compare', cmp, left: { input: 'a' }, right: { input: 'b' } },
    });
    const run = (cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', a: unknown, b: unknown) => evaluateSignal(two(cmp), context({ facts: { 'Account.a': ok(a), 'Account.b': ok(b) } }))!;
    assert.equal(run('lt', 9, 10).status, 'fired');
    assert.equal(run('lte', 10, 10).status, 'fired');
    assert.equal(run('gt', 10, 10).status, 'clear');
    assert.equal(run('eq', 10, '10').status, 'fired', 'a text read as a number against a number');
    assert.equal(run('eq', '007', '7').status, 'clear', 'two texts are texts: 007 is not 7');
    assert.equal(run('eq', 'high', 'high').status, 'fired');
    assert.equal(run('eq', 'high', 'High').status, 'clear', 'texts are equal as written');
    assert.equal(run('gt', 'high', 'low').reason, 'input_unusable', 'texts that are not dates have no order');
    assert.equal(run('gt', '2026-09-02', '2026-09-01').status, 'fired');
    assert.equal(run('lt', '2026-09-01T10:00:00Z', '2026-09-01T09:00:00Z').status, 'clear');
    assert.equal(run('eq', true, true).status, 'fired');
    assert.equal(run('eq', true, false).status, 'clear');
    assert.equal(run('gt', true, false).reason, 'input_unusable', 'yes/no has no order');
    assert.equal(run('eq', 'high', 10).reason, 'input_unusable', 'a word against a number');
    assert.equal(run('eq', true, 'true').reason, 'input_unusable');
    const tags = single({ op: 'compare', cmp: 'gte', left: { formula: { op: 'count', of: { input: 'x' } } }, right: { setting: 'testfixture.pileUp' } }, 'Account.tags');
    assert.equal(statusOf(tags, context({ facts: { 'Account.tags': ok(['a', 'b', 'c']) } })), 'fired');
    assert.equal(statusOf(tags, context({ facts: { 'Account.tags': ok(['a', 'b']) } })), 'clear');
    assert.equal(statusOf(tags, context({ facts: { 'Account.tags': ok([]) } })), 'clear');
    assert.equal(worked(tags, context({ facts: { 'Account.tags': ok('a,b,c') } })).reason, 'input_unusable', 'a count needs a list');
  });

  await suite.test('and, or and nesting are worked out in full: no short cut lets one part hide another that could not be worked out', () => {
    const attention = rule({
      inputs: [{ name: 'overdue', fact: 'Account.overdue' }],
      formula: { op: 'or', of: [{ op: 'positive', of: { input: 'overdue' } }, { op: 'any', of: { over: 'Account.tickets', where: { op: 'is_past', of: { input: 'Ticket.dueBy' } } } }] },
    });
    const row = (id: string, dueBy: string): SignalListItem => ({ key: { value: id }, facts: { 'Ticket.dueBy': ok(dueBy) } });
    const run = (overdue: string, rows: SignalListItem[], complete = true) => worked(attention, context({ facts: { 'Account.overdue': ok(money(overdue)) }, lists: tickets(rows, complete) }));
    assert.equal(run('0.00', [row('T1', '2026-09-04T09:00:00Z')]).status, 'fired', 'a ticket past due');
    assert.equal(run('0.00', [row('T1', '2026-09-04T11:00:00Z')]).status, 'clear', 'a ticket not yet due');
    assert.equal(run('5.00', []).status, 'fired', 'overdue on the account');
    assert.deepEqual(run('0.00', [row('T1', '2026-09-04T09:00:00Z'), row('T2', '2026-09-04T11:00:00Z')]).evidence.lists[0].counted, [{ id: 'T1', met: ['Ticket.dueBy is in the past'] }]);
    // Overdue alone would fire, but the ticket list is not whole: the whole signal is not worked out.
    const partial = run('5.00', [], false);
    assert.equal(partial.status, 'not_worked_out');
    assert.deepEqual(partial.names, ['Account.tickets']);
    // The same with a nested group.
    const nested = rule({
      inputs: [{ name: 'x', fact: 'Account.x' }],
      formula: { op: 'and', of: [{ op: 'or', of: [{ op: 'positive', of: { input: 'x' } }, { op: 'positive', of: { input: 'ghost' } }] }, { op: 'positive', of: { input: 'x' } }] },
    });
    assert.equal(worked(nested, context({ facts: { 'Account.x': ok(1) } })).reason, 'input_unusable', 'the undeclared input in the or part is reached');
  });

  await suite.test('a draft signal never fires, even with every setting set and every input fine; an unset setting is still named', () => {
    const draft = { ...creditUse(), status: 'draft' as const };
    const { activatedBy, activatedAt, ...withoutNames } = draft;
    assert.ok(activatedBy && activatedAt);
    const fine = context({ facts: creditFacts('9500.00', '10000.00') });
    assert.equal(worked(creditUse(), fine).status, 'fired', 'the same signal, active');
    for (const signal of [draft, withoutNames]) {
      const result = worked(signal, fine);
      assert.equal(result.status, 'not_worked_out');
      assert.equal(result.reason, 'draft');
      assert.deepEqual(result.names, []);
      assert.equal(result.result, 'Not worked out: this signal is still a draft.');
      assert.equal(result.severity, undefined);
      assert.equal(result.wording, undefined);
      assert.equal(result.evidence.rule.status, 'draft');
      assert.equal(result.evidence.inputs.length, 2, 'the evidence still shows the inputs');
    }
    // The design's example: a draft whose threshold is unset says so, and names the setting and its owner.
    const credit = accountFixtureDictionary.signalRules[0];
    assert.equal(credit.status, 'draft');
    const facts = { 'Account.balance': ok(money('9500.00')), 'Account.creditLimit': ok(money('10000.00')) };
    const result = worked(credit, context({ settings: accountFixtureDictionary.settings, facts }));
    assert.equal(result.reason, 'setting_missing');
    assert.deepEqual(result.names, ['credit.useWatch']);
    assert.deepEqual(result.evidence.settings[0], { key: 'credit.useWatch', label: 'Credit use watch level', value: null, ownerRole: 'finance', unit: 'ratio' });
    assert.deepEqual(result.evidence.settings[1], { key: 'freshness.credit', label: 'How old a credit figure may be', value: null, ownerRole: 'finance', unit: 'seconds' });
    // With the threshold set the draft is still a draft.
    const set = accountFixtureDictionary.settings.map((setting) => (setting.key === 'credit.useWatch' ? { ...setting, value: 0.9 } : setting));
    assert.equal(worked(credit, context({ settings: set, facts })).reason, 'draft');
  });

  await suite.test('the shipped-style rules of the golden block: the active ticket rule at its boundary, the drafts, and the inputs each one reads', () => {
    const find = (id: string): SignalRule => golden.signalRules.find((entry) => entry.signalId === id)!;
    const urgent = find('sig-old-urgent-ticket');
    assert.equal(urgent.status, 'active');
    assert.equal(golden.settings.find((setting) => setting.key === 'ticket.highPriorityAge')!.value, 3, 'the golden block carries its own fixture value');
    const goldenContext = (items: SignalListItem[], complete = true) => context({ settings: golden.settings, lists: tickets(items, complete) });
    assert.equal(statusOf(urgent, goldenContext([T1, T2, T3, T4])), 'fired');
    assert.equal(statusOf(urgent, goldenContext([ticket('Tx', 'high', 'open', '2026-09-01T10:00:00Z')])), 'clear', 'exactly three days');
    assert.equal(statusOf(urgent, goldenContext([ticket('Ty', 'high', 'open', '2026-09-01T09:59:59.999Z')])), 'fired');
    assert.equal(statusOf(urgent, goldenContext([T1], false)), 'not_worked_out');
    const pile = find('sig-ticket-pileup');
    const unsetPile = worked(pile, goldenContext([T1, T2, T3]));
    assert.equal(unsetPile.reason, 'setting_missing');
    assert.deepEqual(unsetPile.names, ['ticket.pileUp']);
    assert.equal(worked(find('sig-credit-use'), context({ settings: golden.settings })).reason, 'setting_missing');
    // The attention rule reads one declared input and one fact of the rows it counts over.
    const attention = { ...find('sig-account-attention'), status: 'active' as const, activatedBy: 'Test Approver', activatedAt: '2026-10-29T09:30:00Z' };
    assert.deepEqual(signalInputFacts(attention), ['Account.overdue', 'Ticket.dueBy']);
    assert.deepEqual(signalInputFacts(urgent), ['Ticket.priority', 'Ticket.status', 'Ticket.created']);
    assert.deepEqual(signalInputFacts(pile), ['Ticket.status']);
    assert.deepEqual(signalInputFacts(find('sig-credit-use')), ['Account.balance', 'Account.creditLimit']);
    assert.deepEqual(signalInputFacts(single({ op: 'positive', of: { input: 'x' } }, 'Account.x')), ['Account.x']);
    const dueRow: SignalListItem = { key: { value: 'T9' }, facts: { 'Ticket.dueBy': ok('2026-09-04T09:00:00Z') } };
    const overdueFacts = { 'Account.overdue': ok(money('0.00')) };
    assert.equal(statusOf(attention, context({ settings: golden.settings, facts: overdueFacts, lists: tickets([dueRow]) })), 'fired');
  });

  await suite.test('a signal with one input the person may not see is absent: no result, no hint, and nothing of it in any evidence', () => {
    const facts = { ...creditFacts('9500.00', '10000.00'), 'Account.overdue': ok(money('5.00')) };
    const overdue = rule({ signalId: 'testfixture-overdue', name: 'Fixture overdue', inputs: [{ name: 'overdue', fact: 'Account.overdue' }], formula: { op: 'positive', of: { input: 'overdue' } } });
    const credit = creditUse();
    // As a set, and as a test: the same answer.
    for (const visible of [new Set(['Account.balance', 'Account.overdue']), (fact: string) => fact !== 'Account.creditLimit']) {
      assert.equal(evaluateSignal(credit, context({ visible, facts })), null, 'the limit is hidden, so the signal is absent');
      assert.equal(evaluateSignal(overdue, context({ visible, facts }))?.status, 'fired');
    }
    // Absent first: not a draft's "not worked out", not an unset setting's, not a missing input's.
    const draft = { ...credit, status: 'draft' as const };
    const hidden = new Set<string>();
    assert.equal(evaluateSignal(draft, context({ visible: hidden, facts })), null);
    assert.equal(evaluateSignal(credit, context({ visible: hidden, settings: fixtureSettings({ 'testfixture.useWatch': null }), facts: {} })), null);
    assert.equal(evaluateSignal(accountFixtureDictionary.signalRules[0], context({ visible: hidden, settings: accountFixtureDictionary.settings, facts: {} })), null);
    // A fact of the rows a list operand tests counts as an input too.
    assert.equal(evaluateSignal(oldUrgent, context({ visible: (fact) => fact !== 'Ticket.priority', lists: tickets([T1]) })), null);
    assert.equal(evaluateSignal(oldUrgent, context({ visible: (fact) => fact !== 'Ticket.created', lists: tickets([T1]) })), null);
    assert.equal(evaluateSignal(oldUrgent, context({ visible: new Set(['Ticket.priority', 'Ticket.status', 'Ticket.created']), lists: tickets([T1]) }))?.status, 'fired');
    // In a batch the hidden signal is simply not there, and its inputs, source and values appear nowhere.
    const batch = evaluateSignals([credit, overdue], context({ visible: (fact) => fact === 'Account.overdue', facts }));
    assert.deepEqual(batch.map((entry) => entry.signalId), ['testfixture-overdue']);
    const text = JSON.stringify(batch);
    for (const leaked of ['Account.balance', 'Account.creditLimit', '9500', '10000', 'testfixture-credit-use', 'Fixture credit use', 'useWatch']) {
      assert.ok(!text.includes(leaked), `the batch does not mention ${leaked}`);
    }
    assert.ok(!signalEvidenceText(batch[0].evidence).includes('Account.balance'));
  });

  await suite.test('the evidence of a fired signal holds what design 17.1 asks for: inputs with source and time, the formula, the settings with owner, the rule, the release, the result', () => {
    const result = worked(creditUse(), context({ facts: creditFacts('9000.00', '10000.00') }));
    assert.equal(result.status, 'fired');
    assert.deepEqual(result.wording, ['A fixture sentence.']);
    assert.equal(result.severity, 'watch');
    assert.equal(result.result, 'watch');
    assert.deepEqual(result.evidence, {
      inputs: [
        { name: 'balance', fact: 'Account.balance', status: 'ok', value: money('9000.00'), source: stamp(), asOf: 'as of 2026-09-04T09:30:00Z' },
        { name: 'limit', fact: 'Account.creditLimit', status: 'ok', value: money('10000.00'), source: stamp({ sourceUpdatedAt: null }), asOf: 'as read at 2026-09-04T09:59:00Z' },
      ],
      lists: [],
      formula: 'balance divided by limit is at or above testfixture.useWatch',
      workings: [
        'balance (9000 XTS) divided by limit (10000 XTS) = 0.9',
        'balance divided by limit (0.9) is at or above testfixture.useWatch (0.9): yes',
      ],
      settings: [
        { key: 'testfixture.useWatch', label: 'Fixture testfixture.useWatch', value: 0.9, ownerRole: 'testfixture-owner', unit: 'ratio' },
        { key: 'testfixture.freshness', label: 'Fixture testfixture.freshness', value: null, ownerRole: 'testfixture-owner', unit: 'seconds' },
      ],
      rule: { signalId: 'testfixture-credit-use', name: 'Fixture credit use', status: 'active' },
      release: { version: 'testfixture-release-1', checksum: 'testfixture-checksum' },
      result: 'watch',
    });
    assert.equal(signalEvidenceText(result.evidence), [
      'Fixture credit use (testfixture-credit-use), active.',
      'Result: watch.',
      'Input balance (Account.balance): 9000 XTS, from testfixture-erp (sample data), as of 2026-09-04T09:30:00Z.',
      'Input limit (Account.creditLimit): 10000 XTS, from testfixture-erp (sample data), as read at 2026-09-04T09:59:00Z.',
      'Formula: balance divided by limit is at or above testfixture.useWatch.',
      'Working: balance (9000 XTS) divided by limit (10000 XTS) = 0.9.',
      'Working: balance divided by limit (0.9) is at or above testfixture.useWatch (0.9): yes.',
      'Setting testfixture.useWatch (Fixture testfixture.useWatch, owner testfixture-owner, ratio): 0.9.',
      'Setting testfixture.freshness (Fixture testfixture.freshness, owner testfixture-owner, seconds): not set.',
      'Release testfixture-release-1, checksum testfixture-checksum.',
    ].join('\n'));
  });

  await suite.test('the as-of line follows the time the stamp says to trust, not whether the tool also gave a time of its own', () => {
    const positive = single({ op: 'positive', of: { input: 'x' } });
    const asOfOf = (source: SignalSource): string | undefined => worked(positive, context({ facts: { 'Account.x': ok(5, source) } })).evidence.inputs[0].asOf;
    // The contract says to trust the time we read it, though the tool gave an update time too: the update time is not the one to print.
    assert.equal(
      asOfOf(stamp({ sourceUpdatedAt: '2020-01-01T00:00:00Z', retrievedAt: '2026-09-04T09:59:00Z', asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z' } })),
      'as read at 2026-09-04T09:59:00Z',
    );
    assert.equal(
      asOfOf(stamp({ sourceUpdatedAt: '2026-09-04T09:30:00Z', retrievedAt: '2026-09-04T09:59:00Z', asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z' } })),
      'as read at 2026-09-04T09:59:00Z',
    );
    // The contract says to trust the source's own time and the tool gave one.
    assert.equal(
      asOfOf(stamp({ sourceUpdatedAt: '2026-09-04T09:30:00Z', retrievedAt: '2026-09-04T09:59:00Z', asOf: { kind: 'as_of', at: '2026-09-04T09:30:00Z' } })),
      'as of 2026-09-04T09:30:00Z',
    );
    // The contract says to trust the source's own time but the tool gave none: the stamp fell back to the time of reading.
    assert.equal(
      asOfOf(stamp({ sourceUpdatedAt: null, retrievedAt: '2026-09-04T09:59:00Z', asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z' } })),
      'as read at 2026-09-04T09:59:00Z',
    );
    // A stamp that says nothing about it keeps the plain reading: the tool's own time when it gave one, else the time of reading.
    assert.equal(asOfOf(stamp({ sourceUpdatedAt: '2026-09-04T09:30:00Z' })), 'as of 2026-09-04T09:30:00Z');
    assert.equal(asOfOf(stamp({ sourceUpdatedAt: null })), 'as read at 2026-09-04T09:59:00Z');

    // The decision travels into the evidence source as its two fields only, and as a copy of the caller's.
    const trusted = stamp({ sourceUpdatedAt: '2026-09-04T09:30:00Z', asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z' } });
    const wide = { ...trusted, asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z', note: 'testfixture-not-carried' } } as SignalSource;
    const result = worked(positive, context({ facts: { 'Account.x': ok(5, wide) } }));
    assert.deepEqual(result.evidence.inputs[0].source, trusted);
    assert.ok(!JSON.stringify(result).includes('testfixture-not-carried'));
    (result.evidence.inputs[0].source as SignalSource).asOf = { kind: 'as_of', at: 'changed' };
    assert.deepEqual(wide.asOf, { kind: 'as_read_at', at: '2026-09-04T09:59:00Z', note: 'testfixture-not-carried' });

    // In the lines `explain` shows, the time printed is the one the stamp trusts and the one it does not trust is not printed.
    const line = signalEvidenceText(worked(positive, context({
      facts: { 'Account.x': ok(5, stamp({ sourceUpdatedAt: '2020-01-01T00:00:00Z', asOf: { kind: 'as_read_at', at: '2026-09-04T09:59:00Z' } })) },
    })).evidence);
    assert.match(line, /Input x \(Account\.x\): 5, from testfixture-erp \(sample data\), as read at 2026-09-04T09:59:00Z\./);
    assert.ok(!line.includes('2020-01-01'));
  });

  await suite.test('the evidence text for a clear signal, a list, a problem and a setting the release does not declare', () => {
    const clear = worked(creditUse(), context({ facts: creditFacts('1000.00', '10000.00') }));
    assert.equal(clear.status, 'clear');
    assert.equal(clear.result, 'clear');
    assert.match(signalEvidenceText(clear.evidence), /^Fixture credit use \(testfixture-credit-use\), active\.\nResult: clear\.\n/);
    assert.match(signalEvidenceText(clear.evidence), /balance divided by limit \(0\.1\) is at or above testfixture\.useWatch \(0\.9\): no/);
    const listed = signalEvidenceText(worked(oldUrgent, context({ lists: tickets([T1, T2, T3, T4]) })).evidence);
    assert.match(listed, new RegExp(`List Account\\.tickets: looked at 4, counted 1: T1 \\(${WORDS.high}; ${WORDS.open}; ${WORDS.old}\\) \\(tests: `));
    assert.match(listed, /Working: any of Account\.tickets where .*: yes\./);
    const cut = signalEvidenceText(worked(oldUrgent, context({ lists: tickets([T1], false) })).evidence);
    assert.match(cut, /Result: Not worked out: Account\.tickets is not available\.\n/);
    assert.match(cut, /List Account\.tickets: not counted, because the list is not complete/);
    const missing = signalEvidenceText(worked(creditUse(), context({ facts: { 'Account.balance': absent('not_recorded', 'testfixture-erp') } })).evidence);
    assert.match(missing, /Input balance \(Account\.balance\): not usable \(not_recorded, testfixture-erp\)\./);
    assert.match(missing, /Input limit \(Account\.creditLimit\): not usable \(not_supplied\)\./);
    const undeclared = signalEvidenceText(worked(creditUse(), context({ settings: fixtureSettings().filter((setting) => setting.key !== 'testfixture.useWatch') })).evidence);
    assert.match(undeclared, /Setting testfixture\.useWatch: not declared in this release\./);
  });

  await suite.test('the formula in words reads the rule alone, and every operator and operand has words', () => {
    const find = (id: string): SignalRule => golden.signalRules.find((entry) => entry.signalId === id)!;
    assert.equal(renderFormula(find('sig-credit-use').formula), 'balance divided by limit is at or above credit.useWatch');
    assert.equal(renderFormula(find('sig-account-attention').formula), 'overdue is above zero or any of Account.tickets where Ticket.dueBy is in the past');
    assert.equal(renderFormula(find('sig-ticket-pileup').formula), "the number of Account.tickets where Ticket.status is 'open' is at or above ticket.pileUp");
    assert.equal(renderFormula(find('sig-old-urgent-ticket').formula), `any of Account.tickets where ${WORDS.high} and ${WORDS.open} and the age of Ticket.created in days is above ticket.highPriorityAge`);
    const nested: Formula = {
      op: 'and', of: [
        { op: 'or', of: [{ op: 'positive', of: { input: 'a' } }, { op: 'is_past', of: { input: 'b' } }] },
        { op: 'compare', cmp: 'eq', left: { formula: { op: 'compare', cmp: 'lt', left: { input: 'a' }, right: { setting: 'testfixture.three' } } }, right: { input: 'c' } },
      ],
    };
    assert.equal(renderFormula(nested), '(a is above zero or b is in the past) and (a is below testfixture.three) is c');
    for (const [cmp, words] of [['gt', 'is above'], ['gte', 'is at or above'], ['lt', 'is below'], ['lte', 'is at or below'], ['eq', 'is']] as const) {
      assert.equal(renderFormula({ op: 'compare', cmp, left: { input: 'a' }, right: { input: 'b' } }), `a ${words} b`);
    }
    assert.equal(renderFormula({ op: 'age', of: { input: 'a' }, unit: 'hours' }), 'the age of a in hours');
    // The words carry no value: the same rule reads the same whatever was read.
    const a = worked(creditUse(), context({ facts: creditFacts('1.00', '10.00') })).evidence.formula;
    const b = worked(creditUse(), context({ facts: creditFacts('9.00', '10.00') })).evidence.formula;
    assert.equal(a, b);
  });

  await suite.test('the evaluator is pure: frozen inputs are not touched, the evidence is a copy, the answer is the same every time, and the clock is read once per batch', () => {
    const ctx = deepFreeze(context({ facts: creditFacts('9500.00', '10000.00'), lists: tickets([T1, T2, T3, T4]) }));
    const signal = deepFreeze(creditUse());
    const first = evaluateSignal(signal, ctx)!;
    const second = evaluateSignal(signal, ctx)!;
    assert.deepEqual(first, second);
    first.evidence.inputs[0].value = 'changed';
    (first.evidence.inputs[0].source as SignalSource).system = 'changed';
    first.names?.push('changed');
    assert.deepEqual(ctx.facts['Account.balance'].value, money('9500.00'), 'the fact the caller holds is unchanged');
    assert.equal(ctx.facts['Account.balance'].source?.system, 'testfixture-erp');
    assert.deepEqual(evaluateSignal(signal, ctx)!.evidence.inputs[0].value, money('9500.00'));
    // The source keeps only its own fields.
    const wide = { ...stamp(), secret: 'testfixture-not-a-secret', extra: { deep: true } } as SignalSource;
    const copied = worked(single({ op: 'positive', of: { input: 'x' } }), context({ facts: { 'Account.x': ok(1, wide) } }));
    assert.deepEqual(copied.evidence.inputs[0].source, stamp());
    assert.ok(!JSON.stringify(copied).includes('testfixture-not-a-secret'));
    let reads = 0;
    const counting = { now: () => { reads += 1; return new Date(NOW); } };
    const many = evaluateSignals([creditUse(), oldUrgent, single({ op: 'positive', of: { input: 'x' } })], context({ clock: counting, facts: creditFacts('9500.00', '10000.00'), lists: tickets([T1]) }));
    assert.equal(many.length, 3);
    assert.equal(reads, 1, 'one instant for the whole batch');
    assert.throws(() => evaluateSignal(creditUse(), context({ clock: { now: () => new Date(Number.NaN) } })), /valid time/);
  });

  await suite.test('the signals module stands alone: no sibling imports, no clock but the injected one, no network, no randomness, and a small public surface', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts')).sort();
    assert.deepEqual(files, ['decimal.ts', 'evaluate.ts', 'evidence.ts', 'formula.ts', 'index.ts', 'list.ts']);
    for (const name of files) {
      const source = readFileSync(path.join(SRC, name), 'utf8');
      for (const [, target] of source.matchAll(/from '([^']+)'/g)) {
        assert.ok(target.startsWith('./') || target === '../model', `${name} imports ${target}`);
      }
      for (const forbidden of ['Date.now(', 'new Date()', 'Math.random', 'process.', 'fetch(', 'require(', 'setTimeout', 'node:', 'localStorage']) {
        assert.ok(!source.includes(forbidden), `${name} uses ${forbidden}`);
      }
    }
    assert.deepEqual(Object.keys(signals).sort(), ['evaluateSignal', 'evaluateSignals', 'signalEvidenceText', 'signalInputFacts']);
  });

  await suite.test('every fixture threshold is a labelled test value: the testfixture prefix, an owner that is not a real role, and no shipped value touched', () => {
    for (const key of Object.keys(FIXTURE_VALUES)) assert.ok(key.startsWith('testfixture.'), key);
    for (const setting of fixtureSettings()) assert.equal(setting.ownerRole, 'testfixture-owner');
    assert.ok(readFileSync(__filename, 'utf8').includes('TEST FIXTURE ONLY'), 'the banner is there');
    // The block that ships has no value to read from here: the golden block's own fixture value is the only number a test borrows from it.
    for (const setting of accountFixtureDictionary.settings) assert.equal(setting.value, null, setting.key);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
