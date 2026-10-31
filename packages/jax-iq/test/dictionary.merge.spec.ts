import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { JaxOntologyReleaseSchema } from '../src/model';
import type { Binding, ContractChange, DictionaryPart, FactDef, JaxOntologyRelease, LinkDef, PermissionRule, SettingDef, SignalRule, StateMap, ThingDef } from '../src/model';
import { buildDictionaryIndex, checkDictionary, mergeDictionaryParts } from '../src/dictionary';
import type { DictionaryHeader, DictionaryIssue } from '../src/dictionary';
import { ClaimClassSchema } from '../../knowledge/src/claim-classes';
import { connectorsFixture } from './fixtures/connectors.fixture';
import { emptySetting, engineSettingsFixture } from './fixtures/minimal.dictionary';

/**
 * The merge of dictionary parts and the lookups built from a block. TEST FIXTURE ONLY: the parts below are made up for these tests; none
 * is a part of the shipped dictionary. A part can replace a thing another part defines: the replaced thing goes with what belongs to it,
 * its aliases pass to the replacement, and everything elsewhere that pointed at it is redirected, or the merge says it cannot.
 */
const suite = createSuite('jax-iq: dictionary merge and index');

const golden: JaxOntologyRelease = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));
const KNOWN_CLASSES: readonly string[] = ClaimClassSchema.options;
const header: DictionaryHeader = { ontologyId: 'merge-test', enabled: true, selfConnector: 'jax-iq' };

const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const codes = (issues: DictionaryIssue[]) => issues.map((issue) => issue.code);
const merged = (parts: DictionaryPart[], head: DictionaryHeader = header): JaxOntologyRelease => {
  const result = mergeDictionaryParts(parts, head);
  assert.deepEqual(result.issues.filter((issue) => issue.severity === 'error'), [], 'the merge has no error');
  assert.ok(result.block, 'the merge gave a block');
  return result.block;
};
const permutations = <T>(items: T[]): T[][] => (items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])));

const NOT_APPLICABLE = { unit: 'not_applicable', currency: 'not_applicable', tax: 'not_applicable', asOf: 'retrieved', counts: 'not_applicable' } as const;

const makeThing = (name: string, canonicalKey: string, system: string, aliases: string[], extra: Partial<ThingDef> = {}): ThingDef => ({
  thing: name, meaning: `The ${name} of the test.`, aliases, group: 'Test', status: 'active',
  key: { canonical: canonicalKey, pattern: '^[A-Z]+-\\d+$' },
  keyKinds: [{ kind: canonicalKey, system, evidence: 'real_field', caseRule: 'upper', ready: true }],
  labelFact: `${name}.state`, searchFacts: [`${name}.state`], defaultFacts: [`${name}.state`], expectedIn: [system],
  ...extra,
});
const makeFact = (fact: string, extra: Partial<FactDef> = {}): FactDef => ({
  fact, thing: fact.split('.')[0], label: fact.split('.')[1], meaning: `The ${fact} of the test.`, type: 'text', freshnessKind: 'reference', allowStale: true, ...extra,
});
const makeLink = (link: string, to: string, extra: Partial<LinkDef> = {}): LinkDef => ({ link, from: link.split('.')[0], to, meaning: `The ${link} of the test.`, cardinality: '1:n', ...extra });
const factBinding = (fact: string, system: string, tool: string, keyKind: string, extra: Partial<Binding> = {}): Binding => ({
  bindingId: `${fact}@${system}.${tool}`, target: { kind: 'fact', fact }, system, tool, args: { id: { from: 'key', kind: keyKind } }, select: `record.${fact.split('.')[1]}`,
  presence: 'optional', authority: 'source_of_truth', freshnessKind: 'reference', contract: { ...NOT_APPLICABLE }, selfTest: { fixtureId: 'test-ok' }, ...extra,
});
const linkBinding = (link: string, system: string, tool: string, keyKind: string, extra: Partial<Binding> = {}): Binding => ({
  bindingId: `${link}@${system}.${tool}`, target: { kind: 'link', link }, system, tool, args: { id: { from: 'key', kind: keyKind } }, select: 'records',
  rows: { path: 'records', keyField: 'id' }, presence: 'optional', authority: 'source_of_truth', freshnessKind: 'reference', contract: { ...NOT_APPLICABLE }, selfTest: { fixtureId: 'test-ok' }, ...extra,
});
const seeRule = (ruleId: string, thing: string, facts?: string[]): PermissionRule => ({ ruleId, mode: 'see', target: { thing, ...(facts ? { facts } : {}) }, who: [{ audience: 'staff', groups: [] }] });
const contractChange = (factOrLink: string): ContractChange => ({
  factOrLink,
  from: { ...NOT_APPLICABLE },
  to: { ...NOT_APPLICABLE, counts: 'every one' },
  reason: 'TEST FIXTURE ONLY.', approvedBy: 'Test Approver', approvedAt: '2026-10-29T09:30:00Z',
});
const draftSignal = (signalId: string, appliesTo: string, extra: Partial<SignalRule> = {}): SignalRule => ({
  signalId, name: signalId, meaning: 'A made-up signal.', appliesTo, severity: 'watch',
  inputs: [{ name: 'status', fact: `${appliesTo}.status` }],
  formula: { op: 'compare', cmp: 'eq', left: { input: 'status' }, right: { text: 'failed' } },
  settings: [], status: 'draft', wording: ['Something failed.'], ...extra,
});
const deliveryStateMap: StateMap = { id: 'delivery-words', from: 'ERP words', to: 'order words', table: [{ from: 'scheduled', to: 'planned' }, { from: 'delivered', to: 'done' }], lossy: false };

