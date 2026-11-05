import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackReleaseSchema, PackRepository, publishBusinessPack } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { createIsolatedEvaluationRuntime } from '../../journey-runtime-service/src/evaluation/isolated-runtime';
import { ModelGateway } from '../../journey-runtime-service/src/kernel/model.gateway';
import { PublicationGateValidator } from '../src/publication-gate-validator';

function candidate() {
  const raw: any = structuredClone(rawLegacyFixture);
  raw.manifest.environmentId = 'test';
  raw.agents[0].isDefault = true;
  raw.agents[0].allowedTools = ['catalog.search'];
  raw.evaluations = [{ suiteId: 'answer-quality', name: 'Answer quality', tenantId: raw.manifest.tenantId, version: '1', blockingOnPublish: true, scenarios: [{ scenarioId: 'continuity', name: 'Continuity', messages: ['Help plan my laundry', 'Continue with that same project'], forbiddenSubstrings: ['forbidden_fixture_phrase'] }] }];
  return BusinessPackReleaseSchema.parse(raw);
}

test('publication uses the actual harness with private conversation stores and never touches ambient Mongo or live sources', async () => {
  const db = new MemoryDb(); const release = candidate();
  await publishBusinessPack(db, release, { publishedBy: 'process:isolated-proof' });
  const pinned = await new PackRepository(db).loadActivePack(release.manifest.tenantId, 'test');
  const publicationEvents = db.dump('outbox_events').length;
  const model = new ModelGateway(); const messages: any[] = [];
  model.mockAgentExecutor = async request => { messages.push(request.messages); return { content: 'We can continue planning your laundry.', toolCalls: [] }; };
  const before = { ...process.env }; const connect = MongoClient.prototype.connect; let connectionAttempts = 0;
  MongoClient.prototype.connect = async function () { connectionAttempts++; throw new Error('Ambient storage must never be opened'); };
  process.env.MONGODB_URI = 'mongodb://production.invalid/real'; process.env.NODE_ENV = 'production'; process.env.CATALOGUE_INDEX = 'true';
  try {
    const runtime = createIsolatedEvaluationRuntime(pinned, db, { model });
    for (const [index, message] of ['Help plan my laundry', 'Continue with that same project'].entries()) {
      const result = await runtime.executeTurn({ tenantId: release.manifest.tenantId, environmentId: 'test', workspaceId: 'owned-eval', sessionId: 'owned-eval', turnId: `turn-${index}`, correlationId: `corr-${index}`, message } as any, pinned);
      assert.notEqual(result.decision.type, 'fail'); assert.match(String(result.assistantMessage), /laundry/);
    }
    assert.match(JSON.stringify(messages[1]), /Help plan my laundry/);
    assert.equal(connectionAttempts, 0, 'no ambient connection attempt'); assert.equal(db.dump('outbox_events').length, publicationEvents, 'no turn event leaked into publication storage'); assert.equal(process.env.MONGODB_URI, 'mongodb://production.invalid/real');
    await assert.rejects(() => runtime.executeTurn({ tenantId: 'another-tenant', environmentId: 'test' } as any, pinned), /checksum changed/);
    await assert.rejects(() => runtime.executeTurn({ tenantId: release.manifest.tenantId, environmentId: 'production' } as any, pinned), /checksum changed/);
    await assert.rejects(() => runtime.executeTurn({ tenantId: release.manifest.tenantId, environmentId: 'test', customerEvent: { type: 'confirmTool' } } as any, pinned), /cannot approve/);
  } finally {
    MongoClient.prototype.connect = connect;
    for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before);
  }
});

test('a blocking answer suite really runs before publish; failed model output cannot pass on publication/rollback checks alone', async () => {
  for (const answer of ['We can plan this project together.', 'forbidden_fixture_phrase']) {
    const db = new MemoryDb(); const model = new ModelGateway(); let calls = 0; let cleaned = false;
    model.mockAgentExecutor = async () => { calls++; return { content: answer, toolCalls: [] }; };
    const gate = new PublicationGateValidator(async () => ({ db, client: db.client, cleanup: () => { cleaned = true; } }), undefined, (release, storage) => createIsolatedEvaluationRuntime(release, storage, { model }));
    const result = await gate.validateRelease('placemakers', candidate(), '1.0.0');
    assert.equal(result.passed, !answer.includes('forbidden_fixture_phrase'), result.error); assert.ok(calls > 0); assert.equal(cleaned, true);
    assert.equal(result.latestEvalSuiteResult?.suiteId, 'answer-quality');
  }
});
