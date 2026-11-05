import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvaluationRunner } from '../src';
import { computePackChecksum } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../business-pack/test/fixtures/legacy-pack.fixture';

function fixture() {
  const release: any = structuredClone(rawLegacyFixture);
  release.manifest.environmentId = 'test';
  release.evaluations = ['first', 'second'].map(id => ({ suiteId: id, name: id, tenantId: release.manifest.tenantId, version: '1', blockingOnPublish: true, scenarios: [{ scenarioId: id, name: id, messages: [id], forbiddenSubstrings: ['unsafe'] }] }));
  const factory = () => ({ executeTurn: async (command: any) => ({ assistantMessage: command.message === 'second' ? 'unsafe outcome' : 'A grounded answer.', decision: { type: 'respond' }, workspace: { tenantId: command.tenantId, environmentId: command.environmentId, packVersionId: release.manifest.version, pins: { packChecksum: computePackChecksum(release) }, facts: {}, currentStage: 'agent' }, executedCapabilities: [] }) as any });
  return { release, factory, options: { tenantId: release.manifest.tenantId, environmentId: 'test' as const, mode: 'in_process' as const, release, isolatedDb: {}, inProcessFactory: factory } };
}
test('every selected blocking suite executes; a passing first suite cannot mask a failing second suite', async () => {
  const { options } = fixture(); const runner = new EvaluationRunner();
  const first = await runner.runSuite({ ...options, suiteId: 'first' });
  const second = await runner.runSuite({ ...options, suiteId: 'second' });
  assert.equal(first.passed, true); assert.equal(second.suiteId, 'second'); assert.equal(second.passed, false);
  await assert.rejects(() => runner.runSuite({ ...options, suiteId: 'missing' }), /No evaluation suite/);
});
test('an in-process gate never constructs ambient production stores or tool clients', async () => {
  const { options } = fixture();
  await assert.rejects(() => new EvaluationRunner().runSuite({ ...options, inProcessFactory: undefined }), /Ambient.*forbidden/);
});
test('wrong release and empty answers cannot be recorded as successful validation', async () => {
  const { options } = fixture();
  for (const change of [{ checksum: 'wrong' }, { text: '' }]) {
    const inProcessFactory = () => ({ executeTurn: async () => ({ assistantMessage: change.text ?? 'An answer', decision: { type: 'respond' }, workspace: { tenantId: options.tenantId, environmentId: 'test', packVersionId: options.release.manifest.version, pins: { packChecksum: change.checksum ?? computePackChecksum(options.release) }, facts: {}, currentStage: 'agent' } }) as any });
    assert.equal((await new EvaluationRunner().runSuite({ ...options, inProcessFactory })).passed, false);
  }
});

test('failed and pending actions cannot satisfy a successful capability assertion, and canonical cards are inspected', async () => {
  const { options } = fixture();
  options.release.evaluations[0].scenarios[0] = { scenarioId: 'actual-outcome', name: 'Actual outcome', messages: ['help'], requiredCapabilities: ['catalog.search'], assertions: [{ type: 'card_present', expected: 'products' }, { type: 'response_contains', expected: 'grounded' }] } as any;
  for (const status of ['failure', 'requires_approval', 'success']) {
    const inProcessFactory = () => ({ executeTurn: async () => ({ assistantMessage: 'A grounded answer.', decision: { type: 'respond' }, workspace: { tenantId: options.tenantId, environmentId: 'test', packVersionId: options.release.manifest.version, pins: { packChecksum: computePackChecksum(options.release) }, facts: {}, currentStage: 'agent' }, executedCapabilities: [{ toolId: 'catalog.search', status }], uiInstructions: [{ component: 'products', envelope: { arguments: { card: { cardType: 'products' } } } }] }) as any });
    assert.equal((await new EvaluationRunner().runSuite({ ...options, suiteId: 'first', inProcessFactory })).passed, status === 'success');
  }
});

test('unsupported assertions and missing required content cannot silently pass', async () => {
  const { options } = fixture();
  for (const assertion of [{ type: 'response_contains', expected: 'required evidence' }, { type: 'card_present', expected: 'comparison' }, { type: 'unknown_check' }]) {
    (options.release.evaluations[0].scenarios[0] as any).assertions = [assertion];
    assert.equal((await new EvaluationRunner().runSuite({ ...options, suiteId: 'first' })).passed, false);
  }
});

