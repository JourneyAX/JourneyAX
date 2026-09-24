import assert from 'node:assert/strict';
import { ProjectService } from '../src/project.service';

async function runProjectPublishingSuite() {
  console.log('🧪 Running Project Service Publishing & Business Pack Compilation Tests...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }

  function createMockProjectService(initialProjects: Record<string, any> = {}) {
    const memoryProjects = new Map<string, any>(Object.entries(initialProjects));
    const memoryVersions: any[] = [];
    const memoryReleases = new Map<string, any>();
    const memoryPointers = new Map<string, any>();
    const memoryOutbox: any[] = [];

    const mockDb: any = {
      collection: (name: string) => {
        if (name === 'tenant_configs') {
          return {
            findOne: async (query: any) => {
              if (query.projectId) {
                return memoryProjects.get(query.projectId) || null;
              }
              return null;
            },
            updateOne: async (query: any, update: any) => {
              const doc = memoryProjects.get(query.projectId);
              if (!doc) return { matchedCount: 0 };
              const updated = { ...doc, ...(update.$set || {}) };
              memoryProjects.set(query.projectId, updated);
              return { matchedCount: 1, modifiedCount: 1 };
            },
            insertOne: async (doc: any) => {
              memoryProjects.set(doc.projectId, doc);
              return { acknowledged: true, insertedId: doc.projectId };
            },
            createIndex: async () => {},
          };
        }
        if (name === 'config_versions') {
          return {
            find: (query: any) => ({
              sort: () => ({
                limit: () => ({
                  toArray: async () => memoryVersions.filter((v) => v.projectId === query.projectId),
                }),
              }),
            }),
            insertOne: async (doc: any) => {
              memoryVersions.push(doc);
              return { acknowledged: true };
            },
            findOne: async (query: any) => {
              return memoryVersions.find((v) => v.projectId === query.projectId && v.version === query.version) || null;
            },
            createIndex: async () => {},
          };
        }
        if (name === 'project_members' || name === 'business_rules') {
          return {
            createIndex: async () => {},
          };
        }
        if (name === 'business_pack_releases') {
          return {
            insertOne: async (doc: any) => {
              const key = `${doc.tenantId}:${doc.environmentId}:${doc.version}`;
              if (memoryReleases.has(key)) {
                const err: any = new Error('E11000 duplicate key error');
                err.code = 11000;
                throw err;
              }
              memoryReleases.set(key, doc);
              return { acknowledged: true, insertedId: key };
            },
            findOne: async (query: any) => {
              const key = `${query.tenantId}:${query.environmentId}:${query.version}`;
              return memoryReleases.get(key) || null;
            },
          };
        }
        if (name === 'business_pack_pointers') {
          return {
            findOne: async (query: any) => {
              const key = `${query.tenantId}:${query.environmentId}`;
              return memoryPointers.get(key) || null;
            },
            insertOne: async (doc: any) => {
              const key = `${doc.tenantId}:${doc.environmentId}`;
              memoryPointers.set(key, doc);
              return { acknowledged: true };
            },
            updateOne: async (query: any, update: any) => {
              const key = `${query.tenantId}:${query.environmentId}`;
              const prev = memoryPointers.get(key);
              if (!prev) return { matchedCount: 0 };
              if (query.revision !== undefined && prev.revision !== query.revision) {
                return { matchedCount: 0 };
              }
              const updated = { ...prev, ...update.$set };
              memoryPointers.set(key, updated);
              return { matchedCount: 1, acknowledged: true };
            },
          };
        }
        if (name === 'outbox_events') {
          return {
            insertOne: async (doc: any) => {
              memoryOutbox.push(doc);
              return { acknowledged: true };
            },
          };
        }
        throw new Error(`Unhandled collection: ${name}`);
      },
    };

    const service = new ProjectService();
    (service as any).db = mockDb;
    (service as any).projectsCol = mockDb.collection('tenant_configs');
    (service as any).membersCol = mockDb.collection('project_members');
    (service as any).rulesCol = mockDb.collection('business_rules');
    (service as any).versionsCol = mockDb.collection('config_versions');
    (service as any).isConnected = true;

    return { service, memoryProjects, memoryVersions, memoryReleases, memoryPointers, memoryOutbox };
  }

  // ── TEST 1: Fail-Closed without Journey ─────────────────────────────────
  await test('publishConfig fails closed if project has no valid journey configured or compiled', async () => {
    const { service } = createMockProjectService({
      'tenant-no-journey': {
        projectId: 'tenant-no-journey',
        name: 'Tenant No Journey',
        companyName: 'No Journey Corp',
        ai: {
          provider: 'openai',
          model: 'gpt-4o',
        },
        persona: {
          systemName: 'No Journey Bot',
          systemPromptOverrides: 'Help users.',
        },
      },
    });

    const result = await service.publishConfig('tenant-no-journey');
    assert.equal(result.success, false, 'Expected publish to fail closed');
    assert.match(result.message || '', /Project must define at least one valid journey/i);
  });

  // ── TEST 2: Fail-Closed without AI Model Policy ─────────────────────────
  await test('publishConfig fails closed if project has no AI model policy or model configuration', async () => {
    const { service } = createMockProjectService({
      'tenant-no-ai': {
        projectId: 'tenant-no-ai',
        name: 'Tenant No AI',
        companyName: 'No AI Corp',
        persona: {
          systemName: 'No AI Bot',
          systemPromptOverrides: 'Help users.',
          journeyDefinition: {
            journeyId: 'j1',
            version: '1.0.0',
            goals: ['goal1'],
            initialStage: 'start',
            stages: {
              start: {
                requiredFacts: [],
                allowedCapabilities: [],
                nextDecisionPolicy: 'dependency-first',
                exitConditions: [],
              },
            },
          },
        },
      },
    });

    const result = await service.publishConfig('tenant-no-ai');
    assert.equal(result.success, false, 'Expected publish to fail closed');
    assert.match(result.message || '', /Project must define AI model policy or AI model configuration/i);
  });

  // ── TEST 3: Strict Compilation & Publication ───────────────────────────
  await test('publishConfig strictly compiles Studio journeys, AI config, agents, capabilities, and publishes pack', async () => {
    const { service, memoryReleases, memoryPointers, memoryOutbox } = createMockProjectService({
      'caroma-studio': {
        projectId: 'caroma-studio',
        name: 'Caroma Studio Pro',
        companyName: 'Caroma Industries Ltd',
        ai: {
          provider: 'openai',
          model: 'gpt-4o',
          temperature: 0.2,
          maxTokens: 1500,
        },
        persona: {
          systemName: 'Caroma Stylist',
          systemPromptOverrides: 'Design bathrooms with precision.',
          journeyGuidance: 'Guide customer from space discovery to specified quote.',
          journeyDefinition: {
            journeyId: 'caroma_bathroom_journey',
            version: '1.0.0',
            displayName: 'Caroma Bathroom Journey',
            goals: ['discover_space', 'specify_fixtures'],
            initialStage: 'space_discovery',
            stages: {
              space_discovery: {
                stageId: 'space_discovery',
                displayName: 'Space Discovery',
                requiredFacts: [],
                allowedCapabilities: ['catalog_search'],
                nextDecisionPolicy: 'dependency-first',
                exitConditions: [{ nextStage: 'fixture_specification' }],
              },
              fixture_specification: {
                stageId: 'fixture_specification',
                displayName: 'Fixture Specification',
                requiredFacts: ['room_type'],
                allowedCapabilities: ['catalog_search', 'quote_create', 'order_commit'],
                nextDecisionPolicy: 'dependency-first',
                exitConditions: [],
              },
            },
          },
        },
        capabilities: ['catalog_search', 'quote_create', 'order_commit'],
        agents: [
          {
            agentId: 'caroma_specialist',
            name: 'Caroma Architectural Specialist',
            purpose: 'Architectural compliance and product specification',
            modelPolicyRef: 'standard_turn',
            allowedTools: ['catalog_search', 'quote_create'],
            maxTurns: 4,
            handoffConditions: [],
          },
        ],
        theme: {
          primaryColor: '#FFD600',
          accentColor: '#0A0A0A',
          fontFamily: 'Space Grotesk, sans-serif',
        },
        cardTemplates: {
          quote: {
            cardType: 'quote',
            spec: { root: 'box', elements: {} } as any,
            updatedAt: '2026-09-01T00:00:00Z',
          },
        },
        scenarios: [
          {
            id: 'S1',
            say: 'I need a matte black tapware set for a powder room',
            expect: 'Returns matte black tapware options',
            stage: 'fixture_specification',
          },
        ],
      },
    });

    const result = await service.publishConfig('caroma-studio', {
      publishedBy: 'test-admin',
      note: 'Production release validation',
    });

    assert.equal(result.success, true, `Publish should succeed: ${result.message}`);
    assert.equal(result.version, 1);

    // Verify Business Pack Release in memory
    const releaseKey = 'caroma-studio:production:1.0.1';
    const releaseDoc = memoryReleases.get(releaseKey);
    assert.ok(releaseDoc, 'Business pack release document must exist in business_pack_releases');
    assert.equal(releaseDoc.tenantId, 'caroma-studio');
    assert.equal(releaseDoc.environmentId, 'production');
    assert.equal(releaseDoc.version, '1.0.1');

    // Verify Model Policy was compiled from doc.ai (NO OpenAI+Anthropic hardcoding)
    const release = releaseDoc;
    assert.equal(release.modelPolicy.policies.length, 1);
    assert.equal(release.modelPolicy.policies[0].policyId, 'standard_turn');
    assert.equal(release.modelPolicy.policies[0].candidates.length, 1);
    assert.equal(release.modelPolicy.policies[0].candidates[0].provider, 'openai');
    assert.equal(release.modelPolicy.policies[0].candidates[0].model, 'gpt-4o');
    assert.equal(release.modelPolicy.policies[0].candidates[0].temperature, 0.2);
    assert.equal(release.modelPolicy.policies[0].maxOutputTokens, 1500);

    // Verify Specialist Agents compiled
    assert.equal(release.agents.length, 1);
    assert.equal(release.agents[0].agentId, 'caroma_specialist');
    assert.equal(release.agents[0].name, 'Caroma Architectural Specialist');

    // Verify Journeys compiled
    assert.equal(release.journeys.length, 1);
    assert.equal(release.journeys[0].journeyId, 'caroma_bathroom_journey');
    assert.equal(release.journeys[0].initialStage, 'space_discovery');

    // Verify Stage Tool Bindings
    assert.ok(release.capabilities.stageBindings.length >= 2);
    const discoveryStageBinding = release.capabilities.stageBindings.find(
      (sb: any) => sb.stageId === 'space_discovery'
    );
    assert.ok(discoveryStageBinding);
    assert.deepEqual(
      discoveryStageBinding.tools.map((t: any) => t.toolId),
      ['catalog_search']
    );

    // Verify Cards and Theme
    assert.equal(release.experience.theme.primaryColor, '#FFD600');
    assert.equal(release.experience.theme.accentColor, '#0A0A0A');
    assert.ok(release.experience.cards.allowedCardTypes.includes('quote'));

    // Verify Pointer updated
    const pointerKey = 'caroma-studio:production';
    const pointer = memoryPointers.get(pointerKey);
    assert.ok(pointer, 'Pointer must be updated');
    assert.equal(pointer.activeVersion, '1.0.1');
    assert.equal(pointer.revision, 1);

    // Verify Outbox event created
    assert.equal(memoryOutbox.length, 1);
    assert.equal(memoryOutbox[0].eventType, 'business_pack.published');
    assert.equal(memoryOutbox[0].payload.tenantId, 'caroma-studio');
    assert.equal(memoryOutbox[0].payload.version, '1.0.1');
  });

  // ── TEST 4: Visual JourneyGraph Compilation ─────────────────────────────
  await test('publishConfig compiles visual journeyGraph to journeyDefinition and publishes', async () => {
    const { service, memoryReleases } = createMockProjectService({
      'graph-project': {
        projectId: 'graph-project',
        name: 'Graph Project',
        companyName: 'Graph Flow Inc',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
        },
        persona: {
          systemName: 'Flow Agent',
          systemPromptOverrides: 'Graph-guided advisor',
          journeyGraph: {
            nodes: [
              {
                id: 'n1',
                data: {
                  kind: 'trigger.intent',
                  stageId: 'intake',
                  label: 'Customer Intake',
                },
              },
              {
                id: 'n2',
                data: {
                  kind: 'stage.scoping',
                  stageId: 'recommend',
                  label: 'Product Recommendation',
                  allowedCapabilities: ['catalog_search'],
                },
              },
            ],
            edges: [
              {
                id: 'e1',
                source: 'n1',
                target: 'n2',
              },
            ],
          },
        },
      },
    });

    const result = await service.publishConfig('graph-project');
    assert.equal(result.success, true, `Graph publish should succeed: ${result.message}`);

    const releaseKey = 'graph-project:production:1.0.1';
    const releaseDoc = memoryReleases.get(releaseKey);
    assert.ok(releaseDoc);
    assert.equal(releaseDoc.journeys[0].initialStage, 'intake');
    assert.ok(releaseDoc.journeys[0].stages.recommend);
    assert.equal(releaseDoc.modelPolicy.policies[0].candidates[0].provider, 'anthropic');
    assert.equal(releaseDoc.modelPolicy.policies[0].candidates[0].model, 'claude-3-5-sonnet');
  });

  console.log(`\nProject Service Tests Complete: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runProjectPublishingSuite().catch((err) => {
  console.error('Fatal error running project publishing suite:', err);
  process.exit(1);
});
