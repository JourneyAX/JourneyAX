import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { CONNECTOR_STATES, ConnectorsSchema, connectorRowApplies, connectorToolState, type ConnectorState, type ConnectorsExtension } from '@journeyax/business-pack';
import { ADMIN_GROUP } from '@journeyax/shared-types';
import * as jaxIq from '@journeyax/jax-iq';
import { allowedFacts, allowedSignals, checkRulesAgainstTable, compileRules, effectiveToolState, signalFactReads, stricterToolState, toolStatesFor } from '../src/rules';
import type { RulePerson, RulesBlock } from '../src/rules';
import { clausesAdmit } from '../src/rules/compile';
import { TOOL_STATE_STRICTNESS } from '../src/rules/effective';
import type { Binding, FactDef, JaxOntologyRelease, PermissionRule, SignalRule, WhoClause } from '../src/model';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';

/**
 * The permission rules on things. They sit on top of the per-tool table and can only take access away: a fact is allowed when its bound
 * tool is open for the person AND some `see` rule allows it; a signal when every fact it reads is allowed; a write tool is capped by a
 * `change` rule. Every tool and rule in this file is made up for the test. The golden block and the connector fixture are the frozen
 * sample the model package keeps.
 */
const suite = createSuite('jax-iq: the permission rules on things');

const SRC = path.resolve(__dirname, '../src/rules');
const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));

const clone = <T>(value: T): T => structuredClone(value);
const staff = (...groups: string[]): RulePerson => ({ audience: 'staff', groups });
const sorted = (...lists: string[][]): string[] => lists.flat().sort();

/** What a person gets from a block and a table, sorted so the tables below read as sets. */
function seen(who: RulePerson, block: RulesBlock = golden, connectors: ConnectorsExtension | null = connectorsFixture) {
  const rules = compileRules(block);
  const states = toolStatesFor(connectors ?? undefined, rules.caps, who);
  return { facts: [...allowedFacts(block, who, states, rules)].sort(), signals: [...allowedSignals(block, who, states, rules)].sort() };
}

/** The golden table with more rows. A later row can only make a tool stricter for the people it names. */
const withRows = (rows: Array<{ connectorId: string; tool: string; groups: string[]; state: ConnectorState }>): ConnectorsExtension =>
  ConnectorsSchema.parse({ ...connectorsFixture, policy: [...connectorsFixture.policy, ...rows.map((row) => ({ ...row, audience: 'staff' }))] });

// A tiny world for the cases the golden block does not reach.

const contract = { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'not_applicable' } as const;
const factDef = (fact: string): FactDef => ({ fact, thing: fact.split('.')[0], label: fact, meaning: 'A test fact.', type: 'text', freshnessKind: 'reference', allowStale: true });
const onFact = (fact: string, system: string, tool: string, authority: Binding['authority'] = 'source_of_truth'): Binding => ({
  bindingId: `${fact}@${system}.${tool}`, target: { kind: 'fact', fact }, system, tool, args: {}, select: 'record.value',
  presence: 'optional', authority, freshnessKind: 'reference', contract,
});
const onLink = (link: string, system: string, tool: string): Binding => ({
  bindingId: `${link}@${system}.${tool}`, target: { kind: 'link', link }, system, tool, args: {}, select: 'records',
  presence: 'optional', authority: 'source_of_truth', freshnessKind: 'reference', contract,
});
const seeRule = (ruleId: string, thing: string, facts: string[] | undefined, ...who: WhoClause[]): PermissionRule => ({ ruleId, mode: 'see', target: { thing, ...(facts ? { facts } : {}) }, who });
const changeRule = (ruleId: string, writeTools: Array<[string, string]>, ...who: WhoClause[]): PermissionRule => ({
  ruleId, mode: 'change', target: { thing: 'Widget' }, who, writeTools: writeTools.map(([connectorId, tool]) => ({ connectorId, tool })),
});
const clause = (...groups: string[]): WhoClause => ({ audience: 'staff', groups });
const block = (parts: Omit<Partial<RulesBlock>, 'facts'> & { facts: string[] }): RulesBlock => ({
  facts: parts.facts.map(factDef), links: parts.links ?? [], bindings: parts.bindings ?? [], permissionRules: parts.permissionRules ?? [], signalRules: parts.signalRules ?? [],
});
const link = (name: string, to: string): RulesBlock['links'][number] => ({ link: name, from: name.split('.')[0], to, meaning: 'A test link.', cardinality: '1:n' });
const signalOf = (signalId: string, inputs: SignalRule['inputs'], formula: SignalRule['formula']): SignalRule => ({
  signalId, name: signalId, meaning: 'A test signal.', appliesTo: 'Widget', severity: 'watch', inputs, formula, settings: [], status: 'draft', wording: ['A test sentence.'],
});

const connector = (connectorId: string, ...tools: Array<string | [string, 'write']>) => ({
  connectorId, displayName: connectorId, description: 'A test connector.', owner: 'Test owner', sample: true,
  tools: tools.map((tool) => (typeof tool === 'string' ? { name: tool } : { name: tool[0], sideEffect: tool[1] })),
});
const row = (connectorId: string, tool: string, groups: string[], state: ConnectorState, audience: 'staff' | 'shopper' = 'staff') => ({ connectorId, tool, audience, groups: audience === 'staff' ? groups : [], state });
const tableOf = (connectors: ReturnType<typeof connector>[], policy: ReturnType<typeof row>[]): ConnectorsExtension => ConnectorsSchema.parse({ askVia: 'card', announceSample: false, connectors, policy });

