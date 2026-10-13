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
import { TurnInterpreter } from '../src/turn/interpret-event';
import { OutcomeValidator } from '../src/turn/validate-outcome';
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

class JourneyFlowGateway extends ModelGateway {
  async execute(_release: any, request: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    let content = 'I have used the verified journey state and authoritative capability result.';
    if (request.taskType === 'fast_intent' && request.prompt.includes('<customer_message>')) {
      const message = request.prompt.match(/<customer_message>\s*([\s\S]*?)\s*<\/customer_message>/i)?.[1]?.trim().toLowerCase() || '';
      const candidateFacts: Record<string, any> = {};
      let intent = 'continue_journey';
      if (message.includes('laundry')) {
        candidateFacts.room_type = { value: 'laundry', confidence: 1 };
        intent = 'laundry_project';
      }
      if (message.includes('renovation')) candidateFacts.project_scope = { value: 'renovation', confidence: 1 };
      if (message.includes('3x2')) candidateFacts.room_dimensions = { value: '3x2 m', confidence: 1 };
      if (message.includes('front loader')) candidateFacts.appliance_layout = { value: 'front-loader', confidence: 1 };
      if (message.includes('laundry-001')) candidateFacts.selected_sku = { value: 'LAUNDRY-001', confidence: 1 };
      if (message.includes('warranty')) intent = 'warranty';
      if (message.includes('install')) intent = 'installation';
      content = JSON.stringify({ intent, candidateFacts });
    }
    return {
      content,
      route: {
        policyId: request.taskType,
        provider: 'custom',
        model: 'deterministic-journey-flow',
        dataResidency: 'test',
        timeoutMs: 1000,
      },
      latencyMs: 1,
      residencyProven: true,
      residencyEvidence: 'isolated-test-adapter',
    };
  }
}

function addLaundryJourneyKnowledge(content: any): any {
  const clone = (value: any) => JSON.parse(JSON.stringify(value));
  const project = clone(content.concepts.find((entry: any) => entry.conceptId.endsWith('/projects/bathroom')));
  Object.assign(project, {
    conceptId: 'concept://placemakers/projects/laundry',
    name: 'Laundry project',
    description: 'Merchant-authored laundry planning journey.',
    synonyms: ['laundry renovation'],
    customerPhrases: ['help with my laundry'],
    journeyRef: { journeyId: 'journey_laundry', entryStageId: 'stage_intake' },
  });
  project.contentHash = computeKnowledgeEntityHash(project);

  const product = clone(content.concepts.find((entry: any) => entry.conceptId.endsWith('/fastenings/wood-screws')));
  Object.assign(product, {
    conceptId: 'concept://placemakers/laundry/cabinet',
    name: 'Laundry cabinet',
    description: 'A catalog-backed laundry cabinet family.',
    synonyms: ['laundry cabinetry'],
    customerPhrases: ['laundry cabinet'],
    type: 'product_family',
    lens: 'product',
    journeyRef: { journeyId: 'journey_laundry' },
    requiredFacts: [],
    discriminators: [],
    searchScope: { catalogCategoryIds: ['laundry.cabinets'], enrichmentFacets: [], excludeCategoryIds: [] },
  });
  product.contentHash = computeKnowledgeEntityHash(product);

  const documentConcept = clone(product);
  Object.assign(documentConcept, {
    conceptId: 'concept://placemakers/documents/laundry-cabinet',
    name: 'Laundry cabinet documents',
    description: 'Verified warranty and installation documents for the cabinet family.',
    synonyms: [],
    customerPhrases: [],
    type: 'document_family',
    lens: 'care',
    journeyRef: undefined,
    searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
  });
  delete documentConcept.journeyRef;
  documentConcept.contentHash = computeKnowledgeEntityHash(documentConcept);

  const relationship: any = {
    relationshipId: 'rel-laundry-cabinet-documents',
    from: product.conceptId,
    to: documentConcept.conceptId,
    type: 'document_for',
    strength: 'required',
    scope: 'family',
    confidence: 'high',
    sourceRefs: ['src-trade-guide'],
    verificationRef: 'verify-laundry-cabinet-documents',
    claimClasses: ['warranty', 'installation_step'],
  };
  relationship.contentHash = computeKnowledgeEntityHash(relationship);

  const warrantyChunk: any = {
    chunkId: 'chunk-laundry-warranty',
    sourceRef: 'src-trade-guide',
    conceptIds: [product.conceptId],
    claimClasses: ['warranty'],
    title: 'Verified laundry cabinet warranty',
    content: 'Show warranty for the laundry cabinet: the verified manufacturer warranty applies under its published terms.',
    applicability: { scope: 'family', refs: ['laundry-cabinet'] },
    ordinal: 0,
  };
  warrantyChunk.contentHash = computeKnowledgeEntityHash(warrantyChunk);
  const installationChunk: any = {
    chunkId: 'chunk-laundry-installation',
    sourceRef: 'src-trade-guide',
    conceptIds: [product.conceptId],
    claimClasses: ['installation_step'],
    title: 'Verified laundry cabinet installation guide',
    content: 'Show installation guide for the laundry cabinet: follow the verified manufacturer fixing sequence.',
    applicability: { scope: 'family', refs: ['laundry-cabinet'] },
    ordinal: 1,
  };
  installationChunk.contentHash = computeKnowledgeEntityHash(installationChunk);

  content.concepts.push(project, product, documentConcept);
  content.relationships.push(relationship);
  content.verifications.push({
    recordId: 'verify-laundry-cabinet-documents',
    targetType: 'relationship',
    targetId: relationship.relationshipId,
    status: 'verified',
    sourceRefs: ['src-trade-guide'],
    verifiedBy: 'merchant-product-expert',
    verifierRole: 'product_manager',
    verifiedAt: '2026-10-01T00:00:00.000Z',
    contentHash: relationship.contentHash,
    staleAfter: '2027-10-01T00:00:00.000Z',
  });
  content.evidenceChunks.push(warrantyChunk, installationChunk);
  return content;
}

