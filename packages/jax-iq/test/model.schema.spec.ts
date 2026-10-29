import './setup/no-world';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createSuite } from '@journeyax/test-support';
import * as jaxIq from '@journeyax/jax-iq';
import {
  ContractChangeSchema, DictionaryPartSchema, ENGINE_SETTINGS, FactDefSchema, FormulaSchema, JAX_ONTOLOGY_SCHEMA_VERSION, JaxOntologyReleaseSchema,
  MeaningContractSchema, PermissionRuleSchema, SettingDefSchema, SignalRuleSchema, ThingDefSchema,
} from '../src/model';
import type {
  Binding, ContractChange, DictionaryPart, FactDef, Formula, JaxOntologyRelease, LinkDef, MeaningContract, Operand, PermissionRule, SettingDef, SignalRule, StateMap, ThingDef,
} from '../src/model';
import { accountFixtureDictionary } from './fixtures/account.fixture.dictionary';
import { connectorsFixture } from './fixtures/connectors.fixture';
import { engineSettingsFixture, minimalDictionary } from './fixtures/minimal.dictionary';

/**
 * The model and its Zod twin. The block and the part files are the shape of a dictionary release, so the schema must refuse what the
 * engine would misread: unknown keys, a literal number in a formula, a rule that names a tool state, a customer clause, a signal switched
 * on by nobody, a contract change nobody signed. The golden block is a frozen sample of version 1.0.0; every later schema must read it.
 */
const suite = createSuite('jax-iq: the model, its Zod schema and the engine setting names');

const SRC = path.resolve(__dirname, '../src/model');
const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));
/** The hash of the golden block, keys sorted. It changes only if someone edits the frozen file. */
const GOLDEN_V1_HASH = 'cc51829c19c8918a1621b418a235befb46ae64bca6fdcc9e02d888d5020f861a';

// The types and the schema agree both ways. `tsc:jax-iq` fails here when they drift.
type Agree<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type TypesAgree = [
  Assert<Agree<z.infer<typeof JaxOntologyReleaseSchema>, JaxOntologyRelease>>,
  Assert<Agree<z.infer<typeof DictionaryPartSchema>, DictionaryPart>>,
  Assert<Agree<z.infer<typeof ThingDefSchema>, ThingDef>>,
  Assert<Agree<z.infer<typeof FactDefSchema>, FactDef>>,
  Assert<Agree<z.infer<typeof MeaningContractSchema>, MeaningContract>>,
  Assert<Agree<z.infer<typeof PermissionRuleSchema>, PermissionRule>>,
  Assert<Agree<z.infer<typeof SettingDefSchema>, SettingDef>>,
  Assert<Agree<z.infer<typeof SignalRuleSchema>, SignalRule>>,
  Assert<Agree<z.infer<typeof ContractChangeSchema>, ContractChange>>,
];

const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const text = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  return result.success ? '' : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' | ');
};
const accepts = (schema: z.ZodType, value: unknown, note = '') => assert.equal(schema.safeParse(value).success, true, `${note} ${text(schema, value)}`);
const refuses = (schema: z.ZodType, value: unknown, note = '') => assert.equal(schema.safeParse(value).success, false, `should be refused: ${note}`);
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const rule = (id: string): PermissionRule => clone(golden.permissionRules.find((candidate) => candidate.ruleId === id)!);
const signal = (id: string): SignalRule => clone(golden.signalRules.find((candidate) => candidate.signalId === id)!);
const binding = (id: string): Binding => clone(golden.bindings.find((candidate) => candidate.bindingId === id)!);
const contract: MeaningContract = { unit: 'orders', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'all of them' };

/** A signal around one formula, for the formula tests. */
const signalWith = (formula: Formula): SignalRule => ({ ...signal('sig-account-attention'), formula });
const ticketsWhere = (where: Formula) => ({ over: 'Account.tickets', where });

