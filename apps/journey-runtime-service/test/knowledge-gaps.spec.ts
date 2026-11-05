import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { COLLECTION_KNOWLEDGE_GAPS, type KnowledgeGapRecord } from '@journeyax/database';
import { buildPlaceMakersStack, TENANT as PM_TENANT, ENVIRONMENT as PM_ENV } from './helpers/placemakers-stack';
import { buildAbercrombieStack, ABERCROMBIE_TENANT, ABERCROMBIE_ENV } from './helpers/abercrombie-stack';
import { KnowledgeGapRepository } from '../src/kernel/knowledge-gap.repository';
import { executeAgentTool, type AgentToolContext } from '../src/agent/agent-tools';
import { GENERIC_PLATFORM_OPERATING_PROMPT } from '../src/agent/agent-loop';
import { AnalyticsService } from '../../analytics-service/src/analytics.service';
import { ProductGuideRepository } from '../src/kernel/product-guide.repository';
import { ModelGateway } from '../src/kernel/model.gateway';

test('P5: Knowledge Gaps - recording, strict unverified answers, and back office analytics', async (t) => {
  await t.test('1. Platform Rules: Generic instructions enforce strict unverified topic handling', () => {
    // Platform prompt must instruct saying no verified information
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /no verified information/i,
      'platform prompt instructs stating no verified information when knowledge returns nothing'
    );

    // Platform prompt must instruct asking a clarifying question or offering a person
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /clarifying question|offer a person/i,
      'platform prompt instructs asking a clarifying question or offering a person'
    );

    // Platform prompt must prohibit inventing compliance, installation or warranty claims
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /must not invent.*(?:compliance|installation|warranty)/i,
      'platform prompt forbids inventing compliance, installation or warranty claims'
    );
  });

  await t.test('2. KnowledgeGapRepository: Records uncovered topics into knowledge_gaps collection', async () => {
    const db = new MemoryDb();
    const repo = new KnowledgeGapRepository(db);

    const now = new Date();
    await repo.recordGap({
      tenantId: 'placemakers',
      environmentId: 'test',
      topic: 'seismic bracing bracket spacing',
      toolName: 'consult_business_knowledge',
      conversationId: 'ws-pm-gap-1',
      recordedAt: now,
    });

    await repo.recordGap({
      tenantId: 'abercrombie',
      environmentId: 'test',
      topic: 'cashmere wash temperature warranty',
      toolName: 'get_warranty',
      conversationId: 'ws-anf-gap-2',
      recordedAt: now,
    });

    // Check directly in database collection
    const pmGaps = await db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS).find({ tenantId: 'placemakers' }).toArray();
    assert.equal(pmGaps.length, 1);
    assert.equal(pmGaps[0].topic, 'seismic bracing bracket spacing');
    assert.equal(pmGaps[0].toolName, 'consult_business_knowledge');
    assert.equal(pmGaps[0].conversationId, 'ws-pm-gap-1');

    const anfGaps = await db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS).find({ tenantId: 'abercrombie' }).toArray();
    assert.equal(anfGaps.length, 1);
    assert.equal(anfGaps[0].topic, 'cashmere wash temperature warranty');
    assert.equal(anfGaps[0].toolName, 'get_warranty');
    assert.equal(anfGaps[0].conversationId, 'ws-anf-gap-2');

    // Check count and list methods
    assert.equal(await repo.countGaps('placemakers'), 1);
    assert.equal(await repo.countGaps('abercrombie'), 1);
    assert.equal(await repo.countGaps('other-tenant'), 0);
  });

  await t.test('3. Tool Execution: consult_business_knowledge, search_guides, and get_warranty record gaps on missing data', async () => {
    const db = new MemoryDb();
    const repo = new KnowledgeGapRepository(db);

    const baseCtx: AgentToolContext = {
      tenantId: PM_TENANT,
      environmentId: PM_ENV,
      workspaceId: 'ws-gap-tools-1',
      correlationId: 'corr-gap-tools-1',
      release: {
        manifest: { packId: 'pm-pack', schemaVersion: '1.0.0', tenantId: PM_TENANT, environmentId: PM_ENV, version: '1.0.0' },
        capabilities: { toolDefinitions: [], toolBindings: [] },
      } as any,
      okfContent: {
        concepts: [],
        sources: [],
        evidenceChunks: [],
        relationships: [],
        verifications: [],
      } as any,
      catalogSearchHandler: { execute: async () => ({ products: [], total: 0 }) } as any,
      turnProductSkus: new Set(),
      catalogProductCache: new Map([['fixture-unverified-warranty', { sku: 'fixture-unverified-warranty', title: 'Fixture product with no warranty on file' }]]),
      readSourceIds: new Set(),
      allowedClaimClasses: new Set(),
      presentedCards: [],
      isHumanHandoffRequested: false,
      knowledgeGapRepo: repo,
      productGuideRepo: ProductGuideRepository.forTest(),
    };

    // 1. consult_business_knowledge on uncovered topic
    const knowRes = await executeAgentTool('consult_business_knowledge', { topic: 'carbon fiber joist spans' }, baseCtx);
    assert.equal(knowRes.found, false);

    // 2. search_guides on uncovered topic
    const guideRes = await executeAgentTool('search_guides', { query: 'submarine timber piling installation' }, baseCtx);
    assert.equal(guideRes.found, false);
    assert.equal(guideRes.count, 0);

    // A known product and an available empty guide store prove missing terms.
    // An unidentified product or an unreachable store is not that proof.
    const warrRes = await executeAgentTool('get_warranty', { productOrBrand: 'fixture-unverified-warranty' }, baseCtx);
    assert.equal(warrRes.found, false);
    assert.equal(warrRes.sourceStatus, 'available');
    assert.equal(warrRes.warranty.status, 'terms_not_on_file');

    // Verify all 3 gaps were recorded in DB
    const recorded = await db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS).find({ tenantId: PM_TENANT }).toArray();
    assert.equal(recorded.length, 3);

    const topics = recorded.map((r) => r.topic);
    assert.ok(topics.includes('carbon fiber joist spans'));
    assert.ok(topics.includes('submarine timber piling installation'));
    assert.ok(topics.includes('fixture-unverified-warranty'));
  });

  await t.test('Source failures and partial guide reads are not recorded as missing warranty knowledge', async () => {
    const db = new MemoryDb(); const repo = new KnowledgeGapRepository(db);
    const product = { sku: 'fixture-outage-product', title: 'Fixture product' };
    for (const productGuideRepo of [new ProductGuideRepository(async () => { throw new Error('Explicit isolated source unavailable'); }), { readForProducts: async () => ({ guides: [], status: 'partial' }) }]) {
      const ctx: any = { tenantId: PM_TENANT, environmentId: PM_ENV, workspaceId: 'ws-source-outage', correlationId: 'source-outage', release: { extensions: {} }, okfContent: { concepts: [], sources: [], evidenceChunks: [], relationships: [], verifications: [] }, catalogSearchHandler: { execute: async () => { throw new Error('No source fallback may run for a cached product'); } }, catalogProductCache: new Map([[product.sku, product]]), turnProductSkus: new Set(), readSourceIds: new Set(), allowedClaimClasses: new Set(), productGuideRepo, knowledgeGapRepo: repo };
      const response = await executeAgentTool('get_warranty', { productOrBrand: product.sku }, ctx);
      assert.ok(['partial', 'unavailable'].includes(response.sourceStatus));
      assert.equal(response.warranty.status, 'source_unavailable');
      assert.equal(await repo.countGaps(PM_TENANT), 0, 'a failed source check must not become missing-terms evidence');
    }
  });

  await t.test('4. Tenant 1 (PlaceMakers): Agent answers unverified topic with strict honesty and records gap', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({
      servePacks: true,
    });

    const command = {
      tenantId: PM_TENANT,
      environmentId: PM_ENV,
      workspaceId: 'ws-pm-gap-turn-1',
      sessionId: 'sess-pm-gap-1',
      turnId: 'turn-pm-gap-1',
      message: 'How do I install quantum fusion reactors in my basement?',
      correlationId: 'corr-pm-gap-1',
      principalId: 'builder-dan',
      timestamps: { receivedAt: new Date().toISOString() },
    };

    const result = await service.executeTurn(command as any);
    const reply = result.assistantMessage || '';

    // Verify the AI states it has no verified info / defers to specialist, and invents no claims
    assert.match(
      reply,
      /no verified information/i,
      `AI must state no verified information on uncovered guide: ${reply}`
    );
    assert.match(
      reply,
      /specialist|clarify|details/i,
      `AI must offer person or ask clarifying question: ${reply}`
    );
    assert.doesNotMatch(reply, /100% compliant/i, 'AI must not invent compliance claims');
    assert.doesNotMatch(reply, /guaranteed to hold/i, 'AI must not invent structural claims');

    // Verify knowledge gap recorded in the shared database
    const gaps = await stack.db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS).find({ tenantId: PM_TENANT }).toArray();
    assert.ok(gaps.length >= 1, 'Expected at least 1 knowledge gap recorded for PlaceMakers');
    assert.ok(gaps.some((g) => g.conversationId === 'ws-pm-gap-turn-1'));
  });

  await t.test('5. Tenant 2 (Abercrombie): Agent answers unverified warranty with strict honesty and records gap', async () => {
    const stack = await buildAbercrombieStack();
    const model = new ModelGateway();
    model.mockAgentExecutor = async request => {
      const result = request.messages.find(message => message.role === 'tool' && message.name === 'get_warranty');
      if (!result) return { content: '', toolCalls: [{ id: 'isolated-warranty-read', name: 'get_warranty', arguments: { productOrBrand: 'ANF-HOODIE-BLK' } }] };
      const evidence = JSON.parse(String(result.content));
      assert.equal(evidence.sourceStatus, 'available');
      assert.equal(evidence.warranty.status, 'terms_not_on_file');
      return { content: 'I have no verified information on the warranty terms for that hoodie. Would you like me to connect you with our store team to check?', toolCalls: [] };
    };
    const service = stack.serviceFor({ modelGateway: model });

    const command = {
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId: 'ws-anf-gap-turn-2',
      sessionId: 'sess-anf-gap-2',
      turnId: 'turn-anf-gap-2',
      message: 'What is the lifetime warranty coverage on ANF-HOODIE-BLK?',
      correlationId: 'corr-anf-gap-2',
      principalId: 'shopper-alex',
      timestamps: { receivedAt: new Date().toISOString() },
    };

    const result = await service.executeTurn(command as any);
    const reply = result.assistantMessage || '';

    // Verify the AI states no verified info and asks clarifying question or offers human contact
    assert.match(
      reply,
      /no verified information/i,
      `AI must state no verified information on uncovered warranty: ${reply}`
    );
    assert.match(
      reply,
      /store team|specialist|connect|clarify/i,
      `AI must offer person or ask clarifying question: ${reply}`
    );
    assert.doesNotMatch(reply, /lifetime replacement/i, 'AI must not fabricate warranty terms');

    // Verify knowledge gap recorded in the shared database
    const gaps = await stack.db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS).find({ tenantId: ABERCROMBIE_TENANT }).toArray();
    assert.ok(gaps.length >= 1, 'Expected at least 1 knowledge gap recorded for Abercrombie');
    assert.ok(gaps.some((g) => g.conversationId === 'ws-anf-gap-turn-2'));
  });

  await t.test('6. Back Office Analytics: Shows knowledge gaps count and lists uncovered topics for authors', async () => {
    const db = new MemoryDb();
    const now = new Date();

    // Seed knowledge gaps for PlaceMakers
    await db.collection(COLLECTION_KNOWLEDGE_GAPS).insertMany([
      {
        tenantId: PM_TENANT,
        tenant: PM_TENANT,
        environmentId: PM_ENV,
        topic: 'underfloor insulation acoustic ratings',
        toolName: 'consult_business_knowledge',
        conversationId: 'ws-pm-101',
        recordedAt: now,
        time: now.toISOString(),
      },
      {
        tenantId: PM_TENANT,
        tenant: PM_TENANT,
        environmentId: PM_ENV,
        topic: 'slate roofing hook installation guide',
        toolName: 'search_guides',
        conversationId: 'ws-pm-102',
        recordedAt: now,
        time: now.toISOString(),
      },
    ]);

    // Seed knowledge gaps for Abercrombie
    await db.collection(COLLECTION_KNOWLEDGE_GAPS).insertMany([
      {
        tenantId: ABERCROMBIE_TENANT,
        tenant: ABERCROMBIE_TENANT,
        environmentId: ABERCROMBIE_ENV,
        topic: 'leather motorcycle jacket waterproofing warranty',
        toolName: 'get_warranty',
        conversationId: 'ws-anf-201',
        recordedAt: now,
        time: now.toISOString(),
      },
    ]);

    const analyticsService = new AnalyticsService(db as any);

    // 1. Insights payload for PlaceMakers shows knowledgeGapsCount = 2
    const pmInsights = await analyticsService.computeInsights(PM_TENANT, { environmentId: PM_ENV });
    assert.equal(pmInsights.knowledgeGapsCount, 2);
    assert.equal(pmInsights.knowledgeGaps, 2);

    // 2. Insights payload for Abercrombie shows knowledgeGapsCount = 1 (strict tenant isolation)
    const anfInsights = await analyticsService.computeInsights(ABERCROMBIE_TENANT, { environmentId: ABERCROMBIE_ENV });
    assert.equal(anfInsights.knowledgeGapsCount, 1);
    assert.equal(anfInsights.knowledgeGaps, 1);

    // 3. Authors endpoint getKnowledgeGaps returns list of gaps to fill
    const pmGapReport = await analyticsService.getKnowledgeGaps(PM_TENANT, { environmentId: PM_ENV });
    assert.equal(pmGapReport.total, 2);
    assert.equal(pmGapReport.gaps.length, 2);
    assert.ok(pmGapReport.gaps.some((g: any) => g.topic === 'underfloor insulation acoustic ratings'));
    assert.ok(pmGapReport.gaps.some((g: any) => g.topic === 'slate roofing hook installation guide'));

    const anfGapReport = await analyticsService.getKnowledgeGaps(ABERCROMBIE_TENANT, { environmentId: ABERCROMBIE_ENV });
    assert.equal(anfGapReport.total, 1);
    assert.equal(anfGapReport.gaps[0].topic, 'leather motorcycle jacket waterproofing warranty');
    assert.equal(anfGapReport.gaps[0].toolName, 'get_warranty');
  });
});