function buildLaundryJourneyPack(knowledgeModel: any): any {
  const toolIds = ['catalog.search', 'cart.snapshot', 'knowledge.search'];
  const pack = buildCanonicalPackContent({
    tenantId: 'placemakers',
    environmentId: 'test',
    version: '4.1.0',
    journeyId: 'journey_laundry',
    stageIds: ['stage_intake', 'stage_recommendations', 'stage_selection', 'stage_cart', 'stage_warranty', 'stage_installation', 'stage_checkout'],
    capabilities: {
      toolDefinitions: [
        { toolId: 'catalog.search', sideEffect: 'read', risk: 'low', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, outputSchema: {} },
        { toolId: 'cart.snapshot', sideEffect: 'read', risk: 'low', inputSchema: { properties: { selectedSku: { type: 'string' } }, required: ['selectedSku'] }, outputSchema: {} },
        { toolId: 'knowledge.search', sideEffect: 'read', risk: 'low', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, outputSchema: {} },
      ],
      toolBindings: [
        { toolId: 'catalog.search', environmentId: 'test', executor: { type: 'native_capability', nativeHandler: 'catalog.search' }, outputFactMapping: { catalog_results: 'products' } },
        { toolId: 'cart.snapshot', environmentId: 'test', executor: { type: 'native_capability', nativeHandler: 'cart.snapshot' }, inputMapping: { selectedSku: 'selected_sku' }, outputFactMapping: { cart_snapshot: 'cart' } },
        { toolId: 'knowledge.search', environmentId: 'test', executor: { type: 'native_capability', nativeHandler: 'knowledge.search' } },
      ],
      stageBindings: [],
    },
  });
  pack.knowledgeModel = knowledgeModel;
  pack.routingPolicy = { defaultJourneyId: 'journey_laundry', fallbackOnCatalogSearch: true };
  pack.conversationPolicy.maxClarificationQuestionsPerTurn = 3;
  pack.vocabulary.slotQuestions = {
    ...pack.vocabulary.slotQuestions,
    room_type: { text: 'Which room are you planning?', options: ['laundry', 'bathroom'] },
    project_scope: { text: 'Is this a renovation, new build, or repair?', options: ['renovation', 'new build', 'repair'] },
    room_dimensions: { text: 'What are the room dimensions?', inputType: 'measurement' },
    appliance_layout: { text: 'Which appliance layout do you have?', options: ['front-loader', 'top-loader', 'stacked'] },
    selected_sku: { text: 'Which verified product would you like to add?', inputType: 'text' },
  };
  pack.experience.cards.allowedCardTypes = ['clarify', 'products', 'cart', 'warranty', 'guide'];
  pack.journeys = [{
    journeyId: 'journey_laundry',
    version: '1.0.0',
    displayName: 'Laundry planning and purchase',
    goals: ['Plan a laundry project and prepare verified products for checkout'],
    triggerIntents: ['laundry_project'],
    initialStage: 'stage_intake',
    stages: {
      stage_intake: {
        stageId: 'stage_intake', displayName: 'Project discovery', allowedCapabilities: [], nextDecisionPolicy: 'dependency-first',
        requiredFacts: ['room_type', 'project_scope', 'room_dimensions', 'appliance_layout'],
        exitConditions: [{ allFactsPresent: ['room_type', 'project_scope', 'room_dimensions', 'appliance_layout'], nextStage: 'stage_recommendations' }],
      },
      stage_recommendations: {
        stageId: 'stage_recommendations', displayName: 'Verified recommendations', requiredFacts: [], allowedCapabilities: ['catalog.search'], nextDecisionPolicy: 'capability-first',
        capabilityPlan: [{ toolId: 'catalog.search', producesFacts: ['catalog_results'] }],
        exitConditions: [{ allFactsPresent: ['catalog_results'], nextStage: 'stage_selection' }],
      },
      stage_selection: {
        stageId: 'stage_selection', displayName: 'Product selection', requiredFacts: ['selected_sku'], allowedCapabilities: [], nextDecisionPolicy: 'dependency-first',
        exitConditions: [{ allFactsPresent: ['selected_sku'], nextStage: 'stage_cart' }],
      },
      stage_cart: {
        stageId: 'stage_cart', displayName: 'Authoritative cart', requiredFacts: ['selected_sku'], allowedCapabilities: ['cart.snapshot'], nextDecisionPolicy: 'capability-first',
        capabilityPlan: [{ toolId: 'cart.snapshot', producesFacts: ['cart_snapshot'] }],
        exitConditions: [{ allFactsPresent: ['cart_snapshot'], nextStage: 'stage_warranty' }],
      },
      stage_warranty: {
        stageId: 'stage_warranty', displayName: 'Warranty evidence', requiredFacts: [], allowedCapabilities: ['knowledge.search'], nextDecisionPolicy: 'capability-first',
        capabilityPlan: [{ toolId: 'knowledge.search', producesFacts: ['warranty_verified'] }],
        exitConditions: [{ allFactsPresent: ['warranty_verified'], nextStage: 'stage_installation' }],
      },
      stage_installation: {
        stageId: 'stage_installation', displayName: 'Installation evidence', requiredFacts: [], allowedCapabilities: ['knowledge.search'], nextDecisionPolicy: 'capability-first',
        capabilityPlan: [{ toolId: 'knowledge.search', producesFacts: ['installation_verified'] }],
        exitConditions: [{ allFactsPresent: ['installation_verified'], nextStage: 'stage_checkout' }],
      },
      stage_checkout: {
        stageId: 'stage_checkout', displayName: 'Secure checkout handoff', requiredFacts: [], allowedCapabilities: [], nextDecisionPolicy: 'dependency-first', exitConditions: [],
      },
    },
  }];
  assert.deepEqual(pack.capabilities.toolDefinitions.map((entry: any) => entry.toolId), toolIds);
  return pack;
}

