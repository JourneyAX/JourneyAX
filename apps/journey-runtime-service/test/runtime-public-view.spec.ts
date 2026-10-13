import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { RuntimeController } from '../src/runtime.controller';

const suite = createSuite('runtime: the customer-facing view of a turn');

const internalTrace = {
  stage: 'catalogue', transitions: [],
  modelRoute: { provider: 'anthropic', model: 'claude-x' },
  knowledgeGate: { mode: 'direct_results', conceptId: 'concept://t/x', messages: { a: 'internal' }, trace: { releaseId: 'okf-1' } },
};
const full = {
  assistantMessage: 'Here are options', decision: { type: 'invoke_capability', payload: { query: 'q', categoryPaths: [['A']] } },
  workspace: { workspaceId: 'w', sessionId: 's', currentStage: 'catalogue', facts: { room: { value: 'bath' } }, pins: { okfChecksum: 'abc' } },
  uiInstructions: [{ actionId: 'a', component: 'products', placement: 'inline', props: { products: [] } }],
  trace: internalTrace, executedCapabilities: [{ toolId: 'catalog.search', input: { query: 'q' } }],
};

/** The controller only calls the service's turn methods; this one speaks the runtime's real event vocabulary. */
const service: any = {
  runTurn: async () => structuredClone(full),
  streamTurn: async (command: any, emit: (event: string, data: any) => void) => {
    emit('session', { sessionId: command.sessionId });
    emit('capability', { toolId: 'catalog.search', status: 'success', input: { query: 'q' }, output: { items: [{ sku: '1' }] } });
    emit('uiAction', { name: 'presentCard', arguments: { card: { id: 'c', cardType: 'products', state: { products: [] } } } });
    emit('token', { token: 'Here are options', delta: 'Here are options' });
    emit('data', { sessionId: command.sessionId, decision: full.decision, trace: internalTrace });
    emit('done', { sessionId: command.sessionId, workspaceId: command.workspaceId, decision: full.decision, trace: internalTrace, response: 'Here are options', assistantMessage: 'Here are options', message: { role: 'assistant', content: 'Here are options' } });
  },
};
const controller = new RuntimeController(service);
const body = { sessionId: 's1', workspaceId: 'w1', turnId: 't1', correlationId: 'c1', message: 'vanities' };
const request = (isInternal: boolean) => ({ authContext: { tenantId: 'placemakers', environmentId: 'test', principalId: 'p', principalRole: 'customer', isInternal } });

function sse() {
  const frames: Array<{ event: string; data: any }> = [];
  const res: any = {
    status: () => res, setHeader: () => undefined, end: () => undefined,
    write: (chunk: string) => { frames.push({ event: /event: (.+)/.exec(chunk)![1], data: JSON.parse(/data: (.+)/.exec(chunk)![1]) }); },
  };
  return { res, frames };
}

async function main() {
  await suite.test('a caller that is not a platform workload gets only the customer-facing stream', async () => {
    const { res, frames } = sse();
    await controller.streamTurn('placemakers', 'test', body, request(false), res);
    assert.deepEqual(frames.map((frame) => frame.event), ['session', 'capability', 'uiAction', 'token', 'done']);
    const text = JSON.stringify(frames);
    for (const leaked of ['concept://', 'okf-1', 'anthropic', 'claude-x', 'knowledgeGate', 'invoke_capability', 'categoryPaths', '"sku":"1"', 'okfChecksum']) assert.ok(!text.includes(leaked), `${leaked} stays inside`);
    assert.deepEqual(frames[1].data, { toolId: 'catalog.search', status: 'success' });
    assert.equal(frames[4].data.message.content, 'Here are options');
  });

  await suite.test('a platform workload presenting the internal key still gets every event', async () => {
    const { res, frames } = sse();
    await controller.streamTurn('placemakers', 'test', body, request(true), res);
    assert.deepEqual(frames.map((frame) => frame.event), ['session', 'capability', 'uiAction', 'token', 'data', 'done']);
    assert.equal(frames[4].data.trace.knowledgeGate.conceptId, 'concept://t/x');
  });

  await suite.test('the buffered turn is projected the same way', async () => {
    const publicResult: any = await controller.runTurn('placemakers', 'test', body, request(false));
    assert.deepEqual(publicResult, {
      assistantMessage: 'Here are options', decision: { type: 'invoke_capability' },
      workspace: { workspaceId: 'w', sessionId: 's', currentStage: 'catalogue' },
      uiInstructions: [{ actionId: 'a', component: 'products', placement: 'inline', props: { products: [] } }],
    });
    const internal: any = await controller.runTurn('placemakers', 'test', body, request(true));
    assert.equal(internal.trace.knowledgeGate.conceptId, 'concept://t/x');
    assert.equal(internal.workspace.pins.okfChecksum, 'abc');
  });

  await suite.test('a failure mid-stream shows the customer a fixed message, not the error text', async () => {
    const failing = new RuntimeController({ streamTurn: async () => { throw new Error('MongoServerError: auth failed for mongodb://user:pw@host/db'); } } as any);
    const { res, frames } = sse();
    await failing.streamTurn('placemakers', 'test', body, request(false), res);
    assert.deepEqual(frames.map((frame) => frame.event), ['error']);
    assert.ok(!JSON.stringify(frames).includes('mongodb'));
    assert.equal(typeof frames[0].data.message, 'string');
    const internal = sse();
    await failing.streamTurn('placemakers', 'test', body, request(true), internal.res);
    assert.match(internal.frames[0].data.message, /MongoServerError/, 'platform callers still see the real error');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