test('empty suites, invalid budgets, missing equality values and forbidden attempts fail closed', async () => {
  const { options } = fixture();
  const suite: any = options.release.evaluations[0];
  const scenario = suite.scenarios[0];
  suite.scenarios = [];
  await assert.rejects(() => new EvaluationRunner().runSuite({ ...options, suiteId: 'first' }), /at least one scenario/);
  suite.scenarios = [scenario];
  const inProcessFactory = () => ({ executeTurn: async () => ({ assistantMessage: 'A grounded answer.', decision: { type: 'respond' }, workspace: { tenantId: options.tenantId, environmentId: 'test', packVersionId: options.release.manifest.version, pins: { packChecksum: computePackChecksum(options.release) }, facts: { quote: { value: { total: 'not a number' } } }, currentStage: 'agent' }, executedCapabilities: [{ toolId: 'forbidden_write', status: 'failure' }] }) as any });
  for (const assertion of [
    { type: 'budget_ceiling', field: 'quote.total', expected: 100 },
    { type: 'budget_ceiling', field: 'quote.total' },
    { type: 'fact_equals', field: 'missing' },
    { type: 'capability_not_executed', field: 'forbidden_write' },
  ]) {
    scenario.assertions = [assertion];
    assert.equal((await new EvaluationRunner().runSuite({ ...options, suiteId: 'first', inProcessFactory })).passed, false);
  }
  scenario.assertions = [{ type: 'fact_present', field: 'quote.total' }];
  assert.equal((await new EvaluationRunner().runSuite({ ...options, suiteId: 'first', inProcessFactory })).passed, true);
});

test('SKU grounding checks actual rendered cards and text against successful tool provenance', async () => {
  const { options } = fixture();
  (options.release.evaluations[0].scenarios[0] as any).assertions = [{ type: 'no_hallucinated_skus' }];
  for (const example of [
    { source: ['A-1'], card: 'A-1', text: 'SKU A-1 is an option.', passes: true },
    { source: ['A-1'], card: 'B-2', text: 'Here are options.', passes: false },
    { source: ['A-1'], card: 'A-1', text: 'Consider SKU B-2.', passes: false },
    { source: ['A-1'], card: 'A-1', text: 'Consider SKU **B-2**.', passes: false },
    { source: undefined, card: 'A-1', text: 'Here are options.', passes: false },
  ]) {
    const inProcessFactory = () => ({ executeTurn: async () => ({ assistantMessage: example.text, decision: { type: 'respond' },
      workspace: { tenantId: options.tenantId, environmentId: 'test', packVersionId: options.release.manifest.version, pins: { packChecksum: computePackChecksum(options.release) }, facts: {}, currentStage: 'agent' },
      trace: { toolProductSkus: example.source }, uiInstructions: [{ component: 'products', props: { products: [{ sku: example.card }] } }] }) as any });
    const result = await new EvaluationRunner().runSuite({ ...options, suiteId: 'first', inProcessFactory });
    assert.equal(result.passed, example.passes, JSON.stringify(example));
  }
});

test('an exact negative lookup is allowed in prose but never licenses a product card or positive claim', async () => {
  const { options } = fixture();
  (options.release.evaluations[0].scenarios[0] as any).assertions = [{ type: 'no_hallucinated_skus' }];
  for (const example of [
    { text: 'SKU **MISSING-127** does **not** exist in our catalogue.', missing: ['MISSING-127'], card: false, passes: true },
    { text: 'SKU **MISSING-127** does **not** exist in our range.\nFactual statement: **“SKU MISSING-127 was not found in our catalogue.”**', missing: ['MISSING-127'], card: false, passes: true },
    { text: 'SKU MISSING-127 was not found in our catalogue.', missing: [], card: false, passes: false },
    { text: 'SKU MISSING-127 was not found in our catalogue and costs $25.', missing: ['MISSING-127'], card: false, passes: false },
    { text: 'SKU MISSING-127 was not found in our catalogue.', missing: ['MISSING-127'], card: true, passes: false },
  ]) {
    const inProcessFactory = () => ({ executeTurn: async () => ({ assistantMessage: example.text, decision: { type: 'respond' },
      workspace: { tenantId: options.tenantId, environmentId: 'test', packVersionId: options.release.manifest.version, pins: { packChecksum: computePackChecksum(options.release) }, facts: {}, currentStage: 'agent' },
      trace: { toolProductSkus: [], missingProductSkus: example.missing }, uiInstructions: example.card ? [{ component: 'products', props: { products: [{ sku: 'MISSING-127' }] } }] : [] }) as any });
    assert.equal((await new EvaluationRunner().runSuite({ ...options, suiteId: 'first', inProcessFactory })).passed, example.passes, JSON.stringify(example));
  }
});
