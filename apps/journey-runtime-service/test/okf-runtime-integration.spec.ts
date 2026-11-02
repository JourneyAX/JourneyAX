import assert from 'node:assert/strict';
import { computeKnowledgeEntityHash, publishOkfRelease } from '@journeyax/knowledge';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { PackRepository } from '../src/kernel/pack.repository';
import { WorkspaceRepository } from '../src/kernel/workspace.repository';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { JourneyResolver } from '../src/kernel/journey.resolver';
import {
  ModelGateway,
  type ModelExecutionRequest,
  type ModelExecutionResponse,
} from '../src/kernel/model.gateway';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { KnowledgeSearchHandler } from '../src/capabilities/handlers/knowledge-search.handler';
import { ExecutionRepository } from '../src/kernel/execution.repository';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { PresentationPort } from '../src/kernel/presentation.port';
import { OkfKnowledgeControlPlane, extractExactSku } from '../src/kernel/knowledge-control-plane';
import { buildCanonicalPackContent } from './fixtures/canonical-release.fixture';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';

function matches(doc: any, query: any): boolean {
  return Object.entries(query || {}).every(([key, expected]: [string, any]) => {
    if (key === '$and') return expected.every((clause: any) => matches(doc, clause));
    if (key === '$or') return expected.some((clause: any) => matches(doc, clause));
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(doc[key]);
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (doc[key] !== undefined) === expected.$exists;
    }
    return doc[key] === expected;
  });
}

class MemoryCursor {
  constructor(private docs: any[]) {}
  sort(spec: Record<string, number>) {
    const [key, direction] = Object.entries(spec)[0];
    this.docs.sort((a, b) => ((a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction));
    return this;
  }
  async toArray() { return this.docs.map((doc) => ({ ...doc })); }
}

class MemoryCollection {
  docs: any[] = [];
  async findOne(query: any) { return this.docs.find((doc) => matches(doc, query)) || null; }
  async insertOne(doc: any) { this.docs.push({ ...doc }); return { acknowledged: true }; }
  async insertMany(docs: any[]) { this.docs.push(...docs.map((doc) => ({ ...doc }))); return { acknowledged: true }; }
  find(query: any) { return new MemoryCursor(this.docs.filter((doc) => matches(doc, query))); }
}

class MemoryDb {
  private collections = new Map<string, MemoryCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name)!;
  }
}

class DeterministicGateway extends ModelGateway {
  async execute(_release: any, request: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    const content = request.taskType === 'fast_intent'
      ? JSON.stringify({ intent: 'product_search', candidateFacts: {} })
      : 'Here are verified catalog options. Use the question card to narrow the selection.';
    return {
      content,
      route: {
        policyId: 'test-policy',
        provider: 'custom',
        model: 'deterministic-test-model',
        dataResidency: 'test',
        timeoutMs: 1000,
      },
      latencyMs: 1,
      residencyProven: true,
      residencyEvidence: 'isolated-test-adapter',
    };
  }
}





function buildPack(knowledgeModel?: any, toolId = 'catalog.search'): any {
  const capabilities = {
    toolDefinitions: [{
      toolId,
      sideEffect: 'read',
      risk: 'low',
      inputSchema: { properties: { query: { type: 'string' } } },
      outputSchema: { properties: toolId === 'knowledge.search' ? { results: { type: 'array' } } : { items: { type: 'array' } } },
    }],
    toolBindings: [{
      toolId,
      environmentId: 'test',
      executor: { type: 'native_capability', nativeHandler: toolId },
      outputFactMapping: toolId === 'knowledge.search' ? { knowledge_results: 'results' } : { catalog_results: 'items' },
    }],
    stageBindings: [{
      journeyId: 'journey_catalog',
      stageId: 'stage_catalog',
      tools: [{ toolId }],
    }],
  };
  const pack = buildCanonicalPackContent({
    tenantId: 'placemakers',
    environmentId: 'test',
    version: '4.0.0',
    journeyId: 'journey_catalog',
    stageIds: ['stage_catalog'],
    capabilities,
  });
  pack.routingPolicy = { defaultJourneyId: 'journey_catalog', fallbackOnCatalogSearch: true };
  pack.experience.cards.allowedCardTypes = ['products', 'clarify', 'guide'];
  pack.journeys[0] = {
    journeyId: 'journey_catalog',
    version: '1.0.0',
    displayName: 'Catalog consultation',
    goals: ['Help a customer find suitable catalog items'],
    initialStage: 'stage_catalog',
    stages: {
      stage_catalog: {
        stageId: 'stage_catalog',
        displayName: 'Catalog consultation',
        requiredFacts: [],
        allowedCapabilities: [toolId],
        capabilityPlan: [{ toolId, producesFacts: [toolId === 'knowledge.search' ? 'knowledge_results' : 'catalog_results'] }],
        nextDecisionPolicy: 'capability-first',
        exitConditions: [],
      },
    },
  };
  pack.knowledgeModel = knowledgeModel;
  return pack;
}