function buildLaundryJourneyService(pack: any, db: MemoryDb, releaseId: string) {
  const modelGateway = new JourneyFlowGateway();
  const capabilityGateway = new CapabilityGateway();
  capabilityGateway.registerCustomAdapter('catalog.search', {
    execute: async () => ({
      products: [{ sku: 'LAUNDRY-001', name: 'Verified laundry cabinet', description: 'Catalog-backed cabinet option.', priceCents: 129900, currency: 'NZD' }],
      currency: 'NZD',
    }),
  });
  capabilityGateway.registerCustomAdapter('cart.snapshot', {
    execute: async ({ selectedSku }: any) => ({
      cart: {
        cartId: 'CART-LAUNDRY-1',
        items: [{ sku: selectedSku, title: 'Verified laundry cabinet', quantity: 1, priceCents: 129900 }],
        totals: { subtotal: 1299, total: 1299, currency: 'NZD' },
      },
    }),
  });
  capabilityGateway.registerCustomAdapter('knowledge.search', new KnowledgeSearchHandler([
    { id: 'warranty-doc', sourceId: 'src-trade-guide', releaseId, title: 'Verified laundry cabinet warranty', content: 'Show warranty for the laundry cabinet: the verified manufacturer warranty applies under its published terms.' },
    { id: 'installation-doc', sourceId: 'src-trade-guide', releaseId, title: 'Verified laundry cabinet installation guide', content: 'Show installation guide for the laundry cabinet: follow the verified manufacturer fixing sequence.' },
  ]));
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
    new TurnInterpreter(modelGateway),
    undefined,
    new OutcomeValidator(),
    new OkfKnowledgeControlPlane(async () => db as any)
  );
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
    new TurnInterpreter(modelGateway),
    undefined,
    new OutcomeValidator(),
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

  await test('a broad query scopes catalog retrieval and asks the merchant-authored question first; asking to see them shows the scoped examples', async () => {
    const products = [
      { projectId: 'placemakers', sku: 'WOOD-001', name: 'Exterior wood screw', categoryId: 'fastenings.wood-screws', category: 'Fastenings Wood Screws', currency: 'NZD', priceCents: 1299 },
      { projectId: 'placemakers', sku: 'DRIVER-001', name: 'Screwdriver set', categoryId: 'tools.screwdrivers', category: 'Tools Screwdrivers', currency: 'NZD', priceCents: 1899 },
    ];
    const service = buildService(buildPack(reference), db, products);
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-okf-broad', sessionId: 'ws-okf-broad',
      turnId: 'turn-okf-broad-1', correlationId: 'corr-okf-broad-1', message: 'screws',
    } as any, buildPack(reference));

    const clarifyCard = result.uiInstructions.find((card) => card.component === 'clarify');
    assert.ok(clarifyCard, 'the merchant\'s question is asked');
    assert.equal(result.uiInstructions.some((card) => card.component === 'products'), false, 'and no product is shown until the customer has had the chance to answer');
    assert.equal((clarifyCard as any).props.questions[0].id, 'substrate');
    assert.match((clarifyCard as any).props.questions[0].text, /fixing.*material/i);
    assert.equal((result.trace as any).knowledgeGate.mode, 'overview_then_ask');
    assert.equal((result.trace as any).conversation.action, 'ask');
    assert.deepEqual((result.trace as any).knowledgeGate.journeyRef, {
      journeyId: 'journey_catalog',
      entryStageId: 'stage_catalog',
    });
    assert.deepEqual((result.trace as any).knowledgeGate.retrieval.excludeCategoryIds, ['tools.screwdrivers']);

    // A customer who would rather look is not asked; the examples are still scoped to the concept.
    const browse = await buildService(buildPack(reference), db, products).executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-okf-broad-2', sessionId: 'ws-okf-broad-2',
      turnId: 'turn-okf-broad-2', correlationId: 'corr-okf-broad-2', message: 'just show me screws',
    } as any, buildPack(reference));
    const productCard = browse.uiInstructions.find((card) => card.component === 'products');
    assert.ok(productCard, 'expected grounded product card');
    assert.deepEqual((productCard as any).props.products.map((product: any) => product.sku), ['WOOD-001']);
    assert.equal(browse.uiInstructions.some((card) => card.component === 'clarify'), false);
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

  await test('required OKF integrity failure closes before catalog retrieval or success cards', async () => {
    const badReference = { ...reference, checksum: 'f'.repeat(64) };
    const service = buildService(buildPack(badReference), db, [
      { projectId: 'placemakers', sku: 'WOOD-001', name: 'Exterior wood screw', categoryId: 'fastenings.screws' },
    ]);
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-okf-fail', sessionId: 'ws-okf-fail',
      turnId: 'turn-okf-fail-1', correlationId: 'corr-okf-fail-1', message: 'screws',
    } as any, buildPack(badReference));

    assert.equal(result.decision.type, 'fail');
    assert.equal(result.uiInstructions.length, 0);
    assert.equal((result.trace as any).knowledgeGate.mode, 'knowledge_unavailable');
    assert.ok((result.trace as any).knowledgeGate.trace.reasonCodes.includes('knowledge_required_unavailable'));
    assert.deepEqual((result.trace as any).knowledgeGate.trace.reasonCodes.filter((code: string) => code.startsWith('knowledge_load_error')), ['knowledge_load_error']);
  });

  await test('safety-sensitive problem renders verified guidance while blocking product retrieval and commerce cards', async () => {
    const service = buildService(buildPack(reference), db, [
      { projectId: 'placemakers', sku: 'LEAK-001', name: 'Unverified leak product', category: 'General', currency: 'AUD' },
    ]);
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-okf-safety', sessionId: 'ws-okf-safety',
      turnId: 'turn-okf-safety-1', correlationId: 'corr-okf-safety-1', message: 'my bathroom is leaking',
    } as any, buildPack(reference));

    assert.equal((result.trace as any).knowledgeGate.mode, 'safety_then_diagnose');
    assert.equal((result.trace as any).knowledgeGate.retrieval.permission, 'blocked');
    assert.equal((result.trace as any).diagnostics.retrievalExecuted, false);
    assert.equal(result.uiInstructions.some((card) => card.component === 'products'), false);
    const guide = result.uiInstructions.find((card) => card.component === 'guide');
    assert.ok(guide, 'expected verified safety guide card');
    assert.match((guide as any).props.sections[0].body, /turn off the water supply/i);
    assert.match((guide as any).props.sections[0].steps[0], /verified trade guide/i);
    assert.match(result.assistantMessage, /qualified professional/i);
    assert.equal(result.decision.type, 'complete_goal');
  });

  await test('evidence answer uses the exact pinned OKF source and renders a verified guide card', async () => {
    const pack = buildPack(reference, 'knowledge.search');
    const service = buildService(pack, db, [], [{
      id: 'doc-trade-guide',
      sourceId: 'src-trade-guide',
      releaseId: okfRelease.releaseId,
      title: 'Verified matte black tapware care guide',
      content: 'Cleaner for matte black tapware: follow the manufacturer care method in this verified guide.',
      sourceUrl: 'https://merchant.invalid/trade-guide.pdf',
    }]);
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-okf-evidence', sessionId: 'ws-okf-evidence',
      turnId: 'turn-okf-evidence-1', correlationId: 'corr-okf-evidence-1', message: 'cleaner for matte black tapware',
    } as any, pack);

    assert.equal((result.trace as any).knowledgeGate.mode, 'evidence_answer');
    assert.deepEqual((result.trace as any).knowledgeGate.evidence.sourceRefs, ['src-trade-guide']);
    assert.equal((result.trace as any).diagnostics.retrievalExecuted, true);
    const guide = result.uiInstructions.find((card) => card.component === 'guide');
    assert.ok(guide, 'expected verified evidence guide card');
    assert.match((guide as any).props.sections[0].body, /manufacturer care method/i);
    assert.equal(result.executedCapabilities[0].output.results[0].sourceId, 'src-trade-guide');
    assert.equal(result.executedCapabilities[0].output.results[0].releaseId, okfRelease.releaseId);
  });

  await test('packs without a knowledgeModel preserve the legacy canonical runtime path', async () => {
    const pack = buildPack(undefined);
    const service = buildService(pack, db, [
      { projectId: 'placemakers', sku: 'LEGACY-001', name: 'Legacy catalog item', category: 'General', currency: 'AUD' },
    ]);
    const result = await service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-no-okf', sessionId: 'ws-no-okf',
      turnId: 'turn-no-okf-1', correlationId: 'corr-no-okf-1', message: 'catalog item',
    } as any, pack);
    assert.equal((result.trace as any).knowledgeGate, undefined);
    assert.ok(result.uiInstructions.some((card) => card.component === 'products'));
  });

  await test('one workspace preserves project context through products, cart, sourced aftercare, and checkout handoff', async () => {
    const flowDb = new MemoryDb();
    const flowRelease = await publishOkfRelease(flowDb as any, {
      releaseId: 'okf-placemakers-laundry-1.0.0',
      tenantId: 'placemakers',
      environmentId: 'test',
      version: '1.0.0',
      content: addLaundryJourneyKnowledge(buildOkfContent() as any),
      publishedBy: 'journey-flow-test',
    });
    const flowReference = {
      type: 'okf_release', releaseId: flowRelease.releaseId, version: flowRelease.version,
      checksum: flowRelease.checksum, required: true, failurePolicy: 'fail_closed',
    };
    const pack = buildLaundryJourneyPack(flowReference);
    const service = buildLaundryJourneyService(pack, flowDb, flowRelease.releaseId);
    const common = {
      tenantId: 'placemakers', environmentId: 'test', workspaceId: 'ws-laundry-e2e', sessionId: 'ws-laundry-e2e',
    } as const;
    const turn = (number: number, message: string) => service.executeTurn({
      ...common,
      turnId: `turn-laundry-${number}`,
      correlationId: `corr-laundry-${number}`,
      message,
    } as any, pack);

    const discovery = await turn(1, 'I need help with my laundry');
    assert.equal(discovery.decision.type, 'ask_fact');
    assert.equal(discovery.workspace.facts.room_type.value, 'laundry');
    assert.equal(discovery.workspace.knowledgeContext?.conceptId, 'concept://placemakers/projects/laundry');
    assert.ok(discovery.uiInstructions.some((card) => card.component === 'clarify'));

    const recommendations = await turn(2, 'It is a renovation, 3x2 m, with a front loader');
    assert.equal(recommendations.workspace.facts.room_type.value, 'laundry', 'known room context must survive');
    assert.equal(recommendations.workspace.currentStage, 'stage_selection');
    assert.equal((recommendations.trace as any).knowledgeGate.trace.matchedBy, 'pending_clarification');
    assert.ok(recommendations.uiInstructions.some((card) => card.component === 'products'));
    assert.ok(recommendations.uiInstructions.some((card) => card.component === 'clarify'));

    const cart = await turn(3, 'Use LAUNDRY-001 and show my cart');
    assert.equal(cart.workspace.currentStage, 'stage_warranty');
    assert.equal(cart.workspace.facts.room_type.value, 'laundry');
    assert.ok(cart.uiInstructions.some((card) => card.component === 'cart'), 'cart card must survive same-turn stage advancement');

    const warranty = await turn(4, 'Show warranty for the laundry cabinet');
    assert.equal(warranty.workspace.currentStage, 'stage_installation');
    assert.ok(warranty.uiInstructions.some((card) => card.component === 'warranty'), 'warranty card must use pinned verified evidence');
    assert.deepEqual((warranty.trace as any).knowledgeGate.evidence.sourceRefs, ['src-trade-guide']);

    const installation = await turn(5, 'Show installation guide for the laundry cabinet');
    assert.equal(installation.workspace.currentStage, 'stage_checkout');
    assert.ok(installation.uiInstructions.some((card) => card.component === 'guide'), 'installation guide must survive transition to checkout');
    assert.equal(installation.workspace.facts.room_type.value, 'laundry');
    assert.equal(installation.workspace.facts.project_scope.value, 'renovation');
    assert.equal(installation.workspace.facts.room_dimensions.value, '3x2 m');
  });

  // ── Uncovered requests through a full turn: what the customer actually receives ──────────────────────────────
  const OPEN_COVERAGE = { coverage: { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } } };
  const uncoveredProducts = [
    { projectId: 'placemakers', sku: 'PB-1', name: 'Paint Brush Synthetic 50mm', category: 'Brushes', currency: 'NZD', priceCents: 1299 },
    { projectId: 'placemakers', sku: 'H-1', name: 'Fan Heater 2kW', category: 'Heaters', currency: 'NZD', priceCents: 8900 },
  ];
  async function uncoveredTurn(policy: unknown, message: string, id: string) {
    const coverageDb = new MemoryDb();
    const withPolicy = structuredClone(content);
    if (policy) (withPolicy as any).policy = policy;
    const coverageRelease = await publishOkfRelease(coverageDb as any, {
      releaseId: `okf-coverage-${id}`, tenantId: 'placemakers', environmentId: 'test', version: '1.0.0', content: withPolicy, publishedBy: 'runtime-integration-test',
    });
    const coverageRef = { ...reference, releaseId: coverageRelease.releaseId, version: coverageRelease.version, checksum: coverageRelease.checksum };
    const pack = buildPack(coverageRef);
    const service = buildService(pack, coverageDb, uncoveredProducts);
    return service.executeTurn({
      tenantId: 'placemakers', environmentId: 'test', workspaceId: `ws-${id}`, sessionId: `ws-${id}`,
      turnId: `turn-${id}`, correlationId: `corr-${id}`, message,
    } as any, pack);
  }
  const cardTypes = (result: any) => result.uiInstructions.map((card: any) => card.component);

  await test('end to end: "my heater is smoking" escalates with no product, cart or checkout card, even when shopping is open', async () => {
    const result: any = await uncoveredTurn(OPEN_COVERAGE, 'my heater is smoking', 'hazard');
    assert.equal(result.trace.knowledgeGate.mode, 'safety_then_diagnose');
    assert.ok(result.trace.knowledgeGate.trace.reasonCodes.includes('uncovered_problem'));
    for (const forbidden of ['products', 'cart', 'quote', 'productDetail', 'bundle']) {
      assert.ok(!cardTypes(result).includes(forbidden), `${forbidden} card must not appear`);
    }
    assert.match(String(result.assistantMessage), /qualified professional/i);
  });

  await test('end to end: an uncovered shopping request is blocked by default', async () => {
    const result: any = await uncoveredTurn(undefined, 'i need some paint brushes', 'closed');
    assert.equal(result.trace.knowledgeGate.mode, 'no_match');
    assert.ok(!cardTypes(result).includes('products'));
  });

  await test('end to end: with the opt-in, uncovered shopping shows live catalogue products only', async () => {
    const result: any = await uncoveredTurn(OPEN_COVERAGE, 'i need some paint brushes', 'open');
    assert.equal(result.trace.knowledgeGate.mode, 'legacy_search');
    assert.ok(result.trace.knowledgeGate.trace.reasonCodes.includes('uncovered_shopping_catalogue_only'));
    const products = result.uiInstructions.find((card: any) => card.component === 'products');
    assert.ok(products, 'a products card is produced from the live catalogue');
    assert.ok(products.props.products.every((item: any) => uncoveredProducts.some((live) => live.sku === item.sku)), 'only live catalogue SKUs');
    assert.equal(products.props.products.find((item: any) => item.sku === 'PB-1').currency, 'NZD');
  });

  await test('end to end: an unknown technical requirement gets neither claims nor products', async () => {
    const result: any = await uncoveredTurn(OPEN_COVERAGE, 'is the fan heater suitable for a workshop', 'technical');
    assert.equal(result.trace.knowledgeGate.mode, 'no_match');
    assert.ok(result.trace.knowledgeGate.trace.reasonCodes.includes('uncovered_technical'));
    assert.ok(!cardTypes(result).includes('products'));
  });

  console.log(`\nCanonical OKF runtime integration: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
