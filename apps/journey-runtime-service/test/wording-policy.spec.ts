import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { buildPlaceMakersStack, FixedGateway } from './helpers/placemakers-stack';

const suite = createSuite('runtime: legacy wording settings cannot replace the model-driven conversation');

async function main() {
  const stack = await buildPlaceMakersStack({ agentMode: true });
  let id = 0;
  const run = async (wording: 'template' | 'model', reply: string) => {
    const gateway = new FixedGateway();
    let calls = 0;
    gateway.mockAgentExecutor = async (request, onDelta) => {
      calls++;
      assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.includes('screws')), 'the model receives the customer intent');
      const content = calls > 1 ? 'What are you fixing into?' : reply;
      onDelta?.(content);
      return { content, toolCalls: [] };
    };
    const pack: any = structuredClone(stack.pack);
    for (const agent of pack.agents) agent.toolFirst = false;
    pack.extensions = { ...pack.extensions, dialoguePolicy: { ...pack.extensions.dialoguePolicy, wording } };
    const workspaceId = `wording-${id++}`;
    const result = await stack.serviceFor({ modelGateway: gateway }).executeTurn({ tenantId: 'placemakers', environmentId: 'test', workspaceId, sessionId: workspaceId, turnId: `${workspaceId}-turn`, correlationId: `${workspaceId}-correlation`, message: 'screws' }, pack);
    return { calls, result };
  };
  for (const setting of ['template', 'model'] as const) await suite.test(`${setting} legacy setting retains natural model-chosen clarification without forced cards`, async () => {
    const reply = 'What are you fixing into?';
    const { calls, result } = await run(setting, reply);
    assert.equal(calls, 1);
    assert.equal(result.assistantMessage, reply);
    assert.equal(result.uiInstructions.length, 0);
  });
  await suite.test('model wording cannot turn an unsupported warranty claim into evidence', async () => {
    const { calls, result } = await run('model', 'These screws carry a guaranteed twenty-year warranty. What are you fixing into?');
    assert.equal(calls, 2, 'unsupported claims trigger one grounded rewrite');
    assert.doesNotMatch(result.assistantMessage || '', /twenty-year|guaranteed/);
    assert.match(result.assistantMessage || '', /What are you fixing into/);
  });
  suite.finish();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