function buildService(pack: any, db: MemoryDb, products: any[], knowledgeDocs?: any[], modelGateway = new DeterministicGateway()) {
  const capabilityGateway = new CapabilityGateway();
  capabilityGateway.registerCustomAdapter('catalog.search', new CatalogSearchHandler(products));
  if (knowledgeDocs) {
    capabilityGateway.registerCustomAdapter('knowledge.search', new KnowledgeSearchHandler(knowledgeDocs));
  }
  return new TurnApplicationService(
    new PackRepository(),
    new WorkspaceRepository(new WorkspaceStore({ forceInMemory: true })),
    new JourneyResolver(),
    undefined,
    modelGateway,
    capabilityGateway,
    undefined,
    new ExecutionRepository(),
    new OutboxRepository({ forceInMemory: true }),
    new PresentationPort(modelGateway),
    new OkfKnowledgeControlPlane(async () => db as any)
  );
}

async function main() {
  console.log('🧭 Running canonical OKF runtime integration suite...');
  let passed = 0;
  let failed = 0;
  const test = async (name: string, operation: () => Promise<void>) => {
    try {
      await operation();
      passed++;
      console.log(`  ✅ PASS: ${name}`);
    } catch (error: any) {
      failed++;
      console.error(`  ❌ FAIL: ${name}: ${error.stack || error.message}`);
    }
  };

  const db = new MemoryDb();
  const content = buildOkfContent() as any;
  const screwsConcept = content.concepts.find(
    (concept: any) => concept.conceptId === 'concept://placemakers/fastenings/screws'
  );
  screwsConcept.journeyRef = { journeyId: 'journey_catalog', entryStageId: 'stage_catalog' };
  screwsConcept.contentHash = computeKnowledgeEntityHash(screwsConcept);
  const safetyWoodConcept = content.concepts.find((concept: any) => concept.conceptId === 'concept://placemakers/fastenings/wood-screws');
  safetyWoodConcept.riskClass = 'safety_critical';
  safetyWoodConcept.commercePolicy.checkout = 'blocked';
  safetyWoodConcept.contentHash = computeKnowledgeEntityHash(safetyWoodConcept);
  const okfRelease = await publishOkfRelease(db as any, {
    releaseId: 'okf-placemakers-1.0.0',
    tenantId: 'placemakers',
    environmentId: 'test',
    version: '1.0.0',
    content,
    publishedBy: 'runtime-integration-test',
  });
  const reference = {
    type: 'okf_release',
    modelId: okfRelease.content.modelId,
    releaseId: okfRelease.releaseId,
    version: okfRelease.version,
    checksum: okfRelease.checksum,
    required: true,
    failurePolicy: 'fail_closed',
  };

  await test('exact SKU detection accepts numeric/prefixed product codes and rejects ordinary hyphenated words', async () => {
    assert.equal(extractExactSku('SKU 123456'), '123456');
    assert.equal(extractExactSku('show product AB-12345'), 'AB-12345');
    assert.equal(extractExactSku('I need self-tapping screws'), undefined);
    assert.equal(extractExactSku('damage-free repair kit'), undefined);
    assert.equal(extractExactSku('90x45mm'), undefined);
    assert.equal(extractExactSku('10-year warranty'), undefined);
    assert.equal(extractExactSku('1002486'), '1002486');
  });

  await test('unlabelled numeric SKU is direct only after tenant catalog verification', async () => {
    await db.collection('products').insertOne({ projectId: 'placemakers', sku: '1002486', categoryId: 'fastenings.screws' });
    const plane = new OkfKnowledgeControlPlane(async () => db as any);
    const command = { tenantId: 'placemakers', environmentId: 'test', workspaceId: 'sku-check', sessionId: 'sku-check', correlationId: 'sku-check', message: 'screws 1002486' } as any;
    const interpretation = { intent: 'product_search', candidateFacts: {} } as any;
    assert.equal((await plane.evaluate(buildPack(reference), command, null, interpretation))?.mode, 'direct_results');
    assert.equal((await plane.evaluate(buildPack(reference), { ...command, message: 'screws 9999999' }, null, interpretation))?.mode, 'overview_then_ask');
  });

  await test('a short answer to the pending merchant question stays on the retained concept', async () => {
    const continuation = structuredClone(content);
    const timber = structuredClone(continuation.concepts.find((entry: any) => entry.conceptId.endsWith('/fastenings/wood-screws')));
    timber.conceptId = 'concept://placemakers/materials/timber';
    timber.name = 'Timber';
    timber.description = 'General timber material family.';
    timber.customerPhrases = ['timber'];
    timber.synonyms = [];
    timber.contentHash = computeKnowledgeEntityHash(timber);
    continuation.concepts.push(timber);
    const nextRelease = await publishOkfRelease(db as any, {
      releaseId: 'okf-placemakers-continuity', tenantId: 'placemakers', environmentId: 'test',
      version: '1.0.1', content: continuation, publishedBy: 'runtime-integration-test',
    });
    const nextRef = { ...reference, releaseId: nextRelease.releaseId, version: nextRelease.version, checksum: nextRelease.checksum };
    const retained = {
      knowledgeContext: { releaseId: nextRef.releaseId, checksum: nextRef.checksum,
        conceptId: screwsConcept.conceptId, journeyId: 'journey_catalog', selectedAt: new Date().toISOString() },
      pins: { okfReleaseId: nextRef.releaseId, okfChecksum: nextRef.checksum },
      openQuestions: ['substrate'], facts: {},
    } as any;
    const plane = new OkfKnowledgeControlPlane(async () => db as any);
    const decision = await plane.evaluate(buildPack(nextRef), {
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'continuity',
      sessionId: 'continuity', correlationId: 'continuity', message: 'timber',
    } as any, retained, { intent: 'product_search', candidateFacts: { substrate: { value: 'timber', confidence: 1 } } } as any);
    assert.equal(decision?.conceptId, 'concept://placemakers/fastenings/wood-screws');
    assert.ok(decision?.trace.reasonCodes.includes('clarification_answer_continuity'));
    const switched = await plane.evaluate(buildPack(nextRef), {
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'continuity',
      sessionId: 'continuity', correlationId: 'continuity-switch', message: 'actually I need timber',
    } as any, retained, { intent: 'product_search', candidateFacts: {} } as any);
    assert.equal(switched?.conceptId, 'concept://placemakers/materials/timber', 'an explicit topic switch must still work');
  });

  await test('basket policy uses every tenant-scoped SKU even after an unrelated paint turn', async () => {
    await db.collection('products').insertOne({ projectId: 'placemakers', sku: 'WOOD-001', categoryId: 'fastenings.wood-screws' });
    await db.collection('products').insertOne({ projectId: 'placemakers', sku: 'SCREW-001', categoryId: 'fastenings.screws' });
    const plane = new OkfKnowledgeControlPlane(async () => db as any);
    const command = { tenantId: 'placemakers', environmentId: 'test', workspaceId: 'basket-check', sessionId: 'basket-check', correlationId: 'basket-check', message: 'yes, place the order' } as any;
    const blocked = await plane.evaluateBasket(buildPack(reference), command, null, [{ sku: 'WOOD-001' }, { sku: 'SCREW-001' }]);
    assert.equal(blocked?.commerce.checkout, 'blocked');
    const warning = await plane.evaluateBasket(buildPack(reference), command, null, [{ sku: 'SCREW-001' }]);
    assert.equal(warning?.commerce.addToCart, 'allowed_with_warning');
    assert.ok(warning?.warnings.length);
    const crossTenant = await plane.evaluateBasket(buildPack(reference), command, null, [{ sku: 'OTHER-001' }]);
    assert.equal(crossTenant?.commerce.checkout, 'blocked');
    await db.collection('customer_carts').insertOne({
      projectId: 'placemakers', workspaceId: 'basket-check', cartId: 'cart-basket-check', status: 'active',
      items: [{ sku: 'WOOD-001', quantity: 1 }, { sku: 'SCREW-001', quantity: 2 }],
    });
    const omittedUnsafeSku = await plane.evaluateBasket(
      buildPack(reference), command, null, [{ sku: 'SCREW-001', quantity: 2 }],
      { operation: 'order.commit', cartId: 'cart-basket-check' },
    );
    assert.equal(omittedUnsafeSku?.commerce.checkout, 'blocked');
    assert.ok(omittedUnsafeSku?.reasonCodes.includes('basket_payload_mismatch'));
    const fullCart = await plane.evaluateBasket(
      buildPack(reference), command, null,
      [{ sku: 'WOOD-001', quantity: 1 }, { sku: 'SCREW-001', quantity: 2 }],
      { operation: 'order.commit', cartId: 'cart-basket-check' },
    );
    assert.equal(fullCart?.commerce.checkout, 'blocked', 'persisted safety SKU must govern checkout');
    const missingCart = await plane.evaluateBasket(
      buildPack(reference), { ...command, workspaceId: 'other-workspace' }, null,
      [{ sku: 'SCREW-001', quantity: 2 }],
      { operation: 'order.commit', cartId: 'cart-basket-check' },
    );
    assert.deepEqual(missingCart?.reasonCodes, ['authoritative_cart_unavailable']);
  });

  await test('response generation rejects a warranty claim outside the pinned claim allow-list', async () => {
    class UnsupportedWarrantyGateway extends DeterministicGateway {
      async execute(release: any, request: ModelExecutionRequest): Promise<ModelExecutionResponse> {
        const response = await super.execute(release, request);
        return request.taskType === 'response_generation'
          ? { ...response, content: 'Every screw is guaranteed for 10 years.' }
          : response;
      }
    }
    const pack = buildPack(reference);
    const service = buildService(pack, db, [], undefined, new UnsupportedWarrantyGateway());
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-claim-guard', sessionId: 'ws-claim-guard',
      turnId: 'turn-claim-guard', correlationId: 'corr-claim-guard', message: 'screws',
    } as any, pack);
    assert.doesNotMatch(result.assistantMessage, /guarantee/i);
  });

  // ── Uncovered requests through a full turn: what the customer actually receives ──────────────────────────────

  console.log(`\nCanonical OKF runtime integration: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
