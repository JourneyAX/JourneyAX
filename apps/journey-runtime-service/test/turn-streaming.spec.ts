import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { ModelGateway, type ModelExecutionRequest } from '../src/kernel/model.gateway';
import { IncrementalSentenceShaper, type ShapeContext } from '../src/kernel/reply-shaper';
import { buildPlaceMakersStack, TENANT, ENVIRONMENT, FixedGateway } from './helpers/placemakers-stack';

const suite = createSuite('turn-streaming: claim-guarded sentence streaming and event ordering (Task B2)');

async function main() {
  await suite.test('IncrementalSentenceShaper withholds unsupported claims and emits approved sentences', async () => {
    const emittedTokens: Array<{ token: string; delta: string }> = [];
    const shapeContext: ShapeContext = {
      style: {
        maxSentences: 3,
        forbiddenPhrases: ['go and browse'],
        dropCompanyName: true,
        dropListLines: true,
        rules: [],
      },
      companyNames: ['PlaceMakers'],
      internalIds: ['concept://tools/screws'],
      questionCardShown: false,
    };

    const shaper = new IncrementalSentenceShaper(
      shapeContext,
      ['suggestion'], // only suggestion allowed; warranty, care_safety, legal are forbidden
      true, // isOkfRelease
      (token, delta) => emittedTokens.push({ token, delta })
    );

    // Stream chunks with a forbidden warranty claim, a list line, and an approved sentence
    shaper.processDelta('This fitting is guaranteed for 10 years. ');
    shaper.processDelta('- Step 1: do not do this.\n');
    shaper.processDelta('For timber decks, we recommend 10g x 65mm screws. ');
    shaper.flush();

    // The warranty sentence must NEVER be emitted
    assert.equal(emittedTokens.some(t => t.token.includes('guaranteed')), false, 'warranty claim was withheld');
    // The list line must NEVER be emitted
    assert.equal(emittedTokens.some(t => t.token.includes('Step 1')), false, 'list line was removed');
    // The approved recommendation MUST be emitted
    assert.equal(emittedTokens.length, 1, 'only approved sentence was emitted');
    assert.equal(emittedTokens[0].token, 'For timber decks, we recommend 10g x 65mm screws.');
  });

  await suite.test('event order is session ... token ... data ... done with exactly one done', async () => {
    const stack = await buildPlaceMakersStack();
    const service = stack.serviceFor({ servePacks: true });

    const events: Array<{ event: string; data: any }> = [];
    await service.executeTurnStream(
      {
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
        workspaceId: 'ws-stream-test',
        turnId: 'turn-1',
        message: 'Show me decking screws',
      },
      (event, data) => events.push({ event, data })
    );

    const eventNames = events.map((e) => e.event);

    // 1. Must start with session
    assert.equal(eventNames[0], 'session', 'first event is session');

    // 2. Must have token events before data and done
    const firstTokenIdx = eventNames.indexOf('token');
    const dataIdx = eventNames.indexOf('data');
    const doneIdx = eventNames.indexOf('done');

    assert.ok(firstTokenIdx > 0, 'token event was emitted');
    assert.ok(dataIdx > firstTokenIdx, 'data event occurs after token');
    assert.ok(doneIdx > dataIdx, 'done event occurs after data');

    // 3. Exactly one done event
    const doneCount = eventNames.filter((e) => e === 'done').length;
    assert.equal(doneCount, 1, 'exactly one done event is emitted');

    // 4. Done message has the authoritative assistant response
    const doneEvent = events.find((e) => e.event === 'done')!;
    assert.ok(doneEvent.data.message?.content, 'done payload has message content');
    assert.equal(doneEvent.data.response, doneEvent.data.message.content);
  });

  await suite.test('no unsupported claim ever appears in a streamed token event', async () => {
    // Custom gateway that simulates a model trying to output an unsupported warranty claim during response generation
    class RogueModelGateway extends FixedGateway {
      async executeStream(release: any, request: ModelExecutionRequest, onDelta: (delta: string) => void): Promise<any> {
        if (request.taskType === 'response_generation') {
          const dangerousOutput = 'This fitting is guaranteed for 10 years by law. We recommend 10g x 65mm screws for timber decking.';
          // Stream word by word
          for (const word of dangerousOutput.split(' ')) {
            onDelta(word + ' ');
          }
          return {
            content: dangerousOutput,
            route: { policyId: request.taskType, provider: 'custom', model: 'rogue-model', dataResidency: 'test', timeoutMs: 1000, maxInputTokens: 4096, maxOutputTokens: 1024 },
            latencyMs: 1, usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 }, residencyProven: true, residencyEvidence: 'isolated-test-adapter',
          };
        }
        return super.execute(release, request);
      }
    }

    const stack = await buildPlaceMakersStack();
    const rogueGateway = new RogueModelGateway();
    const service = stack.serviceFor({ servePacks: true });
    (service as any).modelGateway = rogueGateway;

    const events: Array<{ event: string; data: any }> = [];
    // "what is the difference" is in answerPhrases, triggering model response generation without templated fallback
    await service.executeTurnStream(
      {
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
        workspaceId: 'ws-claim-safety-stream',
        turnId: 'turn-1',
        message: 'What is the difference between composite and timber screws?',
      },
      (event, data) => events.push({ event, data })
    );

    const tokenEvents = events.filter((e) => e.event === 'token');
    const allStreamedText = tokenEvents.map((e) => e.data.token || e.data.delta || '').join(' ');

    // The warranty and legal claims MUST NOT appear in any streamed token event
    assert.equal(allStreamedText.includes('guaranteed'), false, 'warranty claim never appears in streamed text');
    assert.equal(allStreamedText.includes('by law'), false, 'legal claim never appears in streamed text');

    // The safe recommendation sentence was streamed
    assert.ok(allStreamedText.includes('screws for timber decking'), 'grounded recommendation was delivered');

    // Exactly one done event
    const doneEvents = events.filter((e) => e.event === 'done');
    assert.equal(doneEvents.length, 1, 'exactly one done event');
    assert.equal(doneEvents[0].data.message.content.includes('guaranteed'), false, 'done event does not have forbidden claim');
  });

  await suite.test('streaming disabled via policy emits single final token', async () => {
    const stack = await buildPlaceMakersStack();
    const service = stack.serviceFor({ servePacks: true });

    const releaseWithNoStreaming = {
      ...stack.pack,
      extensions: {
        ...(stack.pack as any).extensions,
        dialoguePolicy: { streaming: false },
      },
    };

    const events: Array<{ event: string; data: any }> = [];
    await service.executeTurnStream(
      {
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
        workspaceId: 'ws-no-stream-test',
        turnId: 'turn-1',
        message: 'Show me decking screws',
      },
      releaseWithNoStreaming,
      (event, data) => events.push({ event, data })
    );

    const tokenEvents = events.filter((e) => e.event === 'token');
    assert.equal(tokenEvents.length, 1, 'only one token event emitted when streaming is disabled');
    const doneEvents = events.filter((e) => e.event === 'done');
    assert.equal(doneEvents.length, 1, 'exactly one done event');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