/** Settings and the owner's severity word. */
const settingsPart = (): DictionaryPart => ({ partId: 'settings', settings: [...clone(engineSettingsFixture), emptySetting('freshness.reference', 'How old a reference fact may be', 'freshness', 'seconds', 'operations')], severities: ['watch'] });
/** The core part: Order and Delivery, a link each way, the things that belong to Delivery, and a rule and a contract change about it. */
const corePart = (): DictionaryPart => ({
  partId: 'core',
  things: [makeThing('Order', 'order_number', 'commercetools', ['order']), makeThing('Delivery', 'delivery_id', 'ace-erp', ['delivery', 'drop'], { labelFact: 'Delivery.status', searchFacts: ['Delivery.status'], defaultFacts: ['Delivery.status', 'Delivery.window'] })],
  facts: [makeFact('Order.state'), makeFact('Delivery.status'), makeFact('Delivery.window')],
  links: [makeLink('Order.deliveries', 'Delivery'), makeLink('Delivery.order', 'Order', { cardinality: 'n:1' })],
  bindings: [
    factBinding('Order.state', 'commercetools', 'get_order', 'order_number'),
    factBinding('Delivery.status', 'ace-erp', 'delivery_status', 'delivery_id'),
    linkBinding('Order.deliveries', 'ace-erp', 'list_deliveries', 'order_number'),
    linkBinding('Delivery.order', 'ace-erp', 'delivery_status', 'delivery_id'),
  ],
  permissionRules: [seeRule('pr-delivery-see', 'Delivery'), seeRule('pr-order-see', 'Order')],
  stateMaps: [deliveryStateMap],
  contractChanges: [contractChange('Delivery.status')],
});
/** A part that points at Delivery from the outside: a link to it, a rule, two signals and a contract change. */
const invoicePart = (): DictionaryPart => ({
  partId: 'invoice',
  things: [makeThing('Invoice', 'invoice_id', 'ace-erp', ['invoice', 'bill'])],
  facts: [makeFact('Invoice.state')],
  links: [makeLink('Invoice.delivery', 'Delivery', { cardinality: 'n:1' })],
  bindings: [factBinding('Invoice.state', 'ace-erp', 'account_balance', 'invoice_id'), linkBinding('Invoice.delivery', 'ace-erp', 'delivery_status', 'invoice_id')],
  permissionRules: [seeRule('pr-invoice-delivery-see', 'Delivery', ['Delivery.status'])],
  signalRules: [
    draftSignal('sig-delivery-failed', 'Delivery', { inputs: [{ name: 'status', fact: 'Delivery.status' }] }),
    draftSignal('sig-order-late', 'Order', {
      inputs: [],
      formula: { op: 'any', of: { over: 'Order.deliveries', where: { op: 'compare', cmp: 'eq', left: { input: 'Delivery.status' }, right: { text: 'failed' } } } },
    }),
  ],
  contractChanges: [contractChange('Delivery.status')],
});
/** The part that replaces Delivery with Shipment. */
const fulfilmentPart = (): DictionaryPart => ({
  partId: 'fulfilment',
  replaces: [{ thing: 'Delivery', with: 'Shipment' }],
  things: [makeThing('Shipment', 'delivery_id', 'ace-erp', ['delivery', 'trip', 'truck'], { labelFact: 'Shipment.status', searchFacts: ['Shipment.status'], defaultFacts: ['Shipment.status', 'Shipment.window'] })],
  facts: [makeFact('Shipment.status'), makeFact('Shipment.window')],
  bindings: [factBinding('Shipment.status', 'ace-erp', 'delivery_status', 'delivery_id'), factBinding('Shipment.window', 'ace-erp', 'delivery_status', 'delivery_id')],
});
const allParts = () => [settingsPart(), corePart(), invoicePart(), fulfilmentPart()];

