import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { projectPublicEvent, projectPublicTurnResult, publicEmitter, publicErrorMessage } from '../src';

const suite = createSuite('journey-core: public stream projection');

// What the runtime really emits at the end of a turn (see the turn service): the decision, and a trace carrying the knowledge decision.
const internalTrace = {
  stage: 'catalogue', transitions: [{ fromStage: 'a', toStage: 'b' }],
  modelRoute: { policyId: 'p', provider: 'anthropic', model: 'claude-x', dataResidency: 'au' },
  knowledgeGate: {
    mode: 'direct_results', conceptId: 'concept://placemakers/vanities', retrieval: { categoryPaths: [['Bathrooms & Plumbing']] },
    messages: { safety_unavailable_customer: 'internal wording', cross_sell_label: 'Have you considered?' },
    trace: { releaseId: 'okf-1', reasonCodes: ['x'] },
  },
};
const done = {
  sessionId: 's1', workspaceId: 'w1', response: 'Here are options', assistantMessage: 'Here are options',
  message: { role: 'assistant', content: 'Here are options', internalNote: 'x' },
  decision: { type: 'invoke_capability', payload: { query: 'q', categoryPaths: [['A']], groups: [] } }, trace: internalTrace,
};
const text = (value: unknown) => JSON.stringify(value);

async function main() {
  await suite.test('the final event keeps the reply and the customer\'s own ids, and drops the decision and the whole trace', () => {
    const projected = projectPublicEvent('done', done)!;
    assert.equal(projected.event, 'done');
    assert.deepEqual(projected.data, { sessionId: 's1', workspaceId: 'w1', response: 'Here are options', assistantMessage: 'Here are options', message: { role: 'assistant', content: 'Here are options' } });
    for (const leaked of ['concept://', 'okf-1', 'anthropic', 'claude-x', 'knowledgeGate', 'internal wording', 'categoryPaths', 'reasonCodes', 'invoke_capability']) {
      assert.ok(!text(projected).includes(leaked), `${leaked} must not reach the browser`);
    }
  });

  await suite.test('internal-only events never reach the browser', () => {
    assert.equal(projectPublicEvent('trace', internalTrace), null);
    assert.equal(projectPublicEvent('data', { decision: done.decision, trace: internalTrace }), null);
    assert.equal(projectPublicEvent('something_new_and_internal', { secret: 1 }), null, 'an event nobody listed is private by default');
  });

  await suite.test('what the storefront renders passes through: session, tokens and cards', () => {
    assert.deepEqual(projectPublicEvent('session', { sessionId: 's1', extra: 1 })!.data, { sessionId: 's1' });
    assert.deepEqual(projectPublicEvent('token', { token: 'Hi', delta: 'Hi', model: 'm' })!.data, { token: 'Hi', delta: 'Hi' });
    const card = { name: 'presentCard', arguments: { card: { id: 'c1', cardType: 'products', state: { products: [] } } }, card: { cardType: 'products', state: {} }, debug: 'x' };
    assert.deepEqual(projectPublicEvent('uiAction', card)!.data, { name: 'presentCard', arguments: card.arguments, card: card.card });
  });

  await suite.test('a capability event says which step ran and whether it worked, never what it was given or returned', () => {
    const projected = projectPublicEvent('capability', { toolId: 'catalog.search', status: 'success', input: { query: 'x' }, output: { items: [{ sku: '1' }] }, error: 'stack', approvalRequestId: 'a1' })!;
    assert.deepEqual(projected.data, { toolId: 'catalog.search', status: 'success' });
  });

  await suite.test('an error shows a message chosen from its code, never the error\'s own text (which may name a host, a collection or a stack)', () => {
    const projected = projectPublicEvent('error', { code: 'SOMETHING_ELSE', message: 'MongoServerError: connection to mongodb://user:pw@host failed\n    at Object.<anonymous> (/app/x.js:1:1)' })!;
    assert.deepEqual(projected.data, { code: 'SOMETHING_ELSE', message: publicErrorMessage() });
    assert.ok(!text(projected).includes('mongodb'));
    assert.equal((projectPublicEvent('error', { code: 'DUPLICATE_TURN', message: 'turnId=abc already processed' })!.data as any).message, 'That message was already received.');
    assert.equal((projectPublicEvent('error', { message: 'no code at all' })!.data as any).message, publicErrorMessage());
  });

  await suite.test('a buffered turn result is projected the same way', () => {
    const projected = projectPublicTurnResult({
      assistantMessage: 'Hi', trace: internalTrace, executedCapabilities: [{ toolId: 'x', output: 1 }],
      decision: done.decision, workspace: { workspaceId: 'w', sessionId: 's', currentStage: 'catalogue', facts: { room: 'bath' }, pins: { okfChecksum: 'abc' } },
      uiInstructions: [{ actionId: 'a', component: 'products', placement: 'inline', props: { products: [] }, envelope: { name: 'presentCard' }, internal: 1 }],
    });
    assert.deepEqual(projected, {
      assistantMessage: 'Hi', decision: { type: 'invoke_capability' }, workspace: { workspaceId: 'w', sessionId: 's', currentStage: 'catalogue' },
      uiInstructions: [{ actionId: 'a', component: 'products', placement: 'inline', props: { products: [] }, envelope: { name: 'presentCard' } }],
    });
    assert.deepEqual(projectPublicTurnResult(null), {});
  });

  await suite.test('an emitter wrapped for the public writes only projected events, in order', () => {
    const written: Array<[string, unknown]> = [];
    const emit = publicEmitter((event, data) => written.push([event, data]));
    emit('session', { sessionId: 's' }); emit('trace', internalTrace); emit('uiAction', { name: 'presentCard', arguments: {} }); emit('token', { token: 'x', delta: 'x' }); emit('data', done); emit('done', done);
    assert.deepEqual(written.map(([event]) => event), ['session', 'uiAction', 'token', 'done']);
    assert.ok(!text(written).includes('knowledgeGate'));
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