async function main() {
  await suite.test('the Account example of the specification, rebuilt as a fixture, parses and comes back unchanged', () => {
    accepts(JaxOntologyReleaseSchema, accountFixtureDictionary);
    assert.deepEqual(JaxOntologyReleaseSchema.parse(accountFixtureDictionary), accountFixtureDictionary, 'the schema adds, drops and rewrites nothing');
    assert.deepEqual(accountFixtureDictionary.signalRules.map((entry) => [entry.signalId, entry.status]), [['sig-credit-use', 'draft']]);
    assert.equal(accountFixtureDictionary.bindings.filter((entry) => entry.tool === 'account_balance').length, 6, 'one ERP call fills six facts');
  });

  await suite.test('a block built from the types parses and comes back unchanged: the minimal block, the Account block and a part', () => {
    assert.deepEqual(JaxOntologyReleaseSchema.parse(minimalDictionary), minimalDictionary);
    const part: DictionaryPart = {
      partId: 'settings', settings: clone(engineSettingsFixture),
      replaces: [{ thing: 'Delivery', with: 'Shipment' }], things: clone(golden.things), facts: clone(golden.facts), links: clone(golden.links),
      bindings: clone(golden.bindings), permissionRules: clone(golden.permissionRules), signalRules: clone(golden.signalRules), severities: ['watch'],
      stateMaps: clone(golden.stateMaps), contractChanges: clone(golden.contractChanges),
    };
    assert.deepEqual(DictionaryPartSchema.parse(part), part);
    const thing: ThingDef = clone(golden.things[0]);
    const link: LinkDef = clone(golden.links[0]);
    const stateMap: StateMap = clone(golden.stateMaps[0]);
    assert.deepEqual(ThingDefSchema.parse(thing), thing);
    assert.equal(link.link, 'Account.orders');
    assert.equal(stateMap.lossy, true);
    assert.equal(JAX_ONTOLOGY_SCHEMA_VERSION, '1.0.0');
  });

  await suite.test('the schema version must be exactly 1.0.0', () => {
    for (const version of ['1.0.1', '1.1.0', '2.0.0', '1.0', 1, null, undefined]) {
      refuses(JaxOntologyReleaseSchema, { ...clone(minimalDictionary), schemaVersion: version }, String(version));
    }
    const { schemaVersion, ...without } = clone(minimalDictionary);
    assert.equal(schemaVersion, '1.0.0');
    refuses(JaxOntologyReleaseSchema, without, 'no version');
  });

  await suite.test('an unknown key is refused at every level of the block', () => {
    accepts(JaxOntologyReleaseSchema, golden, 'the golden block, before any key is added');
    const places: Array<[string, (block: any) => any]> = [
      ['the block', (block) => block],
      ['claimGuard', (block) => block.claimGuard],
      ['a thing', (block) => block.things[0]],
      ['a thing key', (block) => block.things[0].key],
      ['a key kind', (block) => block.things[0].keyKinds[0]],
      ['a fact', (block) => block.facts[0]],
      ['a link', (block) => block.links[0]],
      ['a binding', (block) => block.bindings[0]],
      ['a binding target', (block) => block.bindings[0].target],
      ['an argument source', (block) => block.bindings[0].args.accountId],
      ['rows', (block) => block.bindings.find((entry: any) => entry.rows).rows],
      ['page', (block) => block.bindings.find((entry: any) => entry.page).page],
      ['a self test', (block) => block.bindings[0].selfTest],
      ['a contract', (block) => block.bindings[0].contract],
      ['a permission rule', (block) => block.permissionRules[0]],
      ['a rule target', (block) => block.permissionRules[0].target],
      ['a who clause', (block) => block.permissionRules[0].who[0]],
      ['a write tool', (block) => block.permissionRules[3].writeTools[0]],
      ['a signal', (block) => block.signalRules[0]],
      ['a signal input', (block) => block.signalRules[0].inputs[0]],
      ['a formula', (block) => block.signalRules[0].formula],
      ['an operand', (block) => block.signalRules[0].formula.right],
      ['a nested formula', (block) => block.signalRules[0].formula.left.formula],
      ['a list operand', (block) => block.signalRules[3].formula.of],
      ['a setting', (block) => block.settings[0]],
      ['a state map', (block) => block.stateMaps[0]],
      ['a state map row', (block) => block.stateMaps[0].table[0]],
      ['a contract change', (block) => block.contractChanges[0]],
    ];
    for (const [label, find] of places) {
      const block = clone(golden);
      find(block).extra = 'x';
      refuses(JaxOntologyReleaseSchema, block, `an extra key on ${label}`);
    }
    refuses(DictionaryPartSchema, { partId: 'a', extra: 1 }, 'a part');
    refuses(DictionaryPartSchema, { partId: 'a', replaces: [{ thing: 'Delivery', with: 'Shipment', extra: 1 }] }, 'a replacement');
  });

  await suite.test('names, ids, paths and times must have the right shape', () => {
    const bad = (label: string, edit: (block: any) => void) => {
      const block = clone(golden);
      edit(block);
      refuses(JaxOntologyReleaseSchema, block, label);
    };
    bad('a thing in lower case', (block) => { block.things[0].thing = 'account'; });
    bad('a thing with a space', (block) => { block.things[0].thing = 'Order line'; });
    bad('a fact path with no thing', (block) => { block.facts[0].fact = 'name'; });
    bad('a fact name in capitals', (block) => { block.facts[0].fact = 'Account.Name'; });
    bad('a link with two dots', (block) => { block.links[0].link = 'Account.orders.lines'; });
    bad('a setting key with no dot', (block) => { block.settings[0].key = 'timeout'; });
    bad('a connector id with an underscore', (block) => { block.selfConnector = 'jax_iq'; });
    bad('a group id in capitals', (block) => { block.permissionRules[0].who[0].groups = ['Finance']; });
    bad('a path with an index', (block) => { block.bindings[0].select = 'records[0].name'; });
    bad('a path with an expression', (block) => { block.bindings[0].select = 'record.a+record.b'; });
    bad('an argument name with a dash', (block) => { block.bindings[0].args = { 'account-id': { from: 'literal', value: 'x' } }; });
    bad('a key pattern that is not a regular expression', (block) => { block.things[0].key.pattern = '(['; });
    bad('a key kind pattern that is not a regular expression', (block) => { block.things[0].keyKinds[2].pattern = '*'; });
    bad('a time that is not a time', (block) => { block.contractChanges[0].approvedAt = 'yesterday'; });
    bad('a time with no zone', (block) => { block.contractChanges[0].approvedAt = '2026-10-29T09:30:00'; });
    bad('a meaning that is blank', (block) => { block.facts[0].meaning = '   '; });
    bad('a meaning on two lines', (block) => { block.facts[0].meaning = 'first line\nsecond line'; });
    bad('a binding id with a space', (block) => { block.bindings[0].bindingId = 'a binding'; });
    bad('an unknown fact type', (block) => { block.facts[0].type = 'currency'; });
    bad('an unknown cardinality', (block) => { block.links[0].cardinality = '2:n'; });
    bad('an unknown authority', (block) => { block.bindings[0].authority = 'boss'; });
    bad('a setting value that is a string', (block) => { block.settings[0].value = '5'; });
    bad('a setting value that is not finite', (block) => { block.settings[0].value = Infinity; });
    bad('an argument literal that is an object', (block) => { block.bindings[0].args.accountId = { from: 'literal', value: {} }; });
    bad('a free-text flag that is not a boolean', (block) => { block.facts[13].freeText = 'yes'; });
    accepts(SettingDefSchema, { ...engineSettingsFixture[0], value: 0 }, 'a setting of zero is a value, not "unset"');
    accepts(SettingDefSchema, { ...engineSettingsFixture[0], value: 2.5 });
  });

  await suite.test('every list has a maximum: the lists stop at their limit and one more is refused', () => {
    const grow = <T>(item: T, size: number): T[] => Array.from({ length: size }, () => clone(item));
    const cases: Array<[string, number, (size: number) => unknown]> = [
      ['things', 200, (size) => ({ ...clone(minimalDictionary), things: grow(minimalDictionary.things[0], size) })],
      ['facts', 3000, (size) => ({ ...clone(minimalDictionary), facts: grow(minimalDictionary.facts[0], size) })],
      ['severities', 20, (size) => ({ ...clone(minimalDictionary), severities: grow('watch', size) })],
      ['aliases', 50, (size) => ({ ...clone(minimalDictionary), things: [{ ...clone(minimalDictionary.things[0]), aliases: grow('word', size) }] })],
      ['key kinds', 20, (size) => ({ ...clone(minimalDictionary), things: [{ ...clone(minimalDictionary.things[0]), keyKinds: grow(minimalDictionary.things[0].keyKinds[0], size) }] })],
      ['enum values', 100, (size) => ({ ...clone(minimalDictionary), facts: [{ ...clone(minimalDictionary.facts[0]), type: 'enum', enumValues: grow('a', size) }] })],
      ['claim classes', 11, (size) => ({ ...clone(minimalDictionary), facts: [{ ...clone(minimalDictionary.facts[0]), claimClasses: grow('catalog_fact', size) }] })],
      ['who clauses', 50, (size) => ({ ...clone(minimalDictionary), permissionRules: [{ ...rule('pr-account-basic-see'), who: grow({ audience: 'staff', groups: [] }, size) }] })],
      ['groups', 50, (size) => ({ ...clone(minimalDictionary), permissionRules: [{ ...rule('pr-account-basic-see'), who: [{ audience: 'staff', groups: grow('g', size) }] }] })],
      ['write tools', 50, (size) => ({ ...clone(minimalDictionary), permissionRules: [{ ...rule('pr-ticket-change'), writeTools: grow({ connectorId: 'zendesk', tool: 'add_ticket_note' }, size) }] })],
      ['state map rows', 200, (size) => ({ ...clone(minimalDictionary), stateMaps: [{ ...clone(golden.stateMaps[0]), table: grow({ from: 'a', to: 'b' }, size) }] })],
      ['signal wording', 20, (size) => ({ ...clone(minimalDictionary), signalRules: [{ ...signal('sig-credit-use'), wording: grow('A sentence.', size) }] })],
      ['link via', 10, (size) => ({ ...clone(minimalDictionary), links: [{ ...clone(golden.links[4]), via: grow('Account.orders', size) }] })],
      ['formula and', 20, (size) => ({ ...clone(minimalDictionary), signalRules: [signalWith({ op: 'and', of: grow({ op: 'positive', of: { input: 'overdue' } }, size) })] })],
    ];
    for (const [label, limit, build] of cases) {
      accepts(JaxOntologyReleaseSchema, build(limit), `${label} at its limit of ${limit}`);
      refuses(JaxOntologyReleaseSchema, build(limit + 1), `${label} past its limit of ${limit}`);
    }
    refuses(JaxOntologyReleaseSchema, { ...clone(minimalDictionary), things: [] , facts: 'none' }, 'a list that is not a list');
    const source = readFileSync(path.join(SRC, 'schema.ts'), 'utf8');
    assert.equal(occurrences(source, 'z.array('), 1, 'every list is built by `list`, which needs a maximum; z.array( appears only inside it');
  });

  await suite.test('the schema source builds only strict objects, keeps no default and lets nothing through', () => {
    const source = readFileSync(path.join(SRC, 'schema.ts'), 'utf8');
    assert.equal(occurrences(source, 'z.object('), occurrences(source, '.strict()'), 'every object is strict');
    for (const loose of ['.passthrough(', '.catchall(', 'z.any(', 'z.unknown(', '.default(', '.transform(', '.preprocess(', 'z.coerce']) {
      assert.equal(occurrences(source, loose), 0, `${loose} is not used: a parse returns what it was given`);
    }
  });

  await suite.test('the formula vocabulary: every operator and every kind of operand parses', () => {
    const formulas: Formula[] = [
      { op: 'ratio', num: { input: 'balance' }, den: { input: 'limit' } },
      ...(['gt', 'gte', 'lt', 'lte', 'eq'] as const).map((cmp): Formula => ({ op: 'compare', cmp, left: { input: 'balance' }, right: { setting: 'credit.useWatch' } })),
      ...(['days', 'hours', 'minutes'] as const).map((unit): Formula => ({ op: 'age', of: { input: 'Ticket.created' }, unit })),
      { op: 'count', of: ticketsWhere({ op: 'positive', of: { input: 'Ticket.dueBy' } }) },
      { op: 'count', of: { input: 'Ticket.tags' } },
      { op: 'any', of: ticketsWhere({ op: 'is_past', of: { input: 'Ticket.dueBy' } }) },
      { op: 'and', of: [{ op: 'positive', of: { input: 'overdue' } }, { op: 'is_past', of: { input: 'dueBy' } }] },
      { op: 'or', of: [{ op: 'positive', of: { input: 'overdue' } }] },
      { op: 'positive', of: { input: 'overdue' } },
      { op: 'is_past', of: { input: 'dueBy' } },
      { op: 'compare', cmp: 'eq', left: { input: 'Ticket.priority' }, right: { text: 'high' } },
      { op: 'compare', cmp: 'gt', left: { formula: { op: 'age', of: { input: 'Ticket.created' }, unit: 'days' } }, right: { setting: 'ticket.highPriorityAge' } },
    ];
    for (const formula of formulas) {
      accepts(FormulaSchema, formula, JSON.stringify(formula));
      assert.deepEqual(FormulaSchema.parse(formula), formula);
      accepts(SignalRuleSchema, signalWith(formula), JSON.stringify(formula));
    }
    const operands: Operand[] = [{ input: 'balance' }, { input: 'Ticket.status' }, { setting: 'credit.useWatch' }, { formula: { op: 'positive', of: { input: 'a' } } }, { text: 'Delayed' }, ticketsWhere({ op: 'positive', of: { input: 'Ticket.dueBy' } })];
    for (const operand of operands) accepts(FormulaSchema, { op: 'compare', cmp: 'eq', left: operand, right: operand }, JSON.stringify(operand));
    refuses(FormulaSchema, { op: 'sum', of: { input: 'a' } }, 'an operator outside the vocabulary');
    refuses(FormulaSchema, { op: 'compare', cmp: 'neq', left: { input: 'a' }, right: { input: 'b' } }, 'a comparison outside the vocabulary');
    refuses(FormulaSchema, { op: 'age', of: { input: 'a' }, unit: 'weeks' }, 'a unit outside the vocabulary');
    refuses(FormulaSchema, { op: 'and', of: [] }, 'an empty and');
    refuses(FormulaSchema, { op: 'any', of: { input: 'Ticket.tags' } }, 'any needs a list over a link');
    refuses(FormulaSchema, { op: 'positive' }, 'a test with nothing to test');
    refuses(FormulaSchema, { op: 'ratio', num: { input: 'a' } }, 'a ratio with no divisor');
  });

  await suite.test('a formula with a literal number is refused, however it is written', () => {
    const compare = (right: unknown) => ({ op: 'compare', cmp: 'gte', left: { input: 'balance' }, right });
    for (const right of [0.8, 3, 0, -1, '0.8', { value: 0.8 }, { number: 3 }, { literal: 1 }, { const: 5 }, { setting: 'credit.useWatch', value: 0.8 }, { input: 'balance', multiplier: 2 }]) {
      refuses(FormulaSchema, compare(right), JSON.stringify(right));
      refuses(SignalRuleSchema, { ...signalWith({ op: 'positive', of: { input: 'a' } }), formula: compare(right) }, JSON.stringify(right));
    }
    for (const word of ['0.8', '3', '15%', '1,000', '$100', '+5', '-2.5', ' 7 ', '.5']) {
      refuses(FormulaSchema, compare({ text: word }), `a number written as text: ${JSON.stringify(word)}`);
    }
    for (const word of ['high', 'Delayed', 'P1', '3PL', 'open', 'new york']) accepts(FormulaSchema, compare({ text: word }), `a word: ${word}`);
    refuses(FormulaSchema, { op: 'age', of: { input: 'a' }, unit: 7 }, 'a number as a unit');
    refuses(FormulaSchema, { op: 'ratio', num: { input: 'a' }, den: 2 }, 'a number as a divisor');
    refuses(FormulaSchema, { op: 'and', of: [1, 2] }, 'numbers as tests');
  });

  await suite.test('a list operand reads the items of one link; its test holds no list of its own', () => {
    const inner = ticketsWhere({ op: 'is_past', of: { input: 'Ticket.dueBy' } });
    accepts(SignalRuleSchema, signalWith({ op: 'or', of: [{ op: 'any', of: inner }, { op: 'compare', cmp: 'gt', left: { formula: { op: 'count', of: inner } }, right: { setting: 'ticket.pileUp' } }] }), 'two lists side by side');
    const nested: Formula = { op: 'any', of: ticketsWhere({ op: 'any', of: { over: 'Order.tickets', where: { op: 'is_past', of: { input: 'Ticket.dueBy' } } } }) };
    assert.match(text(SignalRuleSchema, signalWith(nested)), /a list holds no list/);
    const buried: Formula = { op: 'any', of: ticketsWhere({ op: 'and', of: [{ op: 'compare', cmp: 'gt', left: { formula: { op: 'count', of: inner } }, right: { setting: 'ticket.pileUp' } }] }) };
    assert.match(text(SignalRuleSchema, signalWith(buried)), /a list holds no list/);
    const inCount: Formula = { op: 'compare', cmp: 'gt', left: { formula: { op: 'count', of: ticketsWhere({ op: 'any', of: inner }) } }, right: { setting: 'ticket.pileUp' } };
    assert.match(text(SignalRuleSchema, signalWith(inCount)), /a list holds no list/);
    refuses(FormulaSchema, { op: 'any', of: { over: 'tickets', where: { op: 'positive', of: { input: 'a' } } } }, 'a link name must be Thing.name');
    refuses(FormulaSchema, { op: 'any', of: { over: 'Account.tickets' } }, 'a list with no test');
    refuses(FormulaSchema, { op: 'any', of: { where: { op: 'positive', of: { input: 'a' } } } }, 'a test with no list');
  });

  await suite.test('a permission rule has no field that can name a tool state, and cannot be written to widen anything', () => {
    for (const id of ['pr-account-credit-see', 'pr-ticket-change']) {
      const base = rule(id);
      accepts(PermissionRuleSchema, base, id);
      const keys = Object.keys(base);
      assert.ok(keys.every((key) => !/state|allow|cap|block|ask|grant|permit|effect/i.test(key)), `${id}: the fields are ${keys.join(', ')}`);
      for (const extra of ['state', 'toolState', 'toolStates', 'cap', 'allow', 'allowed', 'blocked', 'ask', 'effect', 'decision', 'grant', 'tools', 'writeToolStates']) {
        refuses(PermissionRuleSchema, { ...base, [extra]: 'allow' }, `${id} with ${extra}`);
      }
      refuses(PermissionRuleSchema, { ...base, who: [{ ...base.who[0], state: 'allow' }] }, `${id}: a clause with a state`);
      refuses(PermissionRuleSchema, { ...base, target: { ...base.target, state: 'allow' } }, `${id}: a target with a state`);
    }
    refuses(PermissionRuleSchema, { ...rule('pr-ticket-change'), writeTools: [{ connectorId: 'zendesk', tool: 'add_ticket_note', state: 'allow' }] }, 'a write tool with a state');
    for (const field of ['ruleId', 'mode', 'target', 'who']) {
      const broken: any = rule('pr-account-credit-see');
      delete broken[field];
      refuses(PermissionRuleSchema, broken, `a rule with no ${field}`);
    }
    accepts(PermissionRuleSchema, { ...rule('pr-account-basic-see'), who: [] }, 'an empty allow-list is a rule that lets nobody through');
    refuses(PermissionRuleSchema, { ...rule('pr-account-basic-see'), target: { thing: 'Account', facts: [] } }, 'an empty fact list is not "the whole thing": leave the facts out');
  });

  await suite.test('customer clauses, company roles, other scopes and the left-out modes are refused', () => {
    const base = rule('pr-account-credit-see');
    for (const clause of [
      { audience: 'company_member', roles: ['account_admin'] },
      { audience: 'company_member', groups: [] },
      { audience: 'everyone' },
      { audience: 'everyone', groups: [] },
      { audience: 'shopper', groups: [] },
      { audience: 'company_member', groups: [], roles: ['buyer'] },
      { audience: 'staff', roles: ['account_admin'] },
      { audience: 'staff', groups: ['finance'], companyRoles: ['buyer'] },
      { groups: ['finance'] },
      { audience: 'staff' },
    ]) {
      refuses(PermissionRuleSchema, { ...base, who: [clause] }, JSON.stringify(clause));
    }
    for (const scope of ['any', 'own_company', 'own_branch', 'owned_by_me']) refuses(PermissionRuleSchema, { ...base, scope }, `scope ${scope}`);
    for (const mode of ['hold', 'claim', 'ask_first', 'allow', 'See', '']) refuses(PermissionRuleSchema, { ...base, mode }, `mode ${JSON.stringify(mode)}`);
    refuses(PermissionRuleSchema, { ...base, companyRoles: ['buyer'] }, 'a company-role field');
    accepts(PermissionRuleSchema, { ...base, mode: 'see' });
    accepts(PermissionRuleSchema, { ...rule('pr-ticket-change'), mode: 'change' });
    accepts(PermissionRuleSchema, { ...base, who: [{ audience: 'staff', groups: [] }] }, 'any member of staff');
  });

  await suite.test('a change rule names the write tools it limits, a see rule names none', () => {
    const change = rule('pr-ticket-change');
    assert.equal(change.mode, 'change');
    assert.deepEqual(change.writeTools, [{ connectorId: 'zendesk', tool: 'add_ticket_note' }]);
    const { writeTools, ...withoutTools } = change;
    assert.ok(writeTools);
    assert.match(text(PermissionRuleSchema, withoutTools), /writeTools: A change rule names the write tools/);
    refuses(PermissionRuleSchema, { ...change, writeTools: [] }, 'an empty tool list');
    assert.match(text(PermissionRuleSchema, { ...rule('pr-account-credit-see'), writeTools: change.writeTools }), /writeTools: Only a change rule names write tools/);
    refuses(PermissionRuleSchema, { ...change, writeTools: [{ connectorId: 'Zendesk', tool: 'add_ticket_note' }] }, 'a connector id in capitals');
  });

  await suite.test('an active signal needs activatedBy and activatedAt; a draft needs neither; retired is gone', () => {
    const active = signal('sig-old-urgent-ticket');
    assert.equal(active.status, 'active');
    accepts(SignalRuleSchema, active);
    const { activatedBy, activatedAt, ...base } = active;
    assert.ok(activatedBy && activatedAt);
    assert.match(text(SignalRuleSchema, { ...base, activatedAt }), /activatedBy: An active signal records who activated it/);
    assert.match(text(SignalRuleSchema, { ...base, activatedBy }), /activatedAt: An active signal records when it was activated/);
    assert.match(text(SignalRuleSchema, base), /activatedBy.*activatedAt/);
    refuses(SignalRuleSchema, { ...base, activatedBy: '   ', activatedAt }, 'a blank name');
    refuses(SignalRuleSchema, { ...base, activatedBy: '', activatedAt }, 'an empty name');
    refuses(SignalRuleSchema, { ...base, activatedBy, activatedAt: 'last week' }, 'a time that is not a time');
    accepts(SignalRuleSchema, { ...base, activatedBy, activatedAt: '2026-10-29T09:30:00+13:00' }, 'a time with an offset');
    accepts(SignalRuleSchema, { ...base, status: 'draft' }, 'a draft with no names');
    accepts(SignalRuleSchema, signal('sig-credit-use'));
    refuses(SignalRuleSchema, { ...active, status: 'retired' }, 'retired');
    refuses(SignalRuleSchema, { ...active, status: 'on' }, 'any other status');
    refuses(SignalRuleSchema, { ...active, threshold: 3 }, 'a number on the signal itself');
    refuses(SignalRuleSchema, { ...active, inputs: [{ name: 'Balance', fact: 'Account.balance' }] }, 'an input name that is not one word');
    refuses(SignalRuleSchema, { ...active, inputs: [{ name: 'balance', fact: 'Account.balance', requireAuthority: 'boss' }] }, 'an authority outside the three');
  });

  await suite.test('a contract change needs a name and a time; a meaning contract needs all five lines', () => {
    const change = clone(golden.contractChanges[0]);
    accepts(ContractChangeSchema, change);
    for (const field of ['approvedBy', 'approvedAt', 'reason', 'from', 'to', 'factOrLink']) {
      const broken: any = clone(change);
      delete broken[field];
      refuses(ContractChangeSchema, broken, `no ${field}`);
    }
    for (const name of ['', '   ', '\n']) refuses(ContractChangeSchema, { ...change, approvedBy: name }, `a name of ${JSON.stringify(name)}`);
    const notTimes = ['', 'today', '2026-10-29', '29/10/2026 09:30', '2026-10-29 09:30:00Z', '2026-13-01T09:30:00Z', '2026-10-29T25:00:00Z', '2026-02-30T09:30:00Z', '2027-02-29T09:30:00Z', '2026-04-31T09:30:00Z'];
    for (const time of notTimes) refuses(ContractChangeSchema, { ...change, approvedAt: time }, `a time of ${JSON.stringify(time)}`);
    for (const time of ['2026-10-29T09:30:00.250Z', '2028-02-29T09:30:00Z', '2026-12-31T23:59:59-11:00']) accepts(ContractChangeSchema, { ...change, approvedAt: time }, time);
    accepts(ContractChangeSchema, { ...change, conversionRule: undefined });
    accepts(MeaningContractSchema, contract);
    accepts(MeaningContractSchema, { ...contract, unit: 'unknown', currency: 'unknown', tax: 'unknown', counts: 'unknown' }, 'unknown is a legal, visible value');
    accepts(MeaningContractSchema, { ...contract, taxLabel: 'GST' });
    for (const line of ['unit', 'currency', 'tax', 'asOf', 'counts']) {
      const broken: any = { ...contract };
      delete broken[line];
      refuses(MeaningContractSchema, broken, `no ${line}`);
    }
    refuses(MeaningContractSchema, { ...contract, tax: 'maybe' });
    refuses(MeaningContractSchema, { ...contract, asOf: 'now' });
    refuses(MeaningContractSchema, { ...contract, counts: '' });
    refuses(MeaningContractSchema, { ...clone(golden.bindings[0]).contract, counts: undefined }, 'a contract with a line missing inside a binding');
  });

  await suite.test('an enum fact needs its values and no other fact has them; vendor free text and lists are flagged and typed', () => {
    const fact = clone(golden.facts.find((entry) => entry.fact === 'Ticket.priority')!);
    accepts(FactDefSchema, fact);
    const { enumValues, ...noValues } = fact;
    assert.ok(enumValues);
    assert.match(text(FactDefSchema, noValues), /enumValues: An enum fact needs its values/);
    assert.match(text(FactDefSchema, { ...fact, type: 'text' }), /enumValues: Only an enum fact has values/);
    refuses(FactDefSchema, { ...fact, enumValues: [] }, 'an enum with no values');
    const subject = golden.facts.find((entry) => entry.fact === 'Ticket.subject')!;
    assert.equal(subject.freeText, true, 'vendor free text is flagged');
    assert.equal(golden.facts.find((entry) => entry.fact === 'Ticket.tags')!.type, 'list');
    accepts(FactDefSchema, { ...subject, freeText: false });
    for (const type of ['text', 'number', 'money', 'percent', 'date', 'datetime', 'boolean', 'ref', 'list']) accepts(FactDefSchema, { ...subject, type }, type);
    assert.equal(new Set(golden.facts.map((entry) => entry.type)).size, 10, 'the golden block uses all ten fact types');
  });

  await suite.test('a part keeps its arrays optional, needs a partId, and carries no release header', () => {
    accepts(DictionaryPartSchema, { partId: 'settings' });
    accepts(DictionaryPartSchema, { partId: 'settings', settings: clone(engineSettingsFixture) });
    accepts(DictionaryPartSchema, { partId: 'fulfilment', replaces: [{ thing: 'Delivery', with: 'Shipment' }], things: [] });
    refuses(DictionaryPartSchema, { settings: [] }, 'no partId');
    refuses(DictionaryPartSchema, { partId: 'bad id' }, 'a partId with a space');
    refuses(DictionaryPartSchema, { partId: 'a', replaces: [{ thing: 'Delivery' }] }, 'a replacement with no replacement');
    refuses(DictionaryPartSchema, { partId: 'a', replaces: [{ thing: 'delivery', with: 'Shipment' }] }, 'a replaced thing in lower case');
    for (const header of [{ ontologyId: 'x' }, { enabled: true }, { schemaVersion: '1.0.0' }, { selfConnector: 'jax-iq' }, { claimGuard: { figures: 'off' } }, { notes: 'x' }]) {
      refuses(DictionaryPartSchema, { partId: 'a', ...header }, JSON.stringify(header));
    }
    refuses(DictionaryPartSchema, { partId: 'a', things: 'none' }, 'an array that is not an array');
  });

  await suite.test('ENGINE_SETTINGS holds the seven names of the plan, each a valid setting key, and the fixtures declare them all with no value', () => {
    assert.deepEqual([...ENGINE_SETTINGS], ['timeout.call', 'timeout.query', 'retry.attempts', 'retry.delay', 'cooldown.rateLimited', 'limit.parallelPerSystem', 'evidence.retention']);
    assert.equal(new Set(ENGINE_SETTINGS).size, ENGINE_SETTINGS.length, 'no name twice');
    for (const name of ENGINE_SETTINGS) accepts(SettingDefSchema, { key: name, label: 'x', kind: 'limit', unit: 'count', ownerRole: 'x', value: null }, name);
    for (const block of [minimalDictionary, accountFixtureDictionary, golden]) {
      for (const name of ENGINE_SETTINGS) {
        const declared = block.settings.find((entry) => entry.key === name);
        assert.ok(declared, `${block.ontologyId} declares ${name}`);
        assert.equal(declared.value, null, `${block.ontologyId}: ${name} has no value`);
      }
    }
    assert.deepEqual(engineSettingsFixture.map((entry) => entry.key), [...ENGINE_SETTINGS]);
    const source = readFileSync(path.join(SRC, 'settings-names.ts'), 'utf8');
    assert.ok(!/\d/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'the names file holds no number');
  });

  await suite.test('the golden v1 block still parses, comes back unchanged and has the fixed hash', () => {
    const parsed = JaxOntologyReleaseSchema.parse(golden);
    assert.deepEqual(parsed, golden);
    assert.equal(createHash('sha256').update(canonical(golden)).digest('hex'), GOLDEN_V1_HASH, 'the frozen block was edited: write a new golden file for a new version instead');
    assert.equal(golden.schemaVersion, '1.0.0');
    assert.equal(golden.enabled, true);
    assert.deepEqual(golden.signalRules.map((entry) => entry.status), ['draft', 'draft', 'draft', 'active']);
    assert.deepEqual([...new Set(golden.permissionRules.map((entry) => entry.mode))].sort(), ['change', 'see']);
    const valued = golden.settings.filter((entry) => entry.value !== null);
    assert.deepEqual(valued.map((entry) => entry.key), ['ticket.highPriorityAge']);
    assert.ok(valued[0].label.startsWith('TEST FIXTURE ONLY'), 'the one value is labelled as a fixture value');
    assert.ok(golden.notes!.startsWith('TEST FIXTURE ONLY'));
  });

  await suite.test('the golden block uses every feature of version 1.0.0, so a later schema is held to all of them', () => {
    const ops = new Set<string>();
    const walk = (value: any) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        if (typeof value.op === 'string') ops.add(value.op);
        Object.values(value).forEach(walk);
      }
    };
    walk(golden.signalRules.map((entry) => entry.formula));
    assert.deepEqual([...ops].sort(), ['age', 'and', 'any', 'compare', 'count', 'is_past', 'or', 'positive', 'ratio']);
    const sources = new Set(golden.bindings.flatMap((entry) => Object.values(entry.args).map((arg) => arg.from)));
    assert.deepEqual([...sources].sort(), ['key', 'literal', 'request']);
    assert.deepEqual([...new Set(golden.bindings.map((entry) => entry.authority))].sort(), ['cross_check', 'fallback', 'source_of_truth']);
    assert.deepEqual([...new Set(golden.bindings.map((entry) => entry.presence))].sort(), ['optional', 'required']);
    assert.deepEqual([...new Set(golden.bindings.map((entry) => entry.target.kind))].sort(), ['fact', 'link']);
    assert.ok(golden.bindings.some((entry) => entry.stateMap), 'a state map on a binding');
    assert.ok(golden.bindings.some((entry) => entry.rows && entry.page?.totalPath && entry.page.morePath), 'a link binding with rows and both page paths');
    assert.ok(golden.bindings.some((entry) => entry.currencyFrom), 'a money binding');
    assert.ok(golden.bindings.some((entry) => entry.precondition), 'a precondition');
    assert.ok(golden.links.some((entry) => entry.via) && golden.links.some((entry) => entry.rollsUpDivisions) && golden.links.some((entry) => entry.inverse));
    assert.deepEqual([...new Set(golden.things.flatMap((entry) => entry.keyKinds.map((kind) => kind.evidence)))].sort(), ['real_field', 'tag', 'text_note']);
    assert.deepEqual([...new Set(golden.things.map((entry) => entry.status))].sort(), ['active', 'modelled_only']);
    assert.ok(golden.things.some((entry) => entry.keyKinds.some((kind) => !kind.ready)));
    assert.ok(golden.claimGuard && golden.facts.some((entry) => entry.claimClasses) && golden.stateMaps.some((entry) => entry.lossy) && golden.contractChanges.length === 1);
  });

  await suite.test('the fixtures fit together: the golden block and the Account block bind only to tools of the connectors fixture', () => {
    const connectors = new Map(connectorsFixture.connectors.map((entry) => [entry.connectorId, entry]));
    for (const block of [minimalDictionary, accountFixtureDictionary, golden]) {
      for (const entry of block.bindings) {
        const connector = connectors.get(entry.system);
        assert.ok(connector && connector.enabled, `${entry.bindingId}: ${entry.system} is an enabled connector`);
        const tool = connector.tools.find((candidate) => candidate.name === entry.tool);
        assert.ok(tool, `${entry.bindingId}: ${entry.tool} is listed`);
        assert.equal(tool.sideEffect, 'read', `${entry.bindingId}: a read tool`);
      }
      assert.equal(connectors.get(block.selfConnector)?.tools.some((tool) => tool.claimClasses?.length), false, 'no claim class on the JAX IQ tools');
    }
    for (const entry of golden.permissionRules.filter((candidate) => candidate.mode === 'change')) {
      for (const ref of entry.writeTools!) assert.equal(connectors.get(ref.connectorId)?.tools.find((tool) => tool.name === ref.tool)?.sideEffect, 'write', 'a change rule names write tools');
    }
    assert.equal(connectors.get('jax-iq')!.enabled, false);
    assert.equal(connectorsFixture.policy.some((row) => row.connectorId === 'jax-iq'), false, 'new JAX IQ tools start blocked: no row');
  });

  await suite.test('the golden block is self-consistent: every name it uses is defined in it, every freshness kind has its setting', () => {
    const things = new Set(golden.things.map((entry) => entry.thing));
    const facts = new Set(golden.facts.map((entry) => entry.fact));
    const links = new Set(golden.links.map((entry) => entry.link));
    const settings = new Set(golden.settings.map((entry) => entry.key));
    const stateMaps = new Set(golden.stateMaps.map((entry) => entry.id));
    const ids = (values: string[]) => assert.equal(new Set(values).size, values.length, 'ids are not repeated');
    ids(golden.things.map((entry) => entry.thing)); ids([...facts]); ids([...links]); ids(golden.bindings.map((entry) => entry.bindingId)); ids(golden.settings.map((entry) => entry.key));
    for (const entry of golden.facts) {
      assert.ok(things.has(entry.thing) && entry.fact.startsWith(`${entry.thing}.`), entry.fact);
      assert.ok(settings.has(`freshness.${entry.freshnessKind}`), `${entry.fact}: freshness.${entry.freshnessKind}`);
    }
    for (const entry of golden.things) {
      assert.ok(facts.has(entry.labelFact), entry.thing);
      for (const name of [...entry.searchFacts, ...entry.defaultFacts]) assert.ok(facts.has(name), `${entry.thing}: ${name}`);
      assert.ok(entry.keyKinds.some((kind) => kind.kind === entry.key.canonical), `${entry.thing}: the canonical key is a key kind`);
    }
    for (const entry of golden.links) {
      assert.ok(things.has(entry.from) && things.has(entry.to), entry.link);
      for (const name of [...(entry.via ?? []), ...(entry.inverse ? [entry.inverse] : [])]) assert.ok(links.has(name), `${entry.link}: ${name}`);
    }
    for (const entry of golden.bindings) {
      assert.ok(entry.target.kind === 'fact' ? facts.has(entry.target.fact) : links.has(entry.target.link), entry.bindingId);
      assert.ok(settings.has(`freshness.${entry.freshnessKind}`), entry.bindingId);
      if (entry.stateMap) assert.ok(stateMaps.has(entry.stateMap), entry.bindingId);
      if (entry.authority === 'source_of_truth') assert.ok(entry.selfTest, `${entry.bindingId}: a source of truth has a self test`);
    }
    for (const entry of golden.permissionRules) for (const name of entry.target.facts ?? []) assert.ok(facts.has(name), `${entry.ruleId}: ${name}`);
    for (const entry of golden.signalRules) {
      assert.ok(golden.severities.includes(entry.severity), entry.signalId);
      for (const input of entry.inputs) assert.ok(facts.has(input.fact) && (!input.maxAge || settings.has(input.maxAge)), `${entry.signalId}: ${input.name}`);
      for (const name of entry.settings) assert.ok(settings.has(name), `${entry.signalId}: ${name}`);
      const read = (value: any, inside: boolean) => {
        if (Array.isArray(value)) return value.forEach((item) => read(item, inside));
        if (!value || typeof value !== 'object') return;
        if (typeof value.setting === 'string') assert.ok(entry.settings.includes(value.setting), `${entry.signalId} lists ${value.setting}`);
        if (typeof value.over === 'string') assert.ok(links.has(value.over), `${entry.signalId}: ${value.over}`);
        if (typeof value.input === 'string') assert.ok(inside ? facts.has(value.input) : entry.inputs.some((input) => input.name === value.input), `${entry.signalId}: input ${value.input}`);
        for (const [key, child] of Object.entries(value)) read(child, inside || key === 'where');
      };
      read(entry.formula, false);
    }
    for (const entry of golden.contractChanges) assert.ok(facts.has(entry.factOrLink) || links.has(entry.factOrLink), entry.factOrLink);
  });

  await suite.test('the package exports the model, the schema and the setting names', () => {
    for (const name of ['JaxOntologyReleaseSchema', 'DictionaryPartSchema', 'FormulaSchema', 'SignalRuleSchema', 'PermissionRuleSchema', 'ENGINE_SETTINGS', 'JAX_ONTOLOGY_SCHEMA_VERSION']) {
      assert.ok(name in jaxIq, `${name} is exported from @journeyax/jax-iq`);
    }
    assert.equal((jaxIq as any).JaxOntologyReleaseSchema, JaxOntologyReleaseSchema);
    assert.equal(typeof JaxOntologyReleaseSchema.safeParse, 'function', 'it offers safeParse, which the project service allow-list needs');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
