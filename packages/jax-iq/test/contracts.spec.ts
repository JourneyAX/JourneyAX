import './setup/no-world';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import * as contracts from '../src/contracts';
import { checkContractContinuity, listUnknownContracts } from '../src/contracts';
import type { ContractContinuityBlock, ContractContinuityIssue, MeaningContractLine } from '../src/contracts';
import { contractDifferences, isSignedChange, MEANING_CONTRACT_LINES } from '../src/contracts/compare';
import { ContractChangeSchema } from '../src/model';
import type { Binding, ContractChange, JaxOntologyRelease, MeaningContract } from '../src/model';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';
import { minimalDictionary } from './fixtures/minimal.dictionary';

/**
 * The meaning-contract continuity check (R7) and the first-pass list of unknown contracts. A fact bound to another system or tool must
 * keep the five lines of its contract, or carry a contract change that a person signed. TEST FIXTURE ONLY: the systems, tools, units
 * and names are made up for the test, and no value is a business decision.
 */
const suite = createSuite('jax-iq: meaning-contract continuity and the list of unknown contracts');

const SRC = path.resolve(__dirname, '../src/contracts');
const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));

const clone = <T>(value: T): T => structuredClone(value);

const MONEY: MeaningContract = { unit: 'currency amount', currency: 'from_record', tax: 'unknown', asOf: 'retrieved', counts: 'unknown' };
const COUNT: MeaningContract = { unit: 'orders', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'orders in state Open' };
const FACT = 'Account.balance';

interface Spec {
  target?: string;
  link?: boolean;
  system: string;
  tool: string;
  contract?: MeaningContract;
  authority?: Binding['authority'];
  suffix?: string;
}

/** A binding with only the parts the check reads filled in with care; the rest is the same for every binding. */
const bind = ({ target = FACT, link = false, system, tool, contract = MONEY, authority = 'source_of_truth', suffix = '' }: Spec): Binding => ({
  bindingId: `${target}@${system}.${tool}${suffix}`,
  target: link ? { kind: 'link', link: target } : { kind: 'fact', fact: target },
  system, tool,
  args: { accountId: { from: 'key', kind: 'account_number' } },
  select: 'record.value',
  presence: 'required', authority, freshnessKind: 'credit',
  contract: clone(contract),
});

const blockOf = (bindings: Binding[], contractChanges: ContractChange[] = []): ContractContinuityBlock => ({ bindings, contractChanges });

/** A contract change that passes the real schema, so "signed" in a fixture means what it means in a release. */
const signedChange = (factOrLink: string, from: MeaningContract, to: MeaningContract, extra: Partial<ContractChange> = {}): ContractChange =>
  ContractChangeSchema.parse({ factOrLink, from, to, reason: 'Test reason.', approvedBy: 'Test Approver', approvedAt: '2026-10-29T09:30:00Z', ...extra });

const check = (previous: Binding[], next: Binding[], contractChanges: ContractChange[] = []): ContractContinuityIssue[] =>
  checkContractContinuity(blockOf(previous), blockOf(next, contractChanges));
const errorsOf = (issues: ContractContinuityIssue[]) => issues.filter((issue) => issue.severity === 'error');
const only = (issues: ContractContinuityIssue[]): ContractContinuityIssue => {
  assert.equal(issues.length, 1, issues.map((issue) => issue.message).join(' | '));
  return issues[0];
};
const withLine = (contract: MeaningContract, line: MeaningContractLine, value: string): MeaningContract => ({ ...contract, [line]: value });

const ERP = { system: 'ace-erp', tool: 'account_balance' };
const NEW_ERP = { system: 'erpnext', tool: 'get_balance' };