async function main() {
  await suite.test('the module index exports the three functions the other modules and the services import, and nothing else', () => {
    assert.deepEqual(Object.keys(require('../src/dictionary')).sort(), ['buildDictionaryIndex', 'checkDictionary', 'mergeDictionaryParts']);
  });

  await suite.test('parts merge to one block with the header, sorted lists, the schema version, and a block the schema and the checks accept', () => {
    const block = merged([settingsPart(), corePart(), invoicePart()], { ...header, claimGuard: { figures: 'withhold' }, notes: 'TEST FIXTURE ONLY.' });
    assert.equal(block.schemaVersion, '1.0.0');
    assert.deepEqual([block.ontologyId, block.enabled, block.selfConnector, block.claimGuard, block.notes], ['merge-test', true, 'jax-iq', { figures: 'withhold' }, 'TEST FIXTURE ONLY.']);
    assert.deepEqual(block.things.map((entry) => entry.thing), ['Delivery', 'Invoice', 'Order']);
    assert.deepEqual(block.facts.map((entry) => entry.fact), ['Delivery.status', 'Delivery.window', 'Invoice.state', 'Order.state']);
    assert.deepEqual(block.links.map((entry) => entry.link), ['Delivery.order', 'Invoice.delivery', 'Order.deliveries']);
    assert.deepEqual(block.permissionRules.map((entry) => entry.ruleId), ['pr-delivery-see', 'pr-invoice-delivery-see', 'pr-order-see']);
    assert.deepEqual(block.settings.map((entry) => entry.key), [...block.settings.map((entry) => entry.key)].sort());
    assert.deepEqual(block.severities, ['watch']);
    assert.equal(JaxOntologyReleaseSchema.safeParse(block).success, true);
    assert.deepEqual(checkDictionary(block, { connectors: connectorsFixture, knownClaimClasses: KNOWN_CLASSES }).filter((issue) => issue.severity === 'error'), []);
  });

  await suite.test('without a claim guard or notes the block has neither key, and no parts gives an empty block', () => {
    const block = merged([settingsPart()]);
    assert.equal('claimGuard' in block, false);
    assert.equal('notes' in block, false);
    const empty = merged([]);
    assert.deepEqual([empty.things, empty.facts, empty.links, empty.bindings, empty.permissionRules, empty.signalRules, empty.settings, empty.severities, empty.stateMaps, empty.contractChanges], [[], [], [], [], [], [], [], [], [], []]);
  });

  await suite.test('the output is the same JSON whatever order the parts come in, and the parts passed in are not changed', () => {
    const parts = allParts();
    const before = canonical(parts);
    const expected = canonical(merged(parts));
    assert.equal(canonical(parts), before, 'the parts are untouched');
    const orders = permutations(allParts());
    assert.equal(orders.length, 24);
    for (const order of orders) assert.equal(canonical(merged(order)), expected, order.map((part) => part.partId).join(' '));
    assert.equal(JSON.stringify(merged(allParts())), JSON.stringify(merged([...allParts()].reverse())), 'the text is the same too, not only the value');
  });

  await suite.test('what the merge returns shares nothing with the parts: changing the block leaves the parts alone', () => {
    const parts = allParts();
    const before = canonical(parts);
    const block = merged(parts);
    block.things[0].aliases.push('changed');
    block.facts[0].label = 'changed';
    block.bindings[0].args.id = { from: 'literal', value: 'changed' };
    assert.equal(canonical(parts), before);
  });

  await suite.test('a merge of the golden block cut into two parts gives the golden block back (with its lists sorted) and the same findings', () => {
    const { schemaVersion, ontologyId, enabled, selfConnector, claimGuard, notes, settings, severities, stateMaps, ...rest } = clone(golden);
    assert.equal(schemaVersion, '1.0.0');
    const parts: DictionaryPart[] = [
      { partId: 'shape', settings, severities, stateMaps },
      { partId: 'body', ...rest },
    ];
    const block = merged(parts, { ontologyId, enabled, selfConnector, claimGuard, notes });
    const sorted: JaxOntologyRelease = clone(golden);
    const by = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    sorted.things = by(sorted.things, (item) => item.thing);
    sorted.facts = by(sorted.facts, (item) => item.fact);
    sorted.links = by(sorted.links, (item) => item.link);
    sorted.bindings = by(sorted.bindings, (item) => item.bindingId);
    sorted.permissionRules = by(sorted.permissionRules, (item) => item.ruleId);
    sorted.signalRules = by(sorted.signalRules, (item) => item.signalId);
    sorted.settings = by(sorted.settings, (item) => item.key);
    sorted.stateMaps = by(sorted.stateMaps, (item) => item.id);
    assert.equal(canonical(block), canonical(sorted));
    const ctx = { connectors: connectorsFixture, knownClaimClasses: KNOWN_CLASSES };
    const lines = (issues: DictionaryIssue[]) => issues.map((issue) => `${issue.severity} ${issue.code} ${issue.message}`).sort();
    assert.deepEqual(lines(checkDictionary(block, ctx)), lines(checkDictionary(golden, ctx)));
  });

  await suite.test('an id defined in two parts is an error, for every kind of id, and there is no block', () => {
    const one = (): DictionaryPart => ({
      partId: 'one', things: [makeThing('Order', 'order_number', 'commercetools', ['order'])], facts: [makeFact('Order.state')], links: [makeLink('Order.same', 'Order')],
      bindings: [factBinding('Order.state', 'commercetools', 'get_order', 'order_number')], permissionRules: [seeRule('pr-one', 'Order')], signalRules: [draftSignal('sig-one', 'Order')],
      settings: [emptySetting('freshness.reference', 'x', 'freshness', 'seconds', 'operations')], stateMaps: [deliveryStateMap],
    });
    const two = { ...clone(one()), partId: 'two' };
    const result = mergeDictionaryParts([one(), two], header);
    assert.equal(result.block, undefined);
    assert.deepEqual(codes(result.issues), Array(8).fill('duplicate_id'));
    assert.deepEqual(result.issues.map((issue) => issue.path), ['two.things[0]', 'two.facts[0]', 'two.links[0]', 'two.bindings[0]', 'two.permissionRules[0]', 'two.signalRules[0]', 'two.settings[0]', 'two.stateMaps[0]']);
    assert.match(result.issues[0].message, /'Order'.*part 'one'.*part 'two'/);
    assert.ok(result.issues.every((issue) => issue.severity === 'error'));
    const twice = mergeDictionaryParts([one(), one()], header);
    assert.deepEqual(codes(twice.issues).filter((code) => code === 'merge_duplicate_part'), ['merge_duplicate_part'], 'two parts with one id');
  });

  await suite.test('settings, severities, aliases and any other string list are united and sorted without repeats', () => {
    const a: DictionaryPart = { partId: 'a', severities: ['watch', 'act'] };
    const b: DictionaryPart = { partId: 'b', severities: ['act', 'note'] };
    assert.deepEqual(merged([a, b]).severities, ['act', 'note', 'watch']);
    const block = merged(allParts());
    assert.deepEqual(block.things.find((entry) => entry.thing === 'Shipment')?.aliases, ['delivery', 'drop', 'trip', 'truck'], 'the replacement kept its own words and took the replaced thing\'s, once each');
  });

  await suite.test('a replacement removes the replaced thing with its facts, its links, their bindings, and its own part\'s rules and contract changes', () => {
    const block = merged(allParts());
    assert.deepEqual(block.things.map((entry) => entry.thing), ['Invoice', 'Order', 'Shipment']);
    assert.deepEqual(block.facts.map((entry) => entry.fact), ['Invoice.state', 'Order.state', 'Shipment.status', 'Shipment.window']);
    assert.deepEqual(block.links.map((entry) => entry.link), ['Invoice.delivery', 'Order.deliveries'], 'Delivery.order started at Delivery and went with it');
    assert.deepEqual(block.bindings.map((entry) => entry.bindingId), [
      'Invoice.delivery@ace-erp.delivery_status', 'Invoice.state@ace-erp.account_balance', 'Order.deliveries@ace-erp.list_deliveries', 'Order.state@commercetools.get_order',
      'Shipment.status@ace-erp.delivery_status', 'Shipment.window@ace-erp.delivery_status',
    ]);
    assert.equal(block.permissionRules.some((entry) => entry.ruleId === 'pr-delivery-see'), false, 'the rule of the part that defines Delivery went with it');
    assert.deepEqual(block.contractChanges.map((entry) => entry.factOrLink), ['Shipment.status'], 'the home part\'s contract change went; the other part\'s was redirected');
  });

  await suite.test('every link, rule, signal and contract change elsewhere that pointed at the replaced thing now points at the replacement', () => {
    const block = merged(allParts());
    assert.equal(block.links.find((entry) => entry.link === 'Order.deliveries')?.to, 'Shipment');
    assert.equal(block.links.find((entry) => entry.link === 'Invoice.delivery')?.to, 'Shipment');
    const rule = block.permissionRules.find((entry) => entry.ruleId === 'pr-invoice-delivery-see')!;
    assert.deepEqual(rule.target, { thing: 'Shipment', facts: ['Shipment.status'] });
    const failed = block.signalRules.find((entry) => entry.signalId === 'sig-delivery-failed')!;
    assert.equal(failed.appliesTo, 'Shipment');
    assert.deepEqual(failed.inputs, [{ name: 'status', fact: 'Shipment.status' }]);
    const late = block.signalRules.find((entry) => entry.signalId === 'sig-order-late')!;
    assert.deepEqual(late.formula, { op: 'any', of: { over: 'Order.deliveries', where: { op: 'compare', cmp: 'eq', left: { input: 'Shipment.status' }, right: { text: 'failed' } } } }, 'an item fact inside a list test is renamed too');
    assert.equal(block.stateMaps.length, 1, 'a state map names no thing, so it stays');
  });

  await suite.test('after the replacement no fact, link, binding, rule, signal or contract change names Delivery, and the word "delivery" finds Shipment', () => {
    const block = merged(allParts());
    assert.doesNotMatch(canonical(block), /Delivery/, 'the capital-letter name is nowhere in the block');
    assert.deepEqual(buildDictionaryIndex(block).thingsByWord('delivery').map((entry) => entry.thing), ['Shipment']);
    assert.equal(buildDictionaryIndex(block).thing('Delivery'), undefined);
    assert.deepEqual(checkDictionary(block, { connectors: connectorsFixture, knownClaimClasses: KNOWN_CLASSES }).filter((issue) => issue.severity === 'error'), [], 'the merged block passes the release checks');
  });

  await suite.test('the same parts without the replacement keep Delivery and every pointer to it as it was', () => {
    const block = merged([settingsPart(), corePart(), invoicePart()]);
    assert.equal(block.links.find((entry) => entry.link === 'Order.deliveries')?.to, 'Delivery');
    assert.equal(block.signalRules.find((entry) => entry.signalId === 'sig-delivery-failed')?.appliesTo, 'Delivery');
    assert.deepEqual(block.contractChanges.map((entry) => entry.factOrLink), ['Delivery.status', 'Delivery.status']);
  });

  await suite.test('a replacement can be followed along a chain: A by B, then B by C', () => {
    const parts: DictionaryPart[] = [
      { partId: 'a', things: [makeThing('Alpha', 'alpha_id', 'ace-erp', ['first'])], facts: [makeFact('Alpha.state')] },
      { partId: 'b', replaces: [{ thing: 'Alpha', with: 'Beta' }], things: [makeThing('Beta', 'beta_id', 'ace-erp', ['second'])], facts: [makeFact('Beta.state')] },
      { partId: 'c', replaces: [{ thing: 'Beta', with: 'Gamma' }], things: [makeThing('Gamma', 'gamma_id', 'ace-erp', ['third'])], facts: [makeFact('Gamma.state')] },
      { partId: 'd', things: [makeThing('Other', 'other_id', 'ace-erp', [])], facts: [makeFact('Other.state')], links: [makeLink('Other.alphas', 'Alpha')] },
    ];
    const block = merged(parts);
    assert.deepEqual(block.things.map((entry) => entry.thing), ['Gamma', 'Other']);
    assert.equal(block.links[0].to, 'Gamma');
    assert.deepEqual(block.things[0].aliases, ['first', 'second', 'third']);
  });

  await suite.test('a reference that cannot be redirected is an error that names where it is, and there is no block', () => {
    const cases: Array<[string, (parts: DictionaryPart[]) => void, RegExp, string]> = [
      ['a rule names a fact the replacement does not have', (parts) => { parts[2].permissionRules![0].target.facts = ['Delivery.signature']; }, /Shipment\.signature/, 'invoice.permissionRules.pr-invoice-delivery-see'],
      ['a signal input names a fact the replacement does not have', (parts) => { parts[2].signalRules![0].inputs[0].fact = 'Delivery.signature'; }, /Shipment\.signature/, 'invoice.signalRules.sig-delivery-failed'],
      ['a list test reads an item fact the replacement does not have', (parts) => {
        parts[2].signalRules![1].formula = { op: 'any', of: { over: 'Order.deliveries', where: { op: 'positive', of: { input: 'Delivery.weight' } } } };
      }, /Shipment\.weight/, 'invoice.signalRules.sig-order-late'],
      ['a contract change in another part names a fact the replacement does not have', (parts) => { parts[2].contractChanges![0].factOrLink = 'Delivery.signature'; }, /Shipment\.signature/, 'invoice.contractChanges.Delivery.signature'],
      ['a kept link has an inverse that started at the replaced thing', (parts) => { parts[1].links![0].inverse = 'Delivery.order'; }, /'Delivery\.order'/, 'links.Order.deliveries'],
      ['a signal reads over a link that started at the replaced thing', (parts) => {
        parts[2].signalRules![1].formula = { op: 'any', of: { over: 'Delivery.order', where: { op: 'positive', of: { input: 'Order.state' } } } };
      }, /'Delivery\.order'/, 'invoice.signalRules.sig-order-late'],
      ['a link via names a link that started at the replaced thing', (parts) => { parts[2].links!.push(makeLink('Invoice.route', 'Order', { via: ['Delivery.order'] })); }, /'Delivery\.order'/, 'links.Invoice.route'],
    ];
    for (const [label, change, message, where] of cases) {
      const parts = allParts();
      change(parts);
      const result = mergeDictionaryParts(parts, header);
      assert.equal(result.block, undefined, label);
      const found = result.issues.filter((issue) => issue.code === 'merge_unredirectable');
      assert.equal(found.length, 1, label);
      assert.equal(found[0].severity, 'error', label);
      assert.match(found[0].message, message, label);
      assert.equal(found[0].path, where, label);
    }
  });

  await suite.test('a replacement that does not make sense is an error', () => {
    const changed = (change: (parts: DictionaryPart[]) => void) => () => {
      const parts = allParts();
      change(parts);
      return parts;
    };
    const cases: Array<[string, () => DictionaryPart[], RegExp]> = [
      ['the replacing thing is not defined in the part that says so', changed((parts) => { parts[3].replaces = [{ thing: 'Delivery', with: 'Order' }]; }), /same part must define it/],
      ['the replaced thing is defined in the same part', changed((parts) => { parts[3].things!.push(makeThing('Delivery', 'delivery_id', 'ace-erp', [])); }), /another part must define it/],
      ['nobody defines the replaced thing', changed((parts) => { parts[3].replaces = [{ thing: 'Parcel', with: 'Shipment' }]; }), /No other part defines 'Parcel'/],
      ['a thing replaces itself', changed((parts) => { parts[3].replaces = [{ thing: 'Shipment', with: 'Shipment' }]; }), /cannot replace itself/],
      ['two parts replace one thing', changed((parts) => { parts.push({ partId: 'other', replaces: [{ thing: 'Delivery', with: 'Carrier' }], things: [makeThing('Carrier', 'carrier_id', 'ace-erp', [])] }); }), /already replaced by 'Shipment'/],
      ['the replacements go round in a circle', () => [
        { partId: 'one', replaces: [{ thing: 'Beta', with: 'Alpha' }], things: [makeThing('Alpha', 'alpha_id', 'ace-erp', [])] },
        { partId: 'two', replaces: [{ thing: 'Alpha', with: 'Beta' }], things: [makeThing('Beta', 'beta_id', 'ace-erp', [])] },
      ], /round in a circle/],
    ];
    for (const [label, build, message] of cases) {
      const result = mergeDictionaryParts(build(), header);
      assert.equal(result.block, undefined, label);
      const found = result.issues.filter((issue) => issue.code === 'merge_replace_invalid');
      assert.ok(found.length >= 1, label);
      assert.ok(found.every((issue) => issue.severity === 'error'), label);
      assert.ok(found.some((issue) => message.test(issue.message)), `${label}: ${found.map((issue) => issue.message).join(' | ')}`);
    }
  });

  await suite.test('the merge is deterministic: the same parts give the same result twice, issues included', () => {
    const parts = allParts();
    parts[2].permissionRules![0].target.facts = ['Delivery.signature'];
    assert.deepEqual(mergeDictionaryParts(parts, header), mergeDictionaryParts(parts, header));
    assert.deepEqual(mergeDictionaryParts(allParts(), header), mergeDictionaryParts(allParts(), header));
  });

  // ---- the lookups ----

  await suite.test('index: a thing by its exact name, every thing in the block\'s order, and nothing for an unknown name', () => {
    const index = buildDictionaryIndex(golden);
    assert.equal(index.thing('Account')?.thing, 'Account');
    assert.equal(index.thing('account'), undefined, 'the exact name only');
    assert.equal(index.thing('Nothing'), undefined);
    assert.deepEqual(index.things().map((entry) => entry.thing), ['Account', 'Ticket', 'Order']);
  });

  await suite.test('index: a word finds a thing by its name or an alias, ignoring case and extra spaces, and a shared word finds each thing, sorted', () => {
    const index = buildDictionaryIndex(golden);
    for (const word of ['account', 'Account', '  ACCOUNT ', 'customer']) assert.deepEqual(index.thingsByWord(word).map((entry) => entry.thing), ['Account'], word);
    assert.deepEqual(index.thingsByWord('support  item').map((entry) => entry.thing), ['Ticket'], 'a phrase with a doubled space');
    assert.deepEqual(index.thingsByWord('case').map((entry) => entry.thing), ['Ticket']);
    assert.deepEqual(index.thingsByWord('nothing'), []);
    const shared = clone(golden);
    shared.things[2].aliases = ['order', 'customer'];
    assert.deepEqual(buildDictionaryIndex(shared).thingsByWord('customer').map((entry) => entry.thing), ['Account', 'Order'], 'sorted by name, never one picked');
    for (const entry of golden.things) {
      for (const word of [entry.thing, ...entry.aliases]) assert.ok(index.thingsByWord(word).some((found) => found.thing === entry.thing), `${entry.thing} by ${word}`);
    }
  });

  await suite.test('index: a fact by its thing and name, by its path, and the facts of a thing in order', () => {
    const index = buildDictionaryIndex(golden);
    assert.equal(index.fact('Account', 'balance')?.fact, 'Account.balance');
    assert.equal(index.factByPath('Ticket.dueBy')?.thing, 'Ticket');
    assert.equal(index.fact('Account', 'nothing'), undefined);
    assert.equal(index.fact('Nothing', 'balance'), undefined);
    assert.equal(index.factByPath('Account'), undefined);
    assert.deepEqual(index.factsOf('Order').map((entry) => entry.fact), ['Order.state']);
    assert.deepEqual(index.factsOf('Ticket').map((entry) => entry.fact), golden.facts.filter((entry) => entry.thing === 'Ticket').map((entry) => entry.fact));
    assert.deepEqual(index.factsOf('Nothing'), []);
  });

  await suite.test('index: a link by name, the links that start at a thing, and the bindings of a fact (all of them) and of a link', () => {
    const index = buildDictionaryIndex(golden);
    assert.equal(index.link('Account.tickets')?.to, 'Ticket');
    assert.equal(index.link('Account.nothing'), undefined);
    assert.deepEqual(index.linksFrom('Account').map((entry) => entry.link), ['Account.orders', 'Account.tickets', 'Account.orderTickets']);
    assert.deepEqual(index.linksFrom('Ticket'), []);
    assert.deepEqual(index.bindingsForFact('Account.creditLimit').map((entry) => [entry.system, entry.authority]), [['ace-erp', 'source_of_truth'], ['commercetools', 'cross_check']]);
    assert.deepEqual(index.bindingsForFact('Account.onCreditHold'), [], 'a fact with no source has none');
    assert.deepEqual(index.bindingsForLink('Account.tickets').map((entry) => entry.bindingId), ['Account.tickets@zendesk.find_tickets']);
    assert.deepEqual(index.bindingsForLink('Account.creditLimit'), [], 'a fact is not a link');
    assert.deepEqual(index.bindingsForFact('Account.tickets'), [], 'a link is not a fact');
    const total = golden.bindings.length;
    const counted = golden.facts.reduce((sum, entry) => sum + index.bindingsForFact(entry.fact).length, 0) + golden.links.reduce((sum, entry) => sum + index.bindingsForLink(entry.link).length, 0);
    assert.equal(counted, total, 'every binding of the golden block is found from its target');
  });

  await suite.test('index: a setting and a state map by id', () => {
    const index = buildDictionaryIndex(golden);
    assert.equal(index.setting('credit.useWatch')?.value, null);
    assert.equal(index.setting('nothing.here'), undefined);
    assert.equal(index.stateMap('ticket-status-open')?.lossy, true);
    assert.equal(index.stateMap('nothing'), undefined);
  });

  await suite.test('index: pure. It changes nothing, two builds answer alike, and when an id is defined twice the first definition wins', () => {
    const block = clone(golden);
    const before = canonical(block);
    const first = buildDictionaryIndex(block);
    const second = buildDictionaryIndex(block);
    assert.equal(canonical(block), before);
    assert.deepEqual(first.thingsByWord('customer'), second.thingsByWord('customer'));
    const twice = clone(golden);
    twice.facts.push({ ...clone(twice.facts[0]), label: 'Second' });
    twice.things.push({ ...clone(twice.things[0]), meaning: 'The second.' });
    const index = buildDictionaryIndex(twice);
    assert.equal(index.factByPath('Account.name')?.label, 'Name');
    assert.equal(index.thing('Account')?.meaning, golden.things[0].meaning);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