async function main() {
  await suite.test('compiling spells a rule out as facts: named facts, or every fact of the thing; a fact no rule names has an empty list', () => {
    const compiled = compileRules(golden);
    assert.deepEqual(compiled.see.map((rule) => rule.ruleId), ['pr-account-credit-see', 'pr-account-basic-see', 'pr-ticket-see'], 'only the see rules, in the block order');
    assert.deepEqual(compiled.see[0].facts, ['Account.balance', 'Account.creditLimit', 'Account.overdue', 'Account.lastPaid']);
    assert.deepEqual(compiled.see[2].facts, ['Ticket.subject', 'Ticket.priority', 'Ticket.status', 'Ticket.created', 'Ticket.dueBy', 'Ticket.tags'], 'no facts named: the whole thing');
    assert.equal(compiled.seeByFact.size, golden.facts.length, 'every fact of the block is in the map');
    for (const fact of ['Account.onCreditHold', 'Account.discountRate', 'Order.state']) assert.deepEqual(compiled.seeByFact.get(fact), [], `${fact} has no rule: new facts start closed`);
    assert.deepEqual(compiled.seeByFact.get('Account.balance')?.map((rule) => rule.ruleId), ['pr-account-credit-see']);
  });

  await suite.test('a see rule covers only the facts of its own thing that the block defines', () => {
    const world = block({
      facts: ['Widget.a', 'Widget.b', 'Gadget.c'],
      permissionRules: [seeRule('r-mixed', 'Widget', ['Widget.a', 'Gadget.c', 'Widget.missing'], clause()), seeRule('r-none', 'Widget', [], clause()), seeRule('r-other-thing', 'Nothing', undefined, clause())],
    });
    const compiled = compileRules(world);
    assert.deepEqual(compiled.see.map((rule) => [rule.ruleId, rule.facts]), [['r-mixed', ['Widget.a']], ['r-none', []], ['r-other-thing', []]]);
    assert.deepEqual(seen(staff('any'), world, null).facts, ['Widget.a'], 'a fact of another thing and an unknown fact grant nothing; the empty list and the other thing\'s rule grant nothing either');
  });

  await suite.test('a change rule becomes one cap of blocked per named write tool, and nothing else; other modes compile to nothing', () => {
    const compiled = compileRules(golden);
    assert.deepEqual(compiled.caps, [{ ruleId: 'pr-ticket-change', connectorId: 'zendesk', tool: 'add_ticket_note', cap: 'blocked', allowedWho: [clause('customer-service')] }]);
    const many = compileRules(block({
      facts: ['Widget.a'],
      permissionRules: [
        changeRule('r-two', [['sys-a', 'write_a'], ['sys-a', 'write_a'], ['sys-b', 'write_b']], clause('boss')),
        { ...seeRule('r-see', 'Widget', undefined, clause()), writeTools: [{ connectorId: 'sys-a', tool: 'write_a' }] },
        { ...changeRule('r-hold', [['sys-a', 'write_c']], clause()), mode: 'hold' as unknown as 'change' },
        { ...changeRule('r-bare', [], clause()), writeTools: undefined },
      ],
    }));
    assert.deepEqual(many.caps.map((cap) => [cap.ruleId, cap.connectorId, cap.tool]), [['r-two', 'sys-a', 'write_a'], ['r-two', 'sys-b', 'write_b']], 'a tool named twice is capped once');
    assert.ok(many.caps.every((cap) => cap.cap === 'blocked'), 'the only state a compiled rule can produce is blocked');
    assert.deepEqual(many.see.map((rule) => rule.ruleId), ['r-see'], 'a see rule ignores any write tool it carries');
  });

  await suite.test('compiling reads the block and changes nothing in it', () => {
    const before = clone(golden);
    compileRules(golden);
    allowedFacts(golden, staff('finance'), () => 'allow');
    checkRulesAgainstTable(golden, connectorsFixture);
    assert.deepEqual(golden, before);
  });

  await suite.test('the local order of strictness is the business-pack order: same states, same positions, and the stricter of two rows wins as it does there', () => {
    assert.deepEqual(Object.keys(TOOL_STATE_STRICTNESS), [...CONNECTOR_STATES], 'the same three states in the same order');
    assert.deepEqual(Object.values(TOOL_STATE_STRICTNESS), CONNECTOR_STATES.map((_, index) => index), 'each at its position');
    for (const a of CONNECTOR_STATES) {
      for (const b of CONNECTOR_STATES) {
        const table = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', ['one'], a), row('sys-a', 'read_a', ['two'], b)]);
        const original = connectorToolState(table, 'sys-a', 'read_a', { audience: 'staff', groups: ['one', 'two'] }).state;
        assert.equal(stricterToolState(a, b), original, `${a} and ${b}`);
        assert.equal(stricterToolState(b, a), original, `${b} and ${a}`);
      }
    }
  });

  await suite.test('the stricter of two states: blocked absorbs, allow gives way, and the order does not matter', () => {
    for (const a of CONNECTOR_STATES) {
      assert.equal(stricterToolState(a, a), a);
      assert.equal(stricterToolState(a, 'blocked'), 'blocked');
      assert.equal(stricterToolState('allow', a), a);
      for (const b of CONNECTOR_STATES) {
        assert.equal(stricterToolState(a, b), stricterToolState(b, a));
        for (const c of CONNECTOR_STATES) assert.equal(stricterToolState(stricterToolState(a, b), c), stricterToolState(a, stricterToolState(b, c)));
      }
    }
    assert.equal(stricterToolState('allow', 'ask'), 'ask');
    assert.equal(stricterToolState('ask', 'blocked'), 'blocked');
  });

  await suite.test('a clause admits a person exactly as a staff row of the table does, for every kind of person and clause', () => {
    const people: RulePerson[] = [staff(), staff('a'), staff('b'), staff('a', 'b'), staff('c'), { audience: 'shopper', groups: [] }, { audience: 'shopper', groups: ['a'] }, { audience: 'robot', groups: ['a'] }];
    const clauses = [clause(), clause('a'), clause('b'), clause('a', 'b'), clause('c'), clause('a', 'c')];
    for (const who of people) {
      for (const one of clauses) {
        const table = connectorRowApplies({ audience: 'staff', groups: one.groups }, { audience: who.audience === 'staff' ? 'staff' : 'shopper', groups: who.audience === 'staff' ? [...who.groups] : [] });
        assert.equal(clausesAdmit([one], who), table, `${JSON.stringify(who)} against ${JSON.stringify(one.groups)}`);
      }
    }
    assert.equal(clausesAdmit([], staff('a')), false, 'an empty allow-list lets nobody through');
    assert.equal(clausesAdmit([clause('c'), clause('a')], staff('a')), true, 'any one clause is enough');
  });

  await suite.test('with no caps the effective state is exactly the table\'s, for every tool, listed or not, and every kind of person', () => {
    const people: RulePerson[] = [staff(), staff('finance'), staff('sales', 'finance'), staff('branch'), staff(ADMIN_GROUP), { audience: 'shopper', groups: [] }, { audience: 'robot', groups: ['finance'] }];
    const tools = [...connectorsFixture.connectors.flatMap((entry) => entry.tools.map((tool) => [entry.connectorId, tool.name])), ['ace-erp', 'new_tool'], ['no-such-connector', 'find_account']];
    for (const who of people) {
      for (const [connectorId, tool] of tools) {
        const table = connectorToolState(connectorsFixture, connectorId, tool, { audience: who.audience === 'staff' ? 'staff' : 'shopper', groups: who.audience === 'staff' ? [...who.groups] : [] });
        assert.deepEqual(effectiveToolState(connectorsFixture, [], connectorId, tool, who), { ...table, capRuleIds: [] }, `${connectorId}.${tool} for ${JSON.stringify(who)}`);
      }
    }
  });

  await suite.test('a change rule caps the tool it names for everyone its clauses do not admit, and says which rule did', () => {
    const table = tableOf([connector('desk', 'read_ticket', ['add_note', 'write'])], [
      row('desk', 'read_ticket', [], 'allow'), row('desk', 'add_note', ['service'], 'ask'), row('desk', 'add_note', ['sales'], 'ask'), row('desk', 'add_note', ['leadership'], 'ask'), row('desk', 'add_note', ['finance'], 'allow'),
    ]);
    const { caps } = compileRules(block({ facts: ['Widget.a'], permissionRules: [changeRule('only-service-writes', [['desk', 'add_note']], clause('service'))] }));
    const at = (who: RulePerson, tool = 'add_note') => effectiveToolState(table, caps, 'desk', tool, who);
    assert.deepEqual(at(staff('service')), { state: 'ask', known: true, via: 'tool', capRuleIds: [] }, 'admitted: the table\'s state');
    for (const team of ['sales', 'leadership', 'finance']) assert.deepEqual(at(staff(team)), { state: 'blocked', known: true, via: 'tool', capRuleIds: ['only-service-writes'] }, `${team}: leadership changes nothing`);
    assert.equal(at(staff('service', 'leadership')).state, 'ask', 'a person in an admitted team and another is admitted');
    assert.equal(at(staff()).state, 'blocked');
    assert.deepEqual(at(staff('finance'), 'read_ticket'), { state: 'allow', known: true, via: 'tool', capRuleIds: [] }, 'a tool no rule names is the table\'s');
    assert.equal(at({ audience: 'shopper', groups: [] }).state, 'blocked', 'a shopper matches no clause');
  });

  await suite.test('a rule can never open a tool the table closed, even for the people it admits', () => {
    const table = tableOf([connector('desk', ['add_note', 'write'], ['drop_note', 'write'])], [row('desk', 'add_note', ['service'], 'blocked'), row('desk', 'drop_note', ['service'], 'ask')]);
    const { caps } = compileRules(block({ facts: ['Widget.a'], permissionRules: [changeRule('r', [['desk', 'add_note'], ['desk', 'drop_note']], clause('service'), clause())] }));
    assert.equal(effectiveToolState(table, caps, 'desk', 'add_note', staff('service')).state, 'blocked', 'the table says blocked, the rule admits');
    assert.equal(effectiveToolState(table, caps, 'desk', 'drop_note', staff('service')).state, 'ask', 'the rule does not turn ask into allow either');
    assert.equal(effectiveToolState(table, caps, 'desk', 'add_note', staff('nobody')).state, 'blocked', 'no row for the team');
    assert.deepEqual(effectiveToolState(table, caps, 'desk', 'no_such_tool', staff('service')), { state: 'blocked', known: false, via: 'none', capRuleIds: [] }, 'a tool the pack does not list stays unknown and blocked');
    assert.deepEqual(effectiveToolState(undefined, caps, 'desk', 'add_note', staff('service')), { state: 'blocked', known: false, via: 'none', capRuleIds: [] }, 'a pack without the table');
  });

  await suite.test('two change rules on one tool both have to admit the person; a cap on a tool the pack does not list changes nothing', () => {
    const table = tableOf([connector('desk', ['add_note', 'write'])], [row('desk', 'add_note', [], 'allow')]);
    const { caps } = compileRules(block({
      facts: ['Widget.a'],
      permissionRules: [changeRule('r-one', [['desk', 'add_note'], ['desk', 'ghost']], clause('service', 'sales')), changeRule('r-two', [['desk', 'add_note']], clause('sales', 'finance'))],
    }));
    const at = (...groups: string[]) => effectiveToolState(table, caps, 'desk', 'add_note', staff(...groups));
    assert.deepEqual(at('sales'), { state: 'allow', known: true, via: 'tool', capRuleIds: [] }, 'admitted by both');
    assert.deepEqual(at('service'), { state: 'blocked', known: true, via: 'tool', capRuleIds: ['r-two'] });
    assert.deepEqual(at('finance'), { state: 'blocked', known: true, via: 'tool', capRuleIds: ['r-one'] });
    assert.deepEqual(at('other').capRuleIds, ['r-one', 'r-two']);
    assert.equal(at('service', 'finance').state, 'allow', 'two teams: each rule admits one of them');
    assert.equal(at('service', 'sales').state, 'allow');
    assert.equal(effectiveToolState(table, caps, 'desk', 'ghost', staff('other')).state, 'blocked');
  });

  await suite.test('for JAX IQ the state lookup is blocked for anyone who is not staff, whatever the table or the groups say', () => {
    const open = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', [], 'allow', 'shopper')]);
    assert.equal(effectiveToolState(open, [], 'sys-a', 'read_a', { audience: 'shopper', groups: [] }).state, 'allow', 'the table alone gives a shopper the tool');
    for (const audience of ['shopper', 'customer', 'company_member', 'robot', '', 'STAFF', 'Staff']) {
      assert.equal(toolStatesFor(open, [], { audience, groups: ['finance'] })('sys-a', 'read_a'), 'blocked', JSON.stringify(audience));
    }
    assert.equal(toolStatesFor(open, [], staff('finance'))('sys-a', 'read_a'), 'allow');
    assert.equal(toolStatesFor(open, [], undefined as unknown as RulePerson)('sys-a', 'read_a'), 'blocked', 'a missing person is not staff');
  });

  const BASIC = ['Account.homeBranchCode', 'Account.name', 'Account.openOrderCount', 'Account.status', 'Account.terms', 'Account.tier'];
  const CREDIT = ['Account.balance', 'Account.creditLimit', 'Account.lastPaid', 'Account.overdue'];
  const TICKET = ['Ticket.created', 'Ticket.dueBy', 'Ticket.priority', 'Ticket.status', 'Ticket.subject', 'Ticket.tags'];
  const ALL_SIGNALS = ['sig-account-attention', 'sig-credit-use', 'sig-old-urgent-ticket', 'sig-ticket-pileup'];
  const TICKET_SIGNALS = ['sig-old-urgent-ticket', 'sig-ticket-pileup'];

  const TRUTH: Array<[team: string, who: RulePerson, facts: string[], signals: string[]]> = [
    ['finance', staff('finance'), sorted(BASIC, CREDIT), ['sig-credit-use']],
    ['sales', staff('sales'), sorted(BASIC, TICKET), TICKET_SIGNALS],
    ['sales-managers', staff('sales-managers'), sorted(BASIC, CREDIT, TICKET), ALL_SIGNALS],
    ['leadership', staff('leadership'), sorted(BASIC, CREDIT, TICKET), ALL_SIGNALS],
    ['customer-service', staff('customer-service'), sorted(BASIC, TICKET), TICKET_SIGNALS],
    ['branch (no row in the table)', staff('branch'), [], []],
    ['marketing (no row in the table)', staff('marketing'), [], []],
    ['the reserved administrators group (no row in the table)', staff(ADMIN_GROUP), [], []],
    ['staff in no team', staff(), [], []],
    ['a shopper', { audience: 'shopper', groups: [] }, [], []],
  ];

  await suite.test('the truth table: every team against every fact and signal of the golden block, with the fixture table', () => {
    for (const [team, who, facts, signals] of TRUTH) assert.deepEqual(seen(who), { facts, signals }, team);
    assert.ok(!TRUTH.some(([, , facts]) => facts.includes('Account.onCreditHold') || facts.includes('Account.discountRate') || facts.includes('Order.state')), 'a fact no rule names is closed for every team');
  });

  await suite.test('the truth table for the Account example of the specification (a different block and the same table)', () => {
    const allTen = accountFixtureDictionary.facts.map((fact) => fact.fact).sort();
    const basicSix = ['Account.name', 'Account.openOrderCount', 'Account.owner', 'Account.status', 'Account.terms', 'Account.tier'];
    assert.deepEqual(seen(staff('finance'), accountFixtureDictionary), { facts: allTen, signals: ['sig-credit-use'] });
    assert.deepEqual(seen(staff('leadership'), accountFixtureDictionary), { facts: allTen, signals: ['sig-credit-use'] });
    assert.deepEqual(seen(staff('sales'), accountFixtureDictionary), { facts: basicSix, signals: [] });
    assert.deepEqual(seen(staff('customer-service'), accountFixtureDictionary), { facts: basicSix, signals: [] });
    assert.deepEqual(seen(staff('branch'), accountFixtureDictionary), { facts: [], signals: [] });
  });

  await suite.test('default deny: no rule, no access, even where every tool is open; a rule that names another thing or no one grants nothing', () => {
    const everything = () => 'allow' as const;
    const bindings = [onFact('Widget.a', 'sys-a', 'read_a')];
    const bare = block({ facts: ['Widget.a', 'Widget.b'], bindings });
    assert.deepEqual([...allowedFacts(bare, staff('any'), everything)], [], 'no rules at all');
    const elsewhere = block({ facts: ['Widget.a', 'Widget.b', 'Gadget.c'], bindings, permissionRules: [seeRule('r-gadget', 'Gadget', undefined, clause())] });
    assert.deepEqual([...allowedFacts(elsewhere, staff('any'), everything)], ['Gadget.c'], 'a rule for the Gadget thing opens nothing of the Widget thing');
    const nobody = block({ facts: ['Widget.a', 'Widget.b'], bindings, permissionRules: [seeRule('r-nobody', 'Widget', undefined)] });
    assert.deepEqual([...allowedFacts(nobody, staff('any'), everything)], [], 'an empty allow-list');
    const named = block({ facts: ['Widget.a', 'Widget.b'], bindings, permissionRules: [seeRule('r-a', 'Widget', ['Widget.a'], clause())] });
    assert.deepEqual([...allowedFacts(named, staff('any'), everything)], ['Widget.a'], 'a fact the rule does not name stays closed: new facts start closed');
  });

  await suite.test('a rule never opens a tool the table closed; a closed or ask tool takes the fact away from the people it would reach', () => {
    const world = block({ facts: ['Widget.a'], bindings: [onFact('Widget.a', 'sys-a', 'read_a')], permissionRules: [seeRule('r', 'Widget', undefined, clause())] });
    const table = (state: ConnectorState) => tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', ['team'], state)]);
    const facts = (state: ConnectorState, who: RulePerson) => seen(who, world, table(state)).facts;
    assert.deepEqual(facts('allow', staff('team')), ['Widget.a']);
    assert.deepEqual(facts('ask', staff('team')), [], 'ask counts as blocked: JAX IQ cannot wait for a person\'s yes');
    assert.deepEqual(facts('blocked', staff('team')), []);
    assert.deepEqual(facts('allow', staff('other')), [], 'a team the table has no row for');
    assert.deepEqual(seen(staff('team'), world, null).facts, [], 'a pack without the table');
    assert.deepEqual(seen(staff('team'), world, tableOf([connector('sys-a', 'read_b')], [row('sys-a', '*', [], 'allow')])).facts, [], 'a tool the pack does not list');
    assert.deepEqual(seen(staff('team'), world, ConnectorsSchema.parse({ connectors: [{ ...connector('sys-a', 'read_a'), enabled: false }], policy: [row('sys-a', 'read_a', [], 'allow')] })).facts, [], 'a connector switched off');
  });

  await suite.test('a fact with several bindings is open when one of them is on an allowed tool; with none, the rules alone decide', () => {
    const world = block({
      facts: ['Widget.a', 'Widget.b', 'Widget.c'],
      bindings: [onFact('Widget.a', 'sys-a', 'read_a'), onFact('Widget.a', 'sys-b', 'read_b', 'fallback'), onFact('Widget.b', 'sys-a', 'read_a'), onFact('Widget.b', 'sys-b', 'read_b', 'cross_check')],
      permissionRules: [seeRule('r', 'Widget', undefined, clause())],
    });
    const connectors = [connector('sys-a', 'read_a'), connector('sys-b', 'read_b')];
    assert.deepEqual(seen(staff('x'), world, tableOf(connectors, [row('sys-a', 'read_a', ['x'], 'allow'), row('sys-b', 'read_b', ['x'], 'allow')])).facts, ['Widget.a', 'Widget.b', 'Widget.c']);
    assert.deepEqual(seen(staff('x'), world, tableOf(connectors, [row('sys-a', 'read_a', ['x'], 'blocked'), row('sys-b', 'read_b', ['x'], 'allow')])).facts, ['Widget.a', 'Widget.b', 'Widget.c'], 'the other binding is open');
    assert.deepEqual(seen(staff('x'), world, tableOf(connectors, [row('sys-a', 'read_a', ['x'], 'ask'), row('sys-b', 'read_b', ['x'], 'blocked')])).facts, ['Widget.c'], 'both closed: only the fact with no binding is left');
  });

  await suite.test('rules add up: some one rule that admits the person is enough, an empty clause means all staff, and a clause needs only one of its groups', () => {
    const everything = () => 'allow' as const;
    const world = block({
      facts: ['Widget.a', 'Widget.b', 'Widget.c', 'Widget.d'],
      permissionRules: [
        seeRule('r-ab', 'Widget', ['Widget.a', 'Widget.b'], clause('one')),
        seeRule('r-bc', 'Widget', ['Widget.b', 'Widget.c'], clause('two', 'three')),
        seeRule('r-d', 'Widget', ['Widget.d'], clause('four'), clause()),
      ],
    });
    const facts = (...groups: string[]) => [...allowedFacts(world, staff(...groups), everything)].sort();
    assert.deepEqual(facts('one'), ['Widget.a', 'Widget.b', 'Widget.d']);
    assert.deepEqual(facts('three'), ['Widget.b', 'Widget.c', 'Widget.d']);
    assert.deepEqual(facts('one', 'two'), ['Widget.a', 'Widget.b', 'Widget.c', 'Widget.d'], 'the union of what each team reaches');
    assert.deepEqual(facts(), ['Widget.d'], 'the empty clause admits staff in no team');
  });

  await suite.test('a shopper is always denied: facts, signals and tools, whatever groups it claims and whatever the rules and the table say', () => {
    const wide = block({
      facts: ['Widget.a'], links: [link('Widget.parts', 'Part')], bindings: [onFact('Widget.a', 'sys-a', 'read_a')],
      permissionRules: [seeRule('r', 'Widget', undefined, clause())],
      signalRules: [signalOf('s', [{ name: 'a', fact: 'Widget.a' }], { op: 'positive', of: { input: 'a' } })],
    });
    const open = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', [], 'allow', 'shopper'), row('sys-a', 'read_a', [], 'allow')]);
    assert.deepEqual(seen(staff('x'), wide, open), { facts: ['Widget.a'], signals: ['s'] }, 'staff get both');
    for (const audience of ['shopper', 'customer', 'company_member', 'everyone', 'robot', '', 'Staff', ' staff']) {
      for (const groups of [[], ['finance'], [ADMIN_GROUP]]) {
        const who = { audience, groups };
        assert.deepEqual(seen(who, wide, open), { facts: [], signals: [] }, JSON.stringify(who));
      }
    }
    assert.deepEqual(seen(undefined as unknown as RulePerson, wide, open), { facts: [], signals: [] }, 'a missing person is not staff');
  });

  await suite.test('a clause that is not a staff clause admits nobody, even if a stored release carries one', () => {
    const forged = [{ audience: 'shopper', groups: [] }, { audience: 'company_member', roles: ['buyer'] }, { audience: 'staff' }, { groups: [] }, { audience: 'everyone' }] as unknown as WhoClause[];
    for (const one of forged) {
      assert.equal(clausesAdmit([one], staff('finance')), false, JSON.stringify(one));
      assert.equal(clausesAdmit([one], { audience: 'shopper', groups: [] }), false, JSON.stringify(one));
    }
    assert.equal(clausesAdmit(forged, staff('finance')), false);
  });

  await suite.test('the reserved administrators group is an ordinary group here: rules and rows must name it, and it opens nothing by itself', () => {
    assert.equal(ADMIN_GROUP, 'administrators');
    const world = (who: WhoClause[]) => block({ facts: ['Widget.a'], bindings: [onFact('Widget.a', 'sys-a', 'read_a')], permissionRules: [seeRule('r', 'Widget', undefined, ...who)] });
    const named = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', ['finance', ADMIN_GROUP], 'allow')]);
    const unnamed = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', ['finance'], 'allow')]);
    const admin = staff(ADMIN_GROUP);
    assert.deepEqual(seen(admin, world([clause('finance')]), named).facts, [], 'the rule names finance only');
    assert.deepEqual(seen(admin, world([clause('finance', ADMIN_GROUP)]), named).facts, ['Widget.a'], 'the rule names administrators');
    assert.deepEqual(seen(admin, world([clause()]), named).facts, ['Widget.a'], 'an empty clause means all staff, the admin among them');
    assert.deepEqual(seen(admin, world([clause('finance', ADMIN_GROUP)]), unnamed).facts, [], 'the table has no row for administrators');
    assert.deepEqual(seen({ audience: 'shopper', groups: [ADMIN_GROUP] }, world([clause()]), named).facts, [], 'a shopper that claims the group is still a shopper');
    const { caps } = compileRules(block({ facts: ['Widget.a'], permissionRules: [changeRule('r-w', [['sys-a', 'write_a']], clause('finance'))] }));
    const writes = tableOf([connector('sys-a', ['write_a', 'write'])], [row('sys-a', 'write_a', [ADMIN_GROUP, 'finance'], 'ask')]);
    assert.equal(effectiveToolState(writes, caps, 'sys-a', 'write_a', admin).state, 'blocked', 'the admin is not admitted by a change rule that names finance only');
    assert.equal(effectiveToolState(writes, caps, 'sys-a', 'write_a', staff('finance', ADMIN_GROUP)).state, 'ask');
  });

  await suite.test('a person in two teams gets the union of what the table gives: today\'s behaviour, written down', () => {
    // The sales row is blocked, the finance row allows, and no row names `ops`: a team no row names adds nothing, so the union is of the rows that apply.
    const table = tableOf([connector('sys-a', 'read_a', 'read_b', 'read_c')], [
      row('sys-a', 'read_a', ['finance'], 'allow'),
      row('sys-a', 'read_b', ['sales'], 'blocked'), row('sys-a', 'read_b', ['finance'], 'allow'),
      row('sys-a', 'read_c', ['sales'], 'ask'), row('sys-a', 'read_c', ['finance'], 'allow'),
    ]);
    const at = (tool: string, ...groups: string[]) => effectiveToolState(table, [], 'sys-a', tool, staff(...groups)).state;
    assert.equal(at('read_a', 'sales'), 'blocked', 'sales alone: no row');
    assert.equal(at('read_a', 'sales', 'finance'), 'allow', 'sales and finance: MORE than sales alone, because only the finance row applies');
    assert.equal(at('read_b', 'sales', 'finance'), 'blocked', 'both teams have a row: the stricter wins');
    assert.equal(at('read_c', 'sales', 'finance'), 'ask');
    assert.equal(at('read_a', 'ops', 'finance'), 'allow');
    const world = block({
      facts: ['Widget.a', 'Widget.b'], bindings: [onFact('Widget.a', 'sys-a', 'read_a'), onFact('Widget.b', 'sys-a', 'read_b')],
      permissionRules: [seeRule('r-a', 'Widget', ['Widget.a'], clause('sales')), seeRule('r-b', 'Widget', ['Widget.b'], clause('finance'))],
    });
    assert.deepEqual(seen(staff('sales'), world, table).facts, [], 'sales alone: the rule is theirs, the tool is not');
    assert.deepEqual(seen(staff('finance'), world, table).facts, ['Widget.b'], 'finance alone: the tool is theirs, the rule for Widget.a is not');
    assert.deepEqual(seen(staff('sales', 'finance'), world, table).facts, ['Widget.a'], 'both teams: Widget.a opens through the finance row and the sales rule; Widget.b stays shut by the stricter row');
  });

  await suite.test('what a signal reads: its inputs and the item facts inside its list operands, and the links its lists go over', () => {
    const reads = Object.fromEntries(golden.signalRules.map((signal) => [signal.signalId, signalFactReads(signal)]));
    assert.deepEqual(reads['sig-credit-use'], { facts: ['Account.balance', 'Account.creditLimit'], links: [], unresolved: [] });
    assert.deepEqual(reads['sig-account-attention'], { facts: ['Account.overdue', 'Ticket.dueBy'], links: ['Account.tickets'], unresolved: [] });
    assert.deepEqual(reads['sig-ticket-pileup'], { facts: ['Ticket.status'], links: ['Account.tickets'], unresolved: [] }, 'settings and words are not facts');
    assert.deepEqual(reads['sig-old-urgent-ticket'], { facts: ['Ticket.priority', 'Ticket.status', 'Ticket.created'], links: ['Account.tickets'], unresolved: [] }, 'an item fact inside a nested formula');
    const odd = signalFactReads(signalOf('s', [{ name: 'a', fact: 'Widget.a' }], { op: 'and', of: [{ op: 'positive', of: { input: 'ghost' } }, { op: 'is_past', of: { input: 'Gadget.when' } }] }));
    assert.deepEqual(odd, { facts: ['Widget.a', 'Gadget.when'], links: [], unresolved: ['ghost'] }, 'an input that is neither declared nor a fact cannot be traced');
    const strange = signalFactReads({ inputs: [], formula: { op: 'sum', of: [] } as unknown as SignalRule['formula'] });
    assert.deepEqual(strange.unresolved, ['(an operator this version does not know)']);
  });

  await suite.test('a signal is allowed only when every fact it reads is allowed: one denied input, or one denied item fact, and it is absent', () => {
    assert.deepEqual(seen(staff('finance')).signals, ['sig-credit-use'], 'finance reads the credit facts and may not see tickets');
    assert.ok(!seen(staff('finance')).signals.includes('sig-account-attention'), 'overdue is allowed, Ticket.dueBy is not');
    assert.ok(!seen(staff('sales')).signals.includes('sig-account-attention'), 'Ticket.dueBy is allowed, overdue is not');
    assert.ok(seen(staff('sales-managers')).signals.includes('sig-account-attention'), 'both allowed');
    assert.deepEqual(seen(staff('customer-service')).signals, TICKET_SIGNALS, 'no credit signal for a team that may not see the credit facts');
  });

  await suite.test('what a signal shows can only be made of allowed facts: for every team, every fact an allowed signal reads is an allowed fact', () => {
    for (const [team, who] of TRUTH) {
      const { facts, signals } = seen(who);
      for (const signal of golden.signalRules) {
        const reads = signalFactReads(signal);
        const denied = reads.facts.filter((fact) => !facts.includes(fact));
        if (signals.includes(signal.signalId)) assert.deepEqual(denied, [], `${team}: ${signal.signalId} lists no denied fact`);
        else assert.ok(denied.length > 0, `${team}: ${signal.signalId} is absent because it reads a fact that is denied`);
      }
    }
  });

  await suite.test('a signal over a list needs the link\'s tool to be open as well; ask counts as blocked; an unknown link or input hides the signal', () => {
    const closed = withRows([{ connectorId: 'zendesk', tool: 'find_tickets', groups: ['sales-managers'], state: 'blocked' }]);
    assert.deepEqual(seen(staff('sales-managers'), golden, closed), {
      facts: sorted(BASIC, CREDIT, TICKET), signals: ['sig-credit-use'],
    }, 'the ticket facts are still open through get_ticket, but the list of tickets cannot be read');
    const asking = withRows([{ connectorId: 'zendesk', tool: 'find_tickets', groups: ['leadership'], state: 'ask' }]);
    assert.deepEqual(seen(staff('leadership'), golden, asking).signals, ['sig-credit-use']);
    assert.deepEqual(seen(staff('sales-managers'), golden, withRows([{ connectorId: 'zendesk', tool: 'find_tickets', groups: ['finance'], state: 'blocked' }])).signals, ALL_SIGNALS, 'a row for another team changes nothing');

    const over = (name: string) => signalOf('s', [], { op: 'any', of: { over: name, where: { op: 'positive', of: { input: 'Widget.size' } } } });
    const world = (links: RulesBlock['links'], bindings: Binding[]) => block({
      facts: ['Widget.size'], links, bindings: [onFact('Widget.size', 'sys-a', 'read_a'), ...bindings],
      permissionRules: [seeRule('r', 'Widget', undefined, clause())], signalRules: [over('Gadget.parts')],
    });
    const table = tableOf([connector('sys-a', 'read_a', 'list_parts')], [row('sys-a', 'read_a', [], 'allow'), row('sys-a', 'list_parts', [], 'allow')]);
    assert.deepEqual(seen(staff('x'), world([link('Gadget.parts', 'Widget')], [onLink('Gadget.parts', 'sys-a', 'list_parts')]), table).signals, ['s']);
    assert.deepEqual(seen(staff('x'), world([link('Gadget.parts', 'Widget')], []), table).signals, ['s'], 'a link with no binding has no source; the signal is not hidden for that');
    assert.deepEqual(seen(staff('x'), world([], []), table).signals, [], 'a link the block does not define');
    const undeclared = block({ facts: ['Widget.size'], bindings: [onFact('Widget.size', 'sys-a', 'read_a')], permissionRules: [seeRule('r', 'Widget', undefined, clause())], signalRules: [signalOf('s', [], { op: 'positive', of: { input: 'ghost' } })] });
    assert.deepEqual(seen(staff('x'), undeclared, table).signals, [], 'an input nobody declared');
    const unknownFact = block({ facts: ['Widget.size'], bindings: [], permissionRules: [seeRule('r', 'Widget', undefined, clause())], signalRules: [signalOf('s', [{ name: 'a', fact: 'Widget.other' }], { op: 'positive', of: { input: 'a' } })] });
    assert.deepEqual(seen(staff('x'), unknownFact, table).signals, [], 'a fact the block does not define');
  });

  await suite.test('a signal that reads nothing is not hidden by the rules, and a block with no signals gives none', () => {
    const settingsOnly = block({ facts: ['Widget.a'], signalRules: [signalOf('s', [], { op: 'compare', cmp: 'gte', left: { setting: 'level.one' }, right: { setting: 'level.two' } })] });
    assert.deepEqual(seen(staff('x'), settingsOnly, null).signals, ['s']);
    assert.deepEqual(seen(staff('x'), settingsOnly, null).facts, []);
    assert.deepEqual(seen({ audience: 'shopper', groups: [] }, settingsOnly, null).signals, [], 'still not for a shopper');
    assert.deepEqual(seen(staff('x'), block({ facts: [] }), null), { facts: [], signals: [] });
  });

  await suite.test('the answers are the same whether the rules are compiled once and passed in or compiled by each call, and the calls change nothing', () => {
    const who = staff('sales-managers');
    const rules = compileRules(golden);
    const states = toolStatesFor(connectorsFixture, rules.caps, who);
    assert.deepEqual(allowedFacts(golden, who, states), allowedFacts(golden, who, states, rules));
    assert.deepEqual(allowedSignals(golden, who, states), allowedSignals(golden, who, states, rules));
    const first = [...allowedFacts(golden, who, states)];
    assert.deepEqual([...allowedFacts(golden, who, states)], first, 'the same answer twice');
    assert.ok(allowedFacts(golden, who, states) instanceof Set && allowedSignals(golden, who, states) instanceof Set);
  });

  const key = (gap: { ruleId: string; connectorId: string; tool: string; team: string | null }) => `${gap.ruleId} | ${gap.connectorId}.${gap.tool} | ${gap.team ?? '(no team)'}`;

  await suite.test('R15 on the golden block and the fixture table lists exactly where the table is looser than a rule, in a stable order', () => {
    const gaps = checkRulesAgainstTable(golden, connectorsFixture);
    assert.deepEqual(gaps.map(key), [
      'pr-account-credit-see | ace-erp.account_balance | customer-service',
      'pr-account-credit-see | ace-erp.account_balance | sales',
      'pr-account-credit-see | commercetools.get_account | customer-service',
      'pr-account-credit-see | commercetools.get_account | sales',
      'pr-ticket-see | zendesk.find_tickets | finance',
      'pr-ticket-see | zendesk.get_ticket | finance',
    ]);
    assert.ok(gaps.every((gap) => gap.mode === 'see' && gap.tableState === 'allow'));
    assert.deepEqual(gaps[0].exposes, ['Account.balance', 'Account.creditLimit', 'Account.overdue', 'Account.lastPaid']);
    assert.deepEqual(gaps[2].exposes, ['Account.creditLimit'], 'the cross-check tool returns the credit limit as well');
    assert.deepEqual(gaps[4].exposes, ['Ticket.subject', 'Ticket.priority', 'Ticket.status', 'Ticket.created', 'Ticket.dueBy', 'Ticket.tags'], 'a tool that lists the tickets returns all of them');
    assert.deepEqual(checkRulesAgainstTable(golden, connectorsFixture), gaps, 'the same list the second time');
    const customerService = gaps[0];
    assert.match(customerService.message, /pr-account-credit-see/);
    assert.match(customerService.message, /customer-service/);
    assert.match(customerService.message, /ace-erp\.account_balance/);
    assert.match(customerService.message, /Account\.balance, Account\.creditLimit, Account\.overdue, Account\.lastPaid/);
    assert.match(gaps[2].message, /returns it\./, 'one fact: "it"');
    assert.ok(gaps.every((gap) => !/[\r\n]/.test(gap.message) && /Close the table row or accept it\.$/.test(gap.message)), 'one plain line each');
  });

  await suite.test('R15 closes: shutting every listed (tool, team) in the table leaves no gap, and a team the table already shuts is never listed', () => {
    const gaps = checkRulesAgainstTable(golden, connectorsFixture);
    const closed = withRows(gaps.map((gap) => ({ connectorId: gap.connectorId, tool: gap.tool, groups: gap.team === null ? [] : [gap.team], state: 'blocked' as const })));
    assert.deepEqual(checkRulesAgainstTable(golden, closed), []);
    assert.deepEqual(checkRulesAgainstTable(golden, undefined), [], 'a pack without the table closes everything');
    for (const gap of gaps) assert.ok(!['branch', 'marketing', ADMIN_GROUP].includes(gap.team ?? ''), 'teams with no row are not looser');
  });

  await suite.test('R15 reports an ask row with its state, a change rule against a write tool, and staff in no team through a row for all staff', () => {
    const table = tableOf([connector('desk', 'read_ticket', ['add_note', 'write'], ['drop_note', 'write'])], [
      row('desk', 'read_ticket', [], 'allow'),
      row('desk', 'add_note', ['service'], 'ask'), row('desk', 'add_note', ['sales'], 'ask'), row('desk', 'add_note', ['leadership'], 'blocked'),
      row('desk', '*', [], 'ask'),
    ]);
    const world = block({
      facts: ['Widget.a', 'Widget.b'],
      bindings: [onFact('Widget.a', 'desk', 'read_ticket'), onFact('Widget.b', 'desk', 'read_ticket')],
      permissionRules: [
        seeRule('r-a', 'Widget', ['Widget.a'], clause('service')),
        changeRule('r-writes', [['desk', 'add_note'], ['desk', 'drop_note']], clause('service')),
      ],
    });
    const gaps = checkRulesAgainstTable(world, table);
    assert.deepEqual(gaps.map((gap) => [key(gap), gap.mode, gap.tableState]), [
      ['r-a | desk.read_ticket | (no team)', 'see', 'allow'],
      ['r-a | desk.read_ticket | leadership', 'see', 'allow'],
      ['r-a | desk.read_ticket | sales', 'see', 'allow'],
      ['r-writes | desk.add_note | (no team)', 'change', 'ask'],
      ['r-writes | desk.add_note | sales', 'change', 'ask'],
      ['r-writes | desk.drop_note | (no team)', 'change', 'ask'],
      ['r-writes | desk.drop_note | leadership', 'change', 'ask'],
      ['r-writes | desk.drop_note | sales', 'change', 'ask'],
    ], 'leadership is blocked on add_note by its own row; drop_note falls to the row for all staff, which asks');
    assert.deepEqual(gaps[0].exposes, ['Widget.a'], 'only the fact the rule names, not Widget.b');
    assert.deepEqual(gaps[3].exposes, [], 'a change rule exposes no fact');
    assert.match(gaps[0].message, /staff who are in no team/);
    assert.match(gaps[3].message, /ask first/);
    assert.match(gaps[3].message, /does not let staff who are in no team use desk\.add_note/);
  });

  await suite.test('R15 compares a team only with the rules that name the fact: a second rule that admits the team, and a fact no rule names, are no gap', () => {
    const table = tableOf([connector('sys-a', 'read_a')], [row('sys-a', 'read_a', ['one', 'two'], 'allow')]);
    const world = (...rules: PermissionRule[]) => block({ facts: ['Widget.a', 'Widget.b'], bindings: [onFact('Widget.a', 'sys-a', 'read_a'), onFact('Widget.b', 'sys-a', 'read_a')], permissionRules: rules });
    assert.deepEqual(checkRulesAgainstTable(world(seeRule('r-one', 'Widget', ['Widget.a'], clause('one')), seeRule('r-two', 'Widget', ['Widget.a'], clause('two'))), table), [], 'each team is admitted by one of the two rules');
    assert.deepEqual(checkRulesAgainstTable(world(), table), [], 'no rules: there is nothing to compare');
    assert.deepEqual(checkRulesAgainstTable(world(seeRule('r-one', 'Widget', ['Widget.a'], clause('one'))), table).map(key), ['r-one | sys-a.read_a | two'], 'Widget.b has no rule, so it is not listed');
    const viaLink = checkRulesAgainstTable(block({
      facts: ['Widget.a', 'Gadget.g'], links: [{ link: 'Widget.gadgets', from: 'Widget', to: 'Gadget', meaning: 'A test link.', cardinality: '1:n' }],
      bindings: [onLink('Widget.gadgets', 'sys-a', 'read_a')], permissionRules: [seeRule('r-gadget', 'Gadget', undefined, clause('one'))],
    }), table);
    assert.deepEqual(viaLink.map(key), ['r-gadget | sys-a.read_a | two'], 'a tool that lists Gadgets returns the facts of a Gadget');
  });

  await suite.test('the module is exported from the package, with the names the plan gives and no more', () => {
    const names = ['allowedFacts', 'allowedSignals', 'checkRulesAgainstTable', 'compileRules', 'effectiveToolState', 'signalFactReads', 'stricterToolState', 'toolStatesFor'];
    for (const name of names) assert.equal(typeof (jaxIq as unknown as Record<string, unknown>)[name], 'function', name);
    const index = readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    const exported = [...index.matchAll(/^export \{([^}]*)\} from/gm)].flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean)).sort();
    assert.deepEqual(exported, names, 'the value exports of the module index');
  });

  await suite.test('the module imports only the model, the pack\'s connector table and itself; it reads no file, address, clock, random number or environment', () => {
    const files = readdirSync(SRC).sort();
    assert.deepEqual(files, ['check.ts', 'compile.ts', 'effective.ts', 'index.ts']);
    const allowedImports = new Set(['../model', '@journeyax/business-pack', './compile', './effective', './check']);
    for (const file of files) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      const imports = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      assert.deepEqual(imports.filter((name) => !allowedImports.has(name)), [], `${file} imports only what it may`);
      for (const banned of ['process.', 'Math.random', 'Date', 'require(', 'fetch(', 'localStorage', 'node:', '/Users/', 'http://', 'https://', 'localhost', 'console.']) {
        assert.ok(!source.includes(banned), `${file} has no ${banned}`);
      }
    }
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