async function main() {
  await suite.test('a block against itself raises nothing, and a block against an empty one is all new or all removed', () => {
    for (const block of [blockOf([]), minimalDictionary, accountFixtureDictionary, golden]) {
      assert.deepEqual(checkContractContinuity(block, block), []);
      assert.deepEqual(checkContractContinuity(blockOf([]), block), [], 'every binding is new');
      assert.deepEqual(checkContractContinuity(block, blockOf([])), [], 'every binding is removed');
    }
  });

  await suite.test('equal: a fact re-bound to another system, another tool or both, with the same five lines, passes', () => {
    for (const next of [{ system: 'erpnext', tool: 'account_balance' }, { system: 'ace-erp', tool: 'get_balance' }, NEW_ERP]) {
      assert.deepEqual(check([bind(ERP)], [bind(next)]), [], `${next.system}.${next.tool}`);
    }
  });

  await suite.test('different: a re-bind whose contract differs on any one of the five lines is refused, and the message says which line', () => {
    const edits: Array<[MeaningContractLine, string, string]> = [
      ['unit', 'cents', 'unit was "currency amount", now "cents"'],
      ['currency', 'NZD', 'currency was "from_record", now "NZD"'],
      ['tax', 'excludes_tax', 'tax was "unknown", now "excludes_tax"'],
      ['asOf', 'source_updated', 'asOf was "retrieved", now "source_updated"'],
      ['counts', 'unpaid invoices only', 'counts was "unknown", now "unpaid invoices only"'],
    ];
    assert.deepEqual(edits.map(([line]) => line), [...MEANING_CONTRACT_LINES], 'every line is tried');
    for (const [line, value, words] of edits) {
      const issue = only(check([bind(ERP)], [bind({ ...NEW_ERP, contract: withLine(MONEY, line, value) })]));
      assert.equal(issue.code, 'contract_rebind_differs');
      assert.equal(issue.severity, 'error');
      assert.equal(issue.factOrLink, FACT);
      assert.equal(issue.path, 'bindings[0].contract');
      assert.deepEqual(issue.differences, [{ line, from: MONEY[line], to: value }]);
      assert.ok(issue.message.includes(words), issue.message);
      assert.ok(issue.message.includes(`${FACT} moved from ace-erp.account_balance to erpnext.get_balance`), issue.message);
    }
    const everything: MeaningContract = { unit: 'cents', currency: 'NZD', tax: 'includes_tax', asOf: 'source_updated', counts: 'paid invoices only' };
    assert.deepEqual(only(check([bind(ERP)], [bind({ ...NEW_ERP, contract: everything })])).differences.map((difference) => difference.line), [...MEANING_CONTRACT_LINES]);
  });

  await suite.test('signed: a contract change from the old lines to the new lines, with a name and a time, lets the re-bind through', () => {
    const to = withLine(MONEY, 'tax', 'excludes_tax');
    assert.deepEqual(check([bind(ERP)], [bind({ ...NEW_ERP, contract: to })], [signedChange(FACT, MONEY, to)]), []);
    assert.deepEqual(check([bind(ERP)], [bind({ ...NEW_ERP, contract: to })], [signedChange('Account.overdue', MONEY, to), signedChange(FACT, MONEY, to)]), [], 'among others');
    assert.deepEqual(check([bind(ERP)], [bind({ ...NEW_ERP, contract: to })]).map((issue) => issue.code), ['contract_rebind_differs'], 'the same re-bind without the change');
  });

  await suite.test('unsigned: a contract change with no name, or no real time, does not count, and agrees with the schema about it', () => {
    const to = withLine(MONEY, 'tax', 'excludes_tax');
    const good = signedChange(FACT, MONEY, to);
    assert.equal(isSignedChange(good), true);
    assert.equal(ContractChangeSchema.safeParse(good).success, true);
    const unsigned: Array<[string, Record<string, unknown>]> = [
      ['an empty name', { approvedBy: '' }],
      ['a blank name', { approvedBy: '   ' }],
      ['a name on two lines', { approvedBy: 'Test\nApprover' }],
      ['no name', { approvedBy: undefined }],
      ['no time', { approvedAt: undefined }],
      ['a blank time', { approvedAt: '' }],
      ['a time that is not a time', { approvedAt: 'yesterday' }],
      ['a time with no zone', { approvedAt: '2026-10-29T09:30:00' }],
      ['a day that does not exist', { approvedAt: '2026-02-30T09:30:00Z' }],
      ['a time that is a number', { approvedAt: 1793266200000 }],
    ];
    for (const [label, edit] of unsigned) {
      const change = { ...good, ...edit } as unknown as ContractChange;
      assert.equal(isSignedChange(change), false, label);
      assert.equal(ContractChangeSchema.safeParse(change).success, false, `the schema refuses it too: ${label}`);
      const issue = only(check([bind(ERP)], [bind({ ...NEW_ERP, contract: to })], [change]));
      assert.equal(issue.code, 'contract_rebind_unsigned', label);
      assert.equal(issue.severity, 'error');
      assert.equal(issue.path, 'bindings[0].contract');
      assert.ok(issue.message.includes('not signed') && issue.message.includes('a person and a time'), issue.message);
    }
    assert.deepEqual(check([bind(ERP)], [bind({ ...NEW_ERP, contract: to })], [{ ...good, approvedBy: '' }, good]), [], 'a signed one beside an unsigned one is enough');
  });

  await suite.test('a contract change that records another fact, other old lines or other new lines does not cover the re-bind', () => {
    const to = withLine(MONEY, 'tax', 'excludes_tax');
    const next = [bind({ ...NEW_ERP, contract: to })];
    const elsewhere = only(check([bind(ERP)], next, [signedChange('Account.overdue', MONEY, to)]));
    assert.equal(elsewhere.code, 'contract_rebind_differs');
    assert.ok(!elsewhere.message.includes('is recorded for'), 'no change is recorded for this fact, so no hint');
    const wrong: Array<[string, ContractChange]> = [
      ['other old lines', signedChange(FACT, withLine(MONEY, 'unit', 'cents'), to)],
      ['other new lines', signedChange(FACT, MONEY, withLine(to, 'counts', 'unpaid invoices only'))],
      ['the new lines written as the old', signedChange(FACT, to, MONEY)],
      ['no difference at all', signedChange(FACT, MONEY, MONEY)],
    ];
    for (const [label, change] of wrong) {
      const issue = only(check([bind(ERP)], next, [change]));
      assert.equal(issue.code, 'contract_rebind_differs', label);
      assert.ok(issue.message.includes(`A contract change is recorded for ${FACT}, but its old and new lines are not these.`), issue.message);
    }
    const before = blockOf([bind(ERP)], [signedChange(FACT, MONEY, to)]);
    assert.deepEqual(checkContractContinuity(before, blockOf(next, [])).map((issue) => issue.code), ['contract_rebind_differs'], 'a change held only by the previous release does not count');
  });

  await suite.test('unknown to known and known to unknown both count as differences; unknown to unknown does not', () => {
    const known: Array<[MeaningContractLine, string]> = [['unit', 'each'], ['currency', 'NZD'], ['tax', 'includes_tax'], ['counts', 'all invoices']];
    for (const [line, value] of known) {
      const unknown = withLine(MONEY, line, 'unknown');
      const settled = withLine(MONEY, line, value);
      const forward = only(check([bind({ ...ERP, contract: unknown })], [bind({ ...NEW_ERP, contract: settled })]));
      assert.deepEqual(forward.differences, [{ line, from: 'unknown', to: value }], `${line}: unknown to known`);
      const back = only(check([bind({ ...ERP, contract: settled })], [bind({ ...NEW_ERP, contract: unknown })]));
      assert.deepEqual(back.differences, [{ line, from: value, to: 'unknown' }], `${line}: known to unknown`);
      assert.deepEqual(check([bind({ ...ERP, contract: unknown })], [bind({ ...NEW_ERP, contract: unknown })]), [], `${line}: unknown to unknown`);
      assert.deepEqual(check([bind({ ...ERP, contract: settled })], [bind({ ...NEW_ERP, contract: settled })]), [], `${line}: known to the same known`);
    }
    const notApplicable = only(check([bind({ ...ERP, contract: withLine(MONEY, 'tax', 'not_applicable') })], [bind({ ...NEW_ERP, contract: withLine(MONEY, 'tax', 'unknown') })]));
    assert.deepEqual(notApplicable.differences, [{ line: 'tax', from: 'not_applicable', to: 'unknown' }], 'not applicable is not unknown');
    assert.deepEqual(check([bind({ ...ERP, contract: withLine(MONEY, 'counts', 'Unknown') })], [bind({ ...NEW_ERP, contract: withLine(MONEY, 'counts', ' unknown ') })]), [], 'the word, in any capitals');
    const flip = [signedChange(FACT, withLine(MONEY, 'tax', 'includes_tax'), MONEY)];
    assert.deepEqual(check([bind({ ...ERP, contract: withLine(MONEY, 'tax', 'includes_tax') })], [bind(NEW_ERP)], flip), [], 'known to unknown passes when signed');
  });

  await suite.test('the same system and tool with other lines is not a re-bind: settling an unknown in place passes', () => {
    const settled = { ...MONEY, tax: 'excludes_tax', counts: 'unpaid invoices only' } as const;
    assert.deepEqual(check([bind(ERP)], [bind({ ...ERP, contract: settled })]), []);
    const other = bind({ ...ERP, contract: settled });
    other.args = { accountId: { from: 'key', kind: 'other_number' } };
    other.select = 'record.other';
    assert.deepEqual(check([bind(ERP)], [other]), [], 'other arguments or another path on the same tool are not a re-bind either');
  });

  await suite.test('a new fact, a new binding, a removed binding and a fact bound for the first time are not re-binds', () => {
    const unknownEverywhere = withLine(withLine(MONEY, 'unit', 'unknown'), 'currency', 'unknown');
    assert.deepEqual(check([bind(ERP)], [bind(ERP), bind({ ...NEW_ERP, target: 'Account.overdue', contract: unknownEverywhere })]), [], 'a new fact');
    assert.deepEqual(check([bind(ERP)], [bind(ERP), bind({ ...NEW_ERP, authority: 'cross_check', contract: unknownEverywhere })]), [], 'a cross check added');
    assert.deepEqual(check([bind(ERP)], [bind(ERP), bind({ ...NEW_ERP, contract: unknownEverywhere })]), [], 'a second source added while the first stays');
    assert.deepEqual(check([bind(ERP), bind({ ...NEW_ERP, authority: 'cross_check' })], [bind(ERP)]), [], 'a cross check removed');
    assert.deepEqual(check([bind(ERP)], []), [], 'the only binding removed');
    assert.deepEqual(check([bind({ ...ERP, target: 'Account.overdue' })], [bind({ ...ERP, target: 'Account.overdue' }), bind({ ...NEW_ERP, contract: unknownEverywhere })]), [], 'a fact bound for the first time');
    assert.deepEqual(check([bind(ERP)], [bind({ ...ERP, authority: 'cross_check' })]), [], 'the same system and tool becoming a cross check, with nothing taking its place');
    assert.deepEqual(check([bind({ ...ERP, target: 'Account.overdue' })], [bind({ ...NEW_ERP, target: 'Account.owing', contract: unknownEverywhere })]), [], 'a fact renamed is a new fact and a removed one');
  });

  await suite.test('a link is checked like a fact', () => {
    const orders = (system: string, tool: string, counts: string) => bind({ target: 'Account.orders', link: true, system, tool, contract: { ...COUNT, counts } });
    const issue = only(check([orders('commercetools', 'order_history', 'newest first')], [orders('erpnext', 'list_orders', 'oldest first')]));
    assert.equal(issue.factOrLink, 'Account.orders');
    assert.deepEqual(issue.differences, [{ line: 'counts', from: 'newest first', to: 'oldest first' }]);
    assert.deepEqual(check([orders('commercetools', 'order_history', 'newest first')], [orders('erpnext', 'list_orders', 'newest first')]), [], 'the same lines');
    const to = { ...COUNT, counts: 'oldest first' };
    assert.deepEqual(check([orders('commercetools', 'order_history', 'newest first')], [orders('erpnext', 'list_orders', 'oldest first')], [signedChange('Account.orders', { ...COUNT, counts: 'newest first' }, to)]), [], 'signed by link name');
  });

  await suite.test('each authority is its own place: the source of truth moving, a swap, a cross check moving and a fallback moving are all re-binds', () => {
    const swapped = check(
      [bind(ERP), bind({ ...NEW_ERP, authority: 'cross_check' })],
      [bind({ ...NEW_ERP, contract: withLine(MONEY, 'tax', 'excludes_tax') }), bind({ ...ERP, authority: 'cross_check' })],
    );
    assert.deepEqual(swapped.map((issue) => [issue.code, issue.path]), [['contract_rebind_differs', 'bindings[0].contract']], 'the source of truth moved from the first system to the second');
    const moved = (authority: Binding['authority'], contract: MeaningContract) => check(
      [bind(ERP), bind({ ...NEW_ERP, authority })],
      [bind(ERP), bind({ system: 'third-system', tool: 'get_figure', authority, contract })],
    );
    for (const authority of ['cross_check', 'fallback'] as const) {
      const issue = only(moved(authority, withLine(MONEY, 'unit', 'cents')));
      assert.equal(issue.path, 'bindings[1].contract', authority);
      assert.deepEqual(issue.differences, [{ line: 'unit', from: 'currency amount', to: 'cents' }], authority);
      assert.deepEqual(moved(authority, MONEY), [], `${authority} moved with the same lines`);
    }
  });

  await suite.test('a fact with several bindings: a moved one is found, an added or dropped sibling is not, and a move may match any old contract', () => {
    const open = { ...COUNT, counts: 'orders in state Open' };
    const confirmed = { ...COUNT, counts: 'orders in state Confirmed' };
    const onTool = (suffix: string, contract: MeaningContract, system = 'commercetools', tool = 'order_history') => bind({ target: 'Account.openOrderCount', system, tool, contract, suffix });
    const before = [onTool('#open', open), onTool('#confirmed', confirmed)];
    assert.deepEqual(check(before, [onTool('#open', open), onTool('#confirmed', confirmed, 'erpnext', 'list_orders')]), [], 'one of two moved, same lines');
    const issue = only(check(before, [onTool('#open', open), onTool('#confirmed', { ...confirmed, counts: 'confirmed orders and returns' }, 'erpnext', 'list_orders')]));
    assert.equal(issue.path, 'bindings[1].contract');
    assert.deepEqual(check(before, [onTool('#open', open, 'erpnext', 'list_orders'), onTool('#confirmed', confirmed, 'erpnext', 'list_orders')]), [], 'both moved, each keeping its lines');
    const both = check(before, [onTool('#open', open, 'erpnext', 'list_orders'), onTool('#confirmed', { ...confirmed, counts: 'confirmed orders and returns' }, 'erpnext', 'list_orders')]);
    assert.deepEqual(both.map((entry) => entry.path), ['bindings[1].contract'], 'only the one that no old contract matches');
    assert.deepEqual(check([onTool('#open', open)], before), [], 'a sibling added');
    assert.deepEqual(check(before, [onTool('#open', open)]), [], 'a sibling dropped');
    assert.deepEqual(check(before, [onTool('#confirmed', confirmed)]), [], 'the other sibling dropped');
  });

  await suite.test('a conversion is a written rule: a signed change between two known units, currencies or tax bases without one warns, never silently', () => {
    const each = withLine(MONEY, 'unit', 'each');
    const cases: Array<[string, MeaningContract, MeaningContract, string]> = [
      ['unit', each, withLine(MONEY, 'unit', 'pallet'), 'unit'],
      ['currency', withLine(MONEY, 'currency', 'NZD'), withLine(MONEY, 'currency', 'AUD'), 'currency'],
      ['tax basis', withLine(MONEY, 'tax', 'includes_tax'), withLine(MONEY, 'tax', 'excludes_tax'), 'tax'],
      ['several lines', each, { ...withLine(MONEY, 'unit', 'pallet'), tax: 'excludes_tax' }, 'unit'],
    ];
    for (const [label, from, to, word] of cases) {
      const warned = only(check([bind({ ...ERP, contract: from })], [bind({ ...NEW_ERP, contract: to })], [signedChange(FACT, from, to)]));
      assert.equal(warned.code, 'contract_rebind_no_conversion_rule', label);
      assert.equal(warned.severity, 'warning', label);
      assert.equal(warned.path, 'contractChanges[0]', label);
      assert.ok(warned.message.includes(word) && warned.message.includes('no conversion rule'), warned.message);
      const written = signedChange(FACT, from, to, { conversionRule: 'Divide by the pack size the product states.' });
      assert.deepEqual(check([bind({ ...ERP, contract: from })], [bind({ ...NEW_ERP, contract: to })], [written]), [], `${label}: with the rule written`);
      const blank = { ...written, conversionRule: '   ' };
      assert.deepEqual(check([bind({ ...ERP, contract: from })], [bind({ ...NEW_ERP, contract: to })], [blank]).map((issue) => issue.code), ['contract_rebind_no_conversion_rule'], `${label}: a blank rule is no rule`);
    }
    const quiet: Array<[string, MeaningContract, MeaningContract]> = [
      ['unknown to known', MONEY, withLine(MONEY, 'tax', 'excludes_tax')],
      ['known to unknown', withLine(MONEY, 'tax', 'includes_tax'), MONEY],
      ['not applicable to known', withLine(MONEY, 'unit', 'not_applicable'), withLine(MONEY, 'unit', 'each')],
      ['what it counts', withLine(MONEY, 'counts', 'paid invoices'), withLine(MONEY, 'counts', 'unpaid invoices')],
      ['the as-of time', MONEY, withLine(MONEY, 'asOf', 'source_updated')],
    ];
    for (const [label, from, to] of quiet) {
      assert.deepEqual(check([bind({ ...ERP, contract: from })], [bind({ ...NEW_ERP, contract: to })], [signedChange(FACT, from, to)]), [], label);
    }
    const open = { ...each, counts: 'orders in state Open' };
    const pallet = withLine(open, 'unit', 'pallet');
    const onTool = (suffix: string, system: string, tool: string, contract: MeaningContract) => bind({ system, tool, contract, suffix });
    const twice = check(
      [onTool('#a', 'ace-erp', 'one', open), onTool('#b', 'ace-erp', 'one', open)],
      [onTool('#a', 'erpnext', 'two', pallet), onTool('#b', 'erpnext', 'two', pallet)],
      [signedChange(FACT, open, pallet)],
    );
    assert.deepEqual(twice.map((issue) => issue.code), ['contract_rebind_no_conversion_rule'], 'two bindings moved by one change give one warning');
  });

  await suite.test('lines are compared by their words: spacing does not matter, capitals and the tax label do', () => {
    const spaced: MeaningContract = { ...COUNT, unit: ' orders ', counts: 'orders  in state\tOpen' };
    assert.deepEqual(check([bind({ ...ERP, contract: COUNT })], [bind({ ...NEW_ERP, contract: spaced })]), []);
    assert.equal(only(check([bind({ ...ERP, contract: COUNT })], [bind({ ...NEW_ERP, contract: { ...COUNT, unit: 'Orders' } })])).differences[0].line, 'unit');
    const gst: MeaningContract = { ...MONEY, tax: 'excludes_tax', taxLabel: 'GST' };
    assert.deepEqual(check([bind({ ...ERP, contract: gst })], [bind({ ...NEW_ERP, contract: { ...gst, taxLabel: ' GST ' } })]), []);
    assert.deepEqual(only(check([bind({ ...ERP, contract: gst })], [bind({ ...NEW_ERP, contract: { ...gst, taxLabel: 'VAT' } })])).differences, [{ line: 'tax', from: 'excludes_tax (GST)', to: 'excludes_tax (VAT)' }]);
    assert.deepEqual(only(check([bind({ ...ERP, contract: gst })], [bind({ ...NEW_ERP, contract: withLine(MONEY, 'tax', 'excludes_tax') })])).differences, [{ line: 'tax', from: 'excludes_tax (GST)', to: 'excludes_tax' }], 'a dropped label');
    assert.deepEqual(contractDifferences(gst, gst), []);
    assert.deepEqual(contractDifferences(MONEY, { ...MONEY, taxLabel: '   ' }), [], 'a blank label is no label');
  });

  await suite.test('the answer follows the next block, names each binding by its place, is the same every time and leaves both blocks as they were', () => {
    const moved = withLine(MONEY, 'counts', 'unpaid invoices only');
    const previous = blockOf([bind({ ...ERP, target: 'Account.balance' }), bind({ ...ERP, target: 'Account.overdue' }), bind({ ...ERP, target: 'Account.terms' })]);
    const next = blockOf(
      [bind({ ...NEW_ERP, target: 'Account.terms', contract: moved }), bind({ ...NEW_ERP, target: 'Account.balance', contract: moved }), bind({ ...ERP, target: 'Account.overdue' })],
      [signedChange('Account.overdue', MONEY, moved)],
    );
    const snapshot = [clone(previous), clone(next)];
    const issues = checkContractContinuity(previous, next);
    assert.deepEqual(issues.map((issue) => [issue.factOrLink, issue.path]), [['Account.terms', 'bindings[0].contract'], ['Account.balance', 'bindings[1].contract']]);
    assert.deepEqual(checkContractContinuity(previous, next), issues);
    assert.deepEqual([previous, next], snapshot, 'the inputs are untouched');
    assert.deepEqual(errorsOf(issues), issues);
  });

  await suite.test('one ERP call fills six facts, and moving that call is checked once for each of them', () => {
    const moveCall = (block: JaxOntologyRelease, edit: (binding: Binding) => void = () => undefined): JaxOntologyRelease => {
      const next = clone(block);
      for (const binding of next.bindings) {
        if (binding.tool !== 'account_balance') continue;
        binding.system = 'erpnext';
        binding.tool = 'get_balance';
        binding.bindingId = binding.bindingId.replace('ace-erp.account_balance', 'erpnext.get_balance');
        edit(binding);
      }
      return next;
    };
    assert.deepEqual(checkContractContinuity(accountFixtureDictionary, moveCall(accountFixtureDictionary)), [], 'the same lines, six facts');
    const decided = (binding: Binding) => { if (binding.contract.tax === 'unknown') binding.contract.tax = 'excludes_tax'; };
    const refused = checkContractContinuity(accountFixtureDictionary, moveCall(accountFixtureDictionary, decided));
    assert.deepEqual(refused.map((issue) => issue.factOrLink), ['Account.creditLimit', 'Account.balance', 'Account.overdue']);
    assert.ok(refused.every((issue) => issue.code === 'contract_rebind_differs'));
    const money = (fact: string) => signedChange(fact, MONEY, withLine(MONEY, 'tax', 'excludes_tax'), { conversionRule: 'None: the amount is used as the source gives it.' });
    const signedAll = { ...moveCall(accountFixtureDictionary, decided), contractChanges: ['Account.creditLimit', 'Account.balance', 'Account.overdue'].map(money) };
    assert.deepEqual(checkContractContinuity(accountFixtureDictionary, signedAll), []);
    const signedTwo = { ...signedAll, contractChanges: signedAll.contractChanges.slice(0, 2) };
    assert.deepEqual(checkContractContinuity(accountFixtureDictionary, signedTwo).map((issue) => issue.factOrLink), ['Account.overdue']);
  });

  await suite.test('the golden block: its credit limit moved to another system passes with its own signed change, and is refused without it', () => {
    const moved = clone(golden);
    const credit = moved.bindings.find((binding) => binding.bindingId === 'Account.creditLimit@ace-erp.account_balance')!;
    credit.system = 'erpnext';
    credit.tool = 'get_credit';
    credit.bindingId = 'Account.creditLimit@erpnext.get_credit';
    credit.contract.tax = 'excludes_tax';
    assert.equal(golden.contractChanges.length, 1);
    assert.deepEqual(checkContractContinuity(golden, moved), [], 'the change in the golden block records exactly this move');
    const issue = only(checkContractContinuity(golden, { ...moved, contractChanges: [] }));
    assert.equal(issue.factOrLink, 'Account.creditLimit');
    assert.deepEqual(issue.differences, [{ line: 'tax', from: 'unknown', to: 'excludes_tax' }]);
    assert.deepEqual(checkContractContinuity(golden, { ...moved, contractChanges: [{ ...golden.contractChanges[0], approvedBy: ' ' }] }).map((entry) => entry.code), ['contract_rebind_unsigned']);
  });

  await suite.test('the first-pass list for the Account fixture: every binding with an unknown line, sorted, with the lines named', () => {
    const entries = listUnknownContracts(accountFixtureDictionary);
    assert.deepEqual(entries.map((entry) => [entry.factOrLink, entry.bindingId, entry.system, entry.tool, entry.authority, entry.unknownLines]), [
      ['Account.balance', 'Account.balance@ace-erp.account_balance', 'ace-erp', 'account_balance', 'source_of_truth', ['tax', 'counts']],
      ['Account.creditLimit', 'Account.creditLimit@ace-erp.account_balance', 'ace-erp', 'account_balance', 'source_of_truth', ['tax', 'counts']],
      ['Account.creditLimit', 'Account.creditLimit@commercetools.get_account', 'commercetools', 'get_account', 'cross_check', ['tax', 'counts']],
      ['Account.deals', 'Account.deals@salesforce.list_opportunities', 'salesforce', 'list_opportunities', 'source_of_truth', ['currency', 'tax']],
      ['Account.orders', 'Account.orders@commercetools.order_history', 'commercetools', 'order_history', 'source_of_truth', ['tax']],
      ['Account.overdue', 'Account.overdue@ace-erp.account_balance', 'ace-erp', 'account_balance', 'source_of_truth', ['tax', 'counts']],
    ]);
    const deals = accountFixtureDictionary.bindings.find((binding) => binding.bindingId === 'Account.deals@salesforce.list_opportunities')!;
    assert.deepEqual(entries[3].contract, deals.contract, 'the whole contract is there beside the unknown lines');
    assert.notEqual(entries[3].contract, deals.contract, 'and it is a copy');
    const before = clone(accountFixtureDictionary);
    entries[3].contract.tax = 'includes_tax';
    entries[3].unknownLines.pop();
    assert.deepEqual(accountFixtureDictionary, before, 'changing an entry changes nothing in the block');
  });

  await suite.test('the first-pass list: nothing for a settled block, the golden block listed, the same order however the block is ordered, and a settled line leaves the list', () => {
    assert.deepEqual(listUnknownContracts(minimalDictionary), []);
    assert.deepEqual(listUnknownContracts({ bindings: [] }), []);
    assert.deepEqual(listUnknownContracts(golden).map((entry) => entry.bindingId), [
      'Account.balance@ace-erp.account_balance', 'Account.creditLimit@ace-erp.account_balance', 'Account.creditLimit@commercetools.get_account',
      'Account.orders@commercetools.order_history', 'Account.overdue@ace-erp.account_balance',
    ]);
    const reversed = { bindings: [...accountFixtureDictionary.bindings].reverse() };
    assert.deepEqual(listUnknownContracts(reversed), listUnknownContracts(accountFixtureDictionary));
    const settled = clone(accountFixtureDictionary);
    settled.bindings.find((binding) => binding.bindingId === 'Account.balance@ace-erp.account_balance')!.contract.tax = 'excludes_tax';
    assert.deepEqual(listUnknownContracts(settled)[0].unknownLines, ['counts']);
    settled.bindings.find((binding) => binding.bindingId === 'Account.balance@ace-erp.account_balance')!.contract.counts = 'unpaid invoices only';
    assert.deepEqual(listUnknownContracts(settled).map((entry) => entry.bindingId).slice(0, 1), ['Account.creditLimit@ace-erp.account_balance'], 'the settled fact is off the list');
  });

  await suite.test('the first-pass list: source of truth, then cross check, then fallback, then binding id; the word unknown only, in any capitals; the as-of line never', () => {
    const settled: MeaningContract = { unit: 'each', currency: 'NZD', tax: 'excludes_tax', asOf: 'retrieved', counts: 'all of them' };
    const listed = (spec: Spec, contract: MeaningContract) => bind({ target: 'Account.score', contract, ...spec });
    const bindings = [
      listed({ system: 'b-system', tool: 'one', authority: 'fallback' }, withLine(settled, 'unit', 'unknown')),
      listed({ system: 'b-system', tool: 'two', authority: 'cross_check' }, withLine(settled, 'unit', 'unknown')),
      listed({ system: 'z-system', tool: 'one' }, withLine(settled, 'unit', 'unknown')),
      listed({ system: 'a-system', tool: 'one' }, withLine(settled, 'unit', 'unknown')),
      listed({ system: 'y-system', tool: 'one' }, settled),
      bind({ target: 'Account.also', system: 'a-system', tool: 'one', contract: withLine(settled, 'counts', 'unknown') }),
    ];
    assert.deepEqual(listUnknownContracts({ bindings }).map((entry) => entry.bindingId), [
      'Account.also@a-system.one', 'Account.score@a-system.one', 'Account.score@z-system.one', 'Account.score@b-system.two', 'Account.score@b-system.one',
    ]);
    const lines = (contract: MeaningContract) => listUnknownContracts({ bindings: [bind({ ...ERP, contract })] }).flatMap((entry) => entry.unknownLines);
    assert.deepEqual(lines({ unit: 'unknown', currency: 'unknown', tax: 'unknown', asOf: 'retrieved', counts: 'unknown' }), ['unit', 'currency', 'tax', 'counts']);
    assert.deepEqual(lines({ ...settled, unit: ' Unknown ', counts: 'UNKNOWN' }), ['unit', 'counts']);
    assert.deepEqual(lines({ ...settled, unit: 'unknown unit', counts: 'not_applicable', currency: 'from_record' }), [], 'a phrase with the word in it is not the word');
    assert.deepEqual(lines({ ...settled, asOf: 'unknown' as MeaningContract['asOf'] }), [], 'the as-of line is not looked at');
  });

  await suite.test('the module exports the two checks and nothing else, and imports only the model and its own files', () => {
    assert.deepEqual(Object.keys(contracts).filter((name) => name !== '__esModule').sort(), ['checkContractContinuity', 'listUnknownContracts']);
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts')).sort();
    assert.deepEqual(files, ['compare.ts', 'index.ts', 'unknowns.ts']);
    for (const file of files) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      const imported = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const from of imported) assert.ok(['../model', './compare', './unknowns'].includes(from), `${file} imports ${from}`);
      assert.ok(!/process\.env|node:|https?:\/\/|\.\.\/\.\.\//.test(source), `${file} holds no environment read, node module, address or path`);
    }
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
