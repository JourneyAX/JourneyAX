import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { TurnInterpreter, isAmbiguousMeasurementAnswer, isRecognisedMeasurement } from '../src/turn/interpret-event';
import { formatCatalogPrice } from '../src/turn/price-format';
import {
  isListFact,
  resolveFactRole,
  resolveInterpretationPolicy,
  uniqueFactWithRole,
} from '../src/turn/fact-semantics';

const suite = createSuite('runtime: fact semantics are declared, not guessed');

function release(extra: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): any {
  return {
    manifest: { packId: 'p', tenantId: 't', environmentId: 'test', version: '1', checksum: 'x' },
    profile: { primaryCurrency: 'NZD' },
    vocabulary: { version: '1', terms: [], acronyms: {}, slotSynonyms: {}, slotQuestions: {} },
    entities: { version: '1', entities: [] },
    factRegistry: { version: '1', facts },
    journeys: { journeys: [{ journeyId: 'j', requiredFacts: [], stages: [{ stageId: 's', requiredFacts: Object.keys(facts) }] }] },
    ...extra,
  };
}
const workspace: any = { workspaceId: 'w', tenantId: 't', environmentId: 'test', journeyId: 'j', currentStage: 's', facts: {}, openQuestions: [] };
const interpret = (rel: any, message: string) => new TurnInterpreter().interpret({ message } as any, rel, workspace);

async function main() {
  await suite.test('role comes from the registry or entity type, never from the key spelling', () => {
    const rel = release({}, { room_size: { key: 'room_size' }, footprint: { key: 'footprint', role: 'measurement' } });
    assert.equal(resolveFactRole(rel, 'room_size'), undefined, 'a name containing "size" is not a measurement');
    assert.equal(resolveFactRole(rel, 'footprint'), 'measurement');
    const viaEntity = release({ entities: { version: '1', entities: [{ entityName: 'span', type: 'measurement' }, { entityName: 'spend', type: 'currency' }] } });
    assert.equal(resolveFactRole(viaEntity, 'span'), 'measurement');
    assert.equal(resolveFactRole(viaEntity, 'spend'), 'money');
  });

  await suite.test('list facts are declared with multiple/array/multi_select', () => {
    const rel = release({}, { a: { key: 'a', multiple: true }, b: { key: 'b', type: 'array' }, c: { key: 'c', uiInputType: 'multi_select' }, d: { key: 'd' } });
    assert.deepEqual(['a', 'b', 'c', 'd'].map((key) => isListFact(rel, key)), [true, true, true, false]);
  });

  await suite.test('a role resolves to a fact only when exactly one fact carries it', () => {
    const rel = release({}, { m1: { key: 'm1', role: 'measurement' }, m2: { key: 'm2', role: 'measurement' }, cash: { key: 'cash', role: 'money' } });
    assert.equal(uniqueFactWithRole(rel, ['m1', 'm2', 'cash'], 'measurement'), undefined);
    assert.equal(uniqueFactWithRole(rel, ['m1', 'm2', 'cash'], 'money'), 'cash');
  });

  await suite.test('money and quantity expressions fill the declared role fact, whatever its key', async () => {
    const rel = release({}, { spend_limit: { key: 'spend_limit', role: 'money' }, how_many: { key: 'how_many', role: 'quantity' } });
    const result = await interpret(rel, 'budget of $250 and I need 12');
    assert.deepEqual((result.candidateFacts as any).spend_limit?.value, { amountCents: 25000, currency: 'NZD' });
    assert.equal((result.candidateFacts as any).how_many?.value, 12);
  });

  await suite.test('facts named budget/quantity without a declared role are not extracted by name', async () => {
    const rel = release({}, { budget: { key: 'budget' }, quantity: { key: 'quantity' } });
    const result = await interpret(rel, 'under $500, I need 12 units');
    assert.equal((result.candidateFacts as any).budget, undefined);
    assert.equal((result.candidateFacts as any).quantity, undefined);
  });

  await suite.test('compound dimensions go to the single declared measurement fact only', async () => {
    const declared = release({}, { footprint: { key: 'footprint', role: 'measurement' } });
    const hit = await interpret(declared, 'about 3 x 4 m');
    assert.ok((hit.candidateFacts as any).footprint, 'extracted into the declared measurement fact');
    const guessedByName = release({}, { room_size: { key: 'room_size' } });
    const miss = await interpret(guessedByName, 'about 3 x 4 m');
    assert.equal((miss.candidateFacts as any).room_size, undefined);
  });

  await suite.test('the registry decides which facts customers may never set', async () => {
    const rel = release({}, {
      order_ref: { key: 'order_ref', permittedSources: ['capability'] },
      colour: { key: 'colour', allowedValues: ['red'], permittedSources: ['customer'] },
    });
    rel.vocabulary.slotSynonyms = { order_ref: ['ref-1'], colour: ['red'] };
    const result = await interpret(rel, 'ref-1 in red');
    assert.equal((result.candidateFacts as any).order_ref, undefined);
    assert.equal((result.candidateFacts as any).colour?.value, 'red');
  });

  await suite.test('interpretation policy is platform data overridable by the pack', () => {
    const base = resolveInterpretationPolicy(release());
    assert.ok(base.promptRules.length >= 5);
    const custom = resolveInterpretationPolicy(release({ extensions: { interpretationPolicy: { money: { symbols: ['€'] }, promptRules: ['only json'] } } }));
    assert.deepEqual(custom.money.symbols, ['€']);
    assert.deepEqual(custom.promptRules, ['only json']);
    assert.deepEqual(custom.quantity, base.quantity);
  });

  await suite.test('prices are formatted in the declared currency and never assume a symbol', () => {
    assert.equal(formatCatalogPrice(12.5, 'NZD', 'ask'), 'NZ$12.50');
    assert.equal(formatCatalogPrice({ amountCents: 1999 }, 'eur', 'ask'), '€19.99');
    assert.equal(formatCatalogPrice(10, undefined, 'ask'), '10.00');
    assert.equal(formatCatalogPrice(null, 'NZD', 'ask'), 'ask');
    assert.equal(formatCatalogPrice(0, 'NZD', 'ask'), 'ask');
  });

  await suite.test('measurement grammar is generic: units and compounds pass, bare or unknown-unit answers do not', () => {
    for (const ok of ['2.4 m', '1200mm', '3 x 4', '3x4x2 m']) assert.equal(isRecognisedMeasurement(ok), true, ok);
    for (const bad of ['100 miters', 'big']) assert.equal(isRecognisedMeasurement(bad), false, bad);
    for (const ambiguous of ['100 miters', '5']) assert.equal(isAmbiguousMeasurementAnswer(ambiguous), true, ambiguous);
    for (const clear of ['5 m', '3 x 4', 'two doors please']) assert.equal(isAmbiguousMeasurementAnswer(clear), false, clear);
  });
}

main().then(() => { suite.finish(); }).catch((e) => { console.error(e); process.exitCode = 1; });
