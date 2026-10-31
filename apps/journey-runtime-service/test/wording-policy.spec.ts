import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { buildPlaceMakersStack } from './helpers/placemakers-stack';
import { resolveConversationPolicy } from '../src/conversation';

const suite = createSuite('runtime: wording policy choices (template vs model) (Task B5)');

async function main() {
  const stack = await buildPlaceMakersStack();
  const pack = stack.pack;
  const dialogue = resolveConversationPolicy(pack);
  assert.equal(dialogue.wording, 'template', 'default wording must be template');

  const modelPack: any = {
    ...pack,
    extensions: {
      ...(pack.extensions ?? {}),
      dialoguePolicy: {
        wording: 'model',
      },
    },
  };
  assert.equal(resolveConversationPolicy(modelPack).wording, 'model', 'pack override selects model wording');

  const turn = (svc: any, workspaceId: string, message: string, n = 1, forPack: any = pack) =>
    svc.executeTurn({
      tenantId: 'placemakers',
      environmentId: 'test',
      workspaceId,
      sessionId: workspaceId,
      turnId: `${workspaceId}-t${n}`,
      correlationId: `${workspaceId}-c${n}`,
      message,
    }, forPack);

  await suite.test('default wording is template: recommend turns return template message without calling model', async () => {
    const svc = stack.serviceFor({ reply: 'Model generated recommendation that should not be used.' });
    const result = await turn(svc, 'ws-template-rec', 'deck wash', 1, pack);
    assert.ok(result.assistantMessage);
    assert.ok(!result.assistantMessage.includes('Model generated recommendation'), 'template wording should not use model output');
  });

  await suite.test('default wording is template: how-to answers come from product usage steps without calling model', async () => {
    const svc = stack.serviceFor({ reply: 'Model generated steps that should not be used.' });
    const result = await turn(svc, 'ws-template-howto', 'how do I use deck wash', 1, pack);
    assert.equal(
      result.assistantMessage,
      dialogue.templates.howTo.replace('{title}', 'Deck wash 2L').replace('{steps}', 'Brush on, leave for ten minutes, then rinse.')
    );
    assert.ok(!result.assistantMessage.includes('Model generated steps'));
  });

  await suite.test('pack chooses wording "model": recommend turn calls model for grounded customer response', async () => {
    const modelReply = 'For your timber deck, I recommend this wash to clean the surface thoroughly.';
    const svc = stack.serviceFor({ reply: modelReply });
    const result = await turn(svc, 'ws-model-rec', 'deck wash', 1, modelPack);
    assert.equal(result.assistantMessage, modelReply);
  });

  await suite.test('pack chooses wording "model": answer/how-to turn calls model for grounded customer response', async () => {
    const modelHowTo = 'To use this deck wash, apply it evenly across the boards and let it sit for ten minutes.';
    const svc = stack.serviceFor({ reply: modelHowTo });
    const result = await turn(svc, 'ws-model-howto', 'how do I use deck wash', 1, modelPack);
    assert.equal(result.assistantMessage, modelHowTo);
  });

  await suite.test('empty results ("nothing to show") remain deterministic tenant wording even under model wording', async () => {
    const svc = stack.serviceFor({ reply: 'I found imaginary products.' });
    (svc.capabilityGateway as any).registerCustomAdapter('catalog.search', {
      execute: async () => ({ items: [], total: 0 }),
    });
    const result = await turn(svc, 'ws-empty-model', 'wood screws', 1, modelPack);
    assert.ok(result.assistantMessage);
    assert.ok(!result.assistantMessage.includes('imaginary products'), 'model must not invent products when search returns empty');
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
