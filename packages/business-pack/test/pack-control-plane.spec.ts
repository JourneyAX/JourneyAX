import assert from 'node:assert/strict';
import { compileGraphToJourneyDefinition } from '../src/journey/compiler';
import { publishBusinessPack, computePackChecksum, rollbackBusinessPack } from '../src/publisher';
import { BusinessPackLoader } from '../src/loader';
import { BusinessPackReleaseSchema } from '../src/schemas/business-pack.schema';

async function runPackControlPlaneTests() {
  console.log('📦 Running Immutable Business Pack Control Plane Suite...\n');
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

  // ── TEST 1: Server-Side Graph Compilation ─────────────────────────────
  await test('Server-side compiler compiles visual graph into typed JourneyDefinition without hardcoded catalog.search', () => {
    const nodes = [
      {
        id: 'node-trigger-1',
        data: {
          kind: 'trigger.intent',
          stageId: 'discovery',
          label: 'Customer Discovery',
          requiredFacts: ['project_scope'],
        },
      },
      {
        id: 'node-stage-2',
        data: {
          kind: 'stage.scoping',
          stageId: 'solution',
          label: 'Architecture Solution',
          requiredFacts: ['cloud_provider'],
          allowedCapabilities: ['scoping.recommend_architecture'],
        },
      },
    ];

    const edges = [
      {
        id: 'e1-2',
        source: 'node-trigger-1',
        target: 'node-stage-2',
        conditionExpression: 'facts.project_scope != null',
      },
    ];

    const result = compileGraphToJourneyDefinition(nodes as any, edges as any, {
      journeyId: 'enterprise-cloud-journey',
      displayName: 'Enterprise Cloud Scoping',
    });

    assert.equal(result.success, true);
    assert.ok(result.journeyDefinition);
    assert.equal(result.journeyDefinition.journeyId, 'enterprise-cloud-journey');

    const entryStage = result.journeyDefinition.stages['discovery'];
    assert.ok(entryStage);
    assert.deepEqual(entryStage.requiredFacts, ['project_scope']);
    // Assert domain-neutrality: no catalog.search default!
    assert.deepEqual(entryStage.allowedCapabilities, []);

    const solutionStage = result.journeyDefinition.stages['solution'];
    assert.ok(solutionStage);
    assert.deepEqual(solutionStage.allowedCapabilities, ['scoping.recommend_architecture']);
  });

  // ── TEST 2: Mock DB Publishing & Immutable Pointer Promotion ───────────
  await test('publishBusinessPack creates immutable release with checksum and updates pointer', async () => {
    const memoryReleases = new Map<string, any>();
    const memoryPointers = new Map<string, any>();
    const memoryOutbox: any[] = [];

    const mockDb: any = {
      collection: (colName: string) => {
        if (colName === 'business_pack_releases') {
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
            findOne: async (filter: any) => {
              const key = `${filter.tenantId}:${filter.environmentId}:${filter.version}`;
              return memoryReleases.get(key) || null;
            },
          };
        }
        if (colName === 'business_pack_pointers') {
          return {
            findOne: async (filter: any) => {
              const key = `${filter.tenantId}:${filter.environmentId}`;
              return memoryPointers.get(key) || null;
            },
            insertOne: async (doc: any) => {
              const key = `${doc.tenantId}:${doc.environmentId}`;
              memoryPointers.set(key, doc);
              return { acknowledged: true };
            },
            updateOne: async (filter: any, update: any) => {
              const key = `${filter.tenantId}:${filter.environmentId}`;
              const prev = memoryPointers.get(key);
              if (!prev) return { matchedCount: 0 };
              // CAS revision check
              if (filter.revision !== undefined && prev.revision !== filter.revision) {
                return { matchedCount: 0 };
              }
              const updated = { ...prev, ...update.$set };
              if (update.$push?.history) {
                updated.history = [...(prev.history || []), ...(update.$push.history.$each || [])];
              }
              memoryPointers.set(key, updated);
              return { matchedCount: 1, acknowledged: true };
            },
          };
        }
        if (colName === 'outbox_events') {
          return {
            insertOne: async (doc: any) => {
              memoryOutbox.push(doc);
              return { acknowledged: true };
            },
          };
        }
        throw new Error(`Unexpected collection: ${colName}`);
      },
    };

    const validPack = {
      manifest: {
        packId: 'acme-b2b-pack',
        tenantId: 'acme-corp',
        name: 'ACME Enterprise',
        version: '1.0.1',
        description: 'ACME B2B Pack',
        schemaVersion: '1.0.0',
        environmentId: 'production',
        author: 'studio-user',
      },
      profile: {
        companyName: 'ACME Enterprise Inc',
        industry: 'cloud-consulting',
        primaryGoals: ['assessment', 'proposal'],
        locales: ['en-US'],
      },
      vocabulary: {
        version: '1.0.0',
        dimensions: [{ name: 'tier', required: false, allowedValues: ['enterprise', 'midmarket'] }],
        terms: [],
        acronyms: {},
        slotSynonyms: {},
        slotQuestions: {
          cloud_provider: {
            text: 'Which cloud provider do you plan to use?',
            options: ['AWS', 'GCP', 'Azure'],
          },
        },
        slotMappings: {},
        prohibitedTerms: [],
      },
      entities: {
        version: '1.0.0',
        entities: [
          {
            entityId: 'project_scope',
            displayName: 'Project Scope',
            description: 'Customer project requirements',
            attributes: [{ name: 'budget', type: 'number', required: false }],
          },
        ],
      },
      conversationPolicy: {
        fencingRules: [],
        prohibitedTopics: [],
        escalationThresholds: {
          sentimentFloor: -0.6,
          maxTurnsWithoutProgress: 4,
        },
      },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'standard_turn',
        policies: [
          {
            policyId: 'standard_turn',
            candidates: [
              { provider: 'openai', model: 'gpt-4o-mini', priority: 1 },
              { provider: 'anthropic', model: 'claude-3-5-sonnet', priority: 2 },
            ],
            dataResidency: 'au',
            maxInputTokens: 20000,
            maxOutputTokens: 2000,
            fallbackAllowed: true,
            timeoutMs: 10000,
          },
        ],
      },
      agents: [
        {
          agentId: 'scoping_agent',
          name: 'Consultant',
          purpose: 'Technical Scoping Agent',
          description: 'Technical Scoping Agent',
          modelPolicyRef: 'standard_turn',
          systemPromptTemplate: 'Scope architecture requirements.',
          allowedTools: [],
          maxTurns: 3,
          handoffConditions: [],
        },
      ],
      journeys: [
        {
          journeyId: 'cloud_scoping_v1',
          version: '1.0.0',
          displayName: 'Cloud Scoping Journey',
          description: 'Assess cloud requirements',
          goals: ['assess_scope', 'propose_architecture'],
          initialStage: 'scoping',
          stages: {
            scoping: {
              stageId: 'scoping',
              displayName: 'Scoping Stage',
              description: 'Gather facts',
              requiredFacts: ['cloud_provider'],
              allowedCapabilities: [],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [],
            },
          },
        },
      ],
      rules: [],
      capabilities: {
        version: '1.0.0',
        toolDefinitions: [],
        toolBindings: [],
        stageBindings: [],
      },
      experience: {
        version: '1.0.0',
        theme: {
          primaryColor: '#003366',
          accentColor: '#FF6600',
          fontFamily: 'Inter',
          borderRadius: '8px',
          customCssVars: {},
        },
        cards: {
          allowedCardTypes: ['quote', 'bundle', 'products'],
          defaultCardRenderer: '@journeyax/ui-cards',
        },
      },
      evaluations: [],
    };

    const pubResult = await publishBusinessPack(mockDb, validPack, {
      publishedBy: 'lead-architect',
      notes: 'Initial production release',
    });

    assert.ok(pubResult.checksum);
    assert.equal(pubResult.revision, 1);
    assert.equal(pubResult.release.manifest.version, '1.0.1');

    // Verify pointer was promoted
    const pointerKey = 'acme-corp:production';
    const pointer = memoryPointers.get(pointerKey);
    assert.ok(pointer);
    assert.equal(pointer.activeVersion, '1.0.1');
    assert.equal(pointer.promotedBy, 'lead-architect');

    // Verify outbox publication event
    assert.equal(memoryOutbox.length, 1);
    assert.equal(memoryOutbox[0].eventType, 'business_pack.published');
    assert.equal(memoryOutbox[0].payload.tenantId, 'acme-corp');
    assert.equal(memoryOutbox[0].payload.checksum, pubResult.checksum);

    // ── TEST 2b: Idempotent same-version republish with identical content succeeds
    const repubResult = await publishBusinessPack(mockDb, validPack, {
      publishedBy: 'lead-architect',
    });
    assert.equal(repubResult.checksum, pubResult.checksum);

    // ── TEST 2c: Same-version republish with DIFFERENT content must fail closed
    const tamperedPack = JSON.parse(JSON.stringify(validPack));
    tamperedPack.profile.companyName = 'Tampered ACME Name';
    await assert.rejects(
      () => publishBusinessPack(mockDb, tamperedPack),
      /Immutable release violation: version '1.0.1'.*already published with different checksum/
    );

    // ── TEST 2d: Publish version 1.0.2 to test pointer promotion and rollback
    const packV2 = JSON.parse(JSON.stringify(validPack));
    packV2.manifest.version = '1.0.2';
    const pubResultV2 = await publishBusinessPack(mockDb, packV2, {
      publishedBy: 'lead-architect',
      notes: 'Second production release',
    });
    assert.equal(pubResultV2.revision, 2);

    const pointerV2 = memoryPointers.get(pointerKey);
    assert.equal(pointerV2.activeVersion, '1.0.2');
    assert.equal(pointerV2.previousVersion, '1.0.1');
    assert.equal(pointerV2.rollbackAvailable, true);

    // ── TEST 2e: Rollback to previous version with CAS
    const rollbackRes = await rollbackBusinessPack(mockDb, 'acme-corp', 'production', {
      rolledBackBy: 'ops-lead',
      reason: 'Reverting due to regression',
    });
    assert.equal(rollbackRes.activeVersion, '1.0.1');
    assert.equal(rollbackRes.previousVersion, '1.0.2');
    assert.equal(rollbackRes.revision, 3);

    const rolledBackPointer = memoryPointers.get(pointerKey);
    assert.equal(rolledBackPointer.activeVersion, '1.0.1');
    assert.equal(rolledBackPointer.previousVersion, '1.0.2');

    // Verify outbox rollback event
    const lastOutbox = memoryOutbox[memoryOutbox.length - 1];
    assert.equal(lastOutbox.eventType, 'business_pack.rolled_back');
    assert.equal(lastOutbox.payload.activeVersion, '1.0.1');
  });

  // ── TEST 3: Fail-Closed Production Behavior (No Disk Fallback) ─────────
  await test('BusinessPackLoader in production fails closed and never loads uncommitted disk files', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const loader = new BusinessPackLoader();

      // Querying an unpublished or missing tenant in production must throw
      await assert.rejects(
        () => loader.loadPublished('non-existent-tenant-xyz', 'production'),
        /No published Business Pack found/
      );

      // Synchronous hasPublishedPack in production must return false without disk search
      const hasPack = loader.hasPublishedPack('workweargroup', 'production');
      assert.equal(hasPack, false, 'hasPublishedPack in production must not inspect disk');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  // ── TEST 4: hasPublishedPackAsync Queries Database Pointer ─────────────
  await test('hasPublishedPackAsync queries database pointer when cache is cold', async () => {
    const loader = new BusinessPackLoader();

    // With cold cache and invalid tenant, async check returns false
    const exists = await loader.hasPublishedPackAsync('unregistered-tenant-999', 'production');
    assert.equal(exists, false);
  });

  // ── TEST 5: Transactional Session Propagation ───────────────────────────
  await test('publishBusinessPack propagates MongoDB session to all operations', async () => {
    const sessionCalls: string[] = [];
    const mockSession = { id: 'mock-tx-session-123' };

    const mockDb: any = {
      collection: (colName: string) => ({
        findOne: async (_filter: any, opts: any) => {
          if (opts?.session === mockSession) sessionCalls.push(`${colName}.findOne`);
          return null;
        },
        insertOne: async (_doc: any, opts: any) => {
          if (opts?.session === mockSession) sessionCalls.push(`${colName}.insertOne`);
          return { acknowledged: true };
        },
        updateOne: async (_filter: any, _update: any, opts: any) => {
          if (opts?.session === mockSession) sessionCalls.push(`${colName}.updateOne`);
          return { matchedCount: 1, acknowledged: true };
        },
      }),
    };

    const minimalPack: any = {
      manifest: {
        packId: 'tx-test-pack',
        tenantId: 'tx-tenant',
        name: 'Transaction Pack',
        version: '1.0.0',
        schemaVersion: '1.0.0',
        environmentId: 'production',
      },
      profile: {
        companyName: 'Tx Corp',
        industry: 'finance',
        primaryGoals: ['security'],
        locales: ['en-US'],
      },
      vocabulary: { version: '1.0.0', dimensions: [], terms: [], acronyms: {}, slotSynonyms: {}, slotMappings: {}, prohibitedTerms: [] },
      entities: { version: '1.0.0', entities: [] },
      conversationPolicy: { fencingRules: [], prohibitedTopics: [], escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 } },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'p1',
        policies: [{ policyId: 'p1', candidates: [{ provider: 'openai', model: 'gpt-4o', priority: 1 }], dataResidency: 'us', maxInputTokens: 1000, maxOutputTokens: 100, fallbackAllowed: false, timeoutMs: 1000 }],
      },
      agents: [{ agentId: 'a1', name: 'A', purpose: 'test', description: 'test', modelPolicyRef: 'p1', allowedTools: [], maxTurns: 1, handoffConditions: [] }],
      journeys: [{
        journeyId: 'j1', version: '1.0.0', displayName: 'J1', goals: ['test'], initialStage: 's1',
        stages: { s1: { stageId: 's1', displayName: 'S1', requiredFacts: [], allowedCapabilities: [], nextDecisionPolicy: 'dependency-first', exitConditions: [] } },
      }],
      rules: [],
      capabilities: { version: '1.0.0', toolDefinitions: [], toolBindings: [], stageBindings: [] },
      experience: { version: '1.0.0', theme: { primaryColor: '#000', accentColor: '#fff', fontFamily: 'sans', borderRadius: '4px', customCssVars: {} }, cards: { allowedCardTypes: ['bundle'], defaultCardRenderer: '@journeyax/ui-cards' } },
      evaluations: [],
    };

    await publishBusinessPack(mockDb, minimalPack, { session: mockSession });

    assert.ok(sessionCalls.includes('business_pack_releases.findOne'), 'Release findOne must receive session');
    assert.ok(sessionCalls.includes('business_pack_releases.insertOne'), 'Release insertOne must receive session');
    assert.ok(sessionCalls.includes('business_pack_pointers.findOne'), 'Pointer findOne must receive session');
    assert.ok(sessionCalls.includes('business_pack_pointers.insertOne'), 'Pointer insertOne must receive session');
    assert.ok(sessionCalls.includes('outbox_events.insertOne'), 'Outbox insertOne must receive session');
  });

  // ── TEST 6: Mandatory Nonblank Checksum & Mismatch Rejection in BusinessPackLoader ──
  await test('BusinessPackLoader.loadFromMongo makes checksum mandatory/nonblank and rejects mismatches', async () => {
    const validPackData: any = {
      manifest: {
        packId: 'chk-test-pack',
        tenantId: 'chk-tenant',
        name: 'Checksum Test Pack',
        version: '1.0.0',
        schemaVersion: '1.0.0',
        environmentId: 'production',
      },
      profile: {
        companyName: 'Chk Corp',
        industry: 'retail',
        primaryGoals: ['commerce'],
        locales: ['en-US'],
      },
      vocabulary: { version: '1.0.0', dimensions: [], terms: [], acronyms: {}, slotSynonyms: {}, slotMappings: {}, prohibitedTerms: [] },
      entities: { version: '1.0.0', entities: [] },
      conversationPolicy: { fencingRules: [], prohibitedTopics: [], escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 } },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'p1',
        policies: [{ policyId: 'p1', candidates: [{ provider: 'openai', model: 'gpt-4o', priority: 1 }], dataResidency: 'us', maxInputTokens: 1000, maxOutputTokens: 100, fallbackAllowed: false, timeoutMs: 1000 }],
      },
      agents: [{ agentId: 'a1', name: 'A', purpose: 'test', description: 'test', modelPolicyRef: 'p1', allowedTools: [], maxTurns: 1, handoffConditions: [] }],
      journeys: [{
        journeyId: 'j1', version: '1.0.0', displayName: 'J1', goals: ['test'], initialStage: 's1',
        stages: { s1: { stageId: 's1', displayName: 'S1', requiredFacts: [], allowedCapabilities: [], nextDecisionPolicy: 'dependency-first', exitConditions: [] } },
      }],
      rules: [],
      capabilities: { version: '1.0.0', toolDefinitions: [], toolBindings: [], stageBindings: [] },
      experience: { version: '1.0.0', theme: { primaryColor: '#000', accentColor: '#fff', fontFamily: 'sans', borderRadius: '4px', customCssVars: {} }, cards: { allowedCardTypes: ['bundle'], defaultCardRenderer: '@journeyax/ui-cards' } },
      evaluations: [],
    };

    const parsedPack = BusinessPackReleaseSchema.parse(validPackData);
    const legitimateChecksum = computePackChecksum(parsedPack);
    assert.ok(legitimateChecksum && legitimateChecksum.length === 64, 'Checksum must be 64-char sha256');

    // Helper to build a mock DB with pointer and configurable release doc
    function createMockDb(releaseDocOverrides: any) {
      const releaseDoc = {
        tenantId: 'chk-tenant',
        environmentId: 'production',
        version: '1.0.0',
        ...validPackData,
        ...releaseDocOverrides,
      };

      return {
        collection: (name: string) => {
          if (name === 'business_pack_pointers') {
            return {
              findOne: async () => ({
                tenantId: 'chk-tenant',
                environmentId: 'production',
                activeVersion: '1.0.0',
              }),
            };
          }
          if (name === 'business_pack_releases') {
            return {
              findOne: async () => releaseDoc,
            };
          }
          return { findOne: async () => null };
        },
      };
    }

    // 1. Missing checksum (undefined) rejected -> returns null
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: undefined }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.equal(res, null, 'Release without checksum field must be rejected');
    }

    // 2. Null checksum rejected -> returns null
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: null }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.equal(res, null, 'Release with null checksum must be rejected');
    }

    // 3. Empty string checksum rejected -> returns null
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: '' }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.equal(res, null, 'Release with empty checksum string must be rejected');
    }

    // 4. Blank/whitespace-only checksum rejected -> returns null
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: '   ' }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.equal(res, null, 'Release with whitespace checksum must be rejected');
    }

    // 5. Checksum mismatch rejected -> returns null
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678' }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.equal(res, null, 'Release with mismatched checksum must be rejected');
    }

    // 6. Valid matching checksum accepted -> returns parsed release
    {
      const loader = new BusinessPackLoader({ db: createMockDb({ checksum: legitimateChecksum }) });
      const res = await loader.loadFromMongo('chk-tenant', 'production', '1.0.0');
      assert.ok(res, 'Release with valid matching checksum must be accepted');
      assert.equal(res?.manifest.packId, 'chk-test-pack');
      assert.equal(res?.manifest.version, '1.0.0');
    }

    // 7. loadPublished in production fails closed when checksum is missing/mismatched
    {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const loader = new BusinessPackLoader({ db: createMockDb({ checksum: 'invalid_checksum' }) });
        await assert.rejects(
          async () => {
            await loader.loadPublished('chk-tenant', 'production', '1.0.0');
          },
          /No published Business Pack found/
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    }
  });

  // ── TEST 7: rollbackBusinessPack verifies release checksum on rollback ──
  await test('rollbackBusinessPack verifies target release checksum and fails closed on mismatch', async () => {
    const memoryPointers: any[] = [];
    const memoryReleases: any[] = [];
    const memoryOutbox: any[] = [];

    const mockDb: any = {
      collection: (colName: string) => ({
        findOne: async (query: any) => {
          if (colName === 'business_pack_pointers') {
            const found = memoryPointers.find((p) => p.tenantId === query.tenantId && p.environmentId === query.environmentId);
            return found ? structuredClone(found) : null;
          }
          if (colName === 'business_pack_releases') {
            const found = memoryReleases.find((r) => r.tenantId === query.tenantId && r.environmentId === query.environmentId && r.version === query.version);
            return found ? structuredClone(found) : null;
          }
          return null;
        },
        insertOne: async (doc: any) => {
          if (colName === 'business_pack_releases') memoryReleases.push(structuredClone(doc));
          if (colName === 'business_pack_pointers') memoryPointers.push(structuredClone(doc));
          if (colName === 'outbox_events') memoryOutbox.push(structuredClone(doc));
          return { acknowledged: true, insertedId: 'mock-id' };
        },
        updateOne: async (query: any, update: any) => {
          if (colName === 'business_pack_pointers') {
            const idx = memoryPointers.findIndex((p) => p.tenantId === query.tenantId && p.environmentId === query.environmentId);
            if (idx >= 0) {
              if (query.revision !== undefined && memoryPointers[idx].revision !== query.revision) {
                return { matchedCount: 0, acknowledged: true };
              }
              if (update.$set) Object.assign(memoryPointers[idx], update.$set);
              return { matchedCount: 1, acknowledged: true };
            }
            if (update.$set) memoryPointers.push({ ...query, ...update.$set });
            return { matchedCount: 1, acknowledged: true };
          }
          return { matchedCount: 1, acknowledged: true };
        },
      }),
    };

    const makePack = (version: string) => ({
      manifest: {
        packId: 'rb-test-pack',
        tenantId: 'rb-tenant',
        name: 'Rollback Test Pack',
        version,
        schemaVersion: '1.0.0',
        environmentId: 'production',
      },
      profile: { companyName: 'Rollback Corp', industry: 'retail', primaryGoals: ['sales'], locales: ['en-US'] },
      vocabulary: { version: '1.0.0', dimensions: [], terms: [], acronyms: {}, slotSynonyms: {}, slotMappings: {}, prohibitedTerms: [] },
      entities: { version: '1.0.0', entities: [] },
      conversationPolicy: { fencingRules: [], prohibitedTopics: [], escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 } },
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'p1',
        policies: [{ policyId: 'p1', candidates: [{ provider: 'openai', model: 'gpt-4o', priority: 1 }], dataResidency: 'us', maxInputTokens: 1000, maxOutputTokens: 100, fallbackAllowed: false, timeoutMs: 1000 }],
      },
      agents: [{ agentId: 'a1', name: 'A', purpose: 'test', description: 'test', modelPolicyRef: 'p1', allowedTools: [], maxTurns: 1, handoffConditions: [] }],
      journeys: [{
        journeyId: 'j1', version, displayName: 'J1', goals: ['test'], initialStage: 's1',
        stages: { s1: { stageId: 's1', displayName: 'S1', requiredFacts: [], allowedCapabilities: [], nextDecisionPolicy: 'dependency-first', exitConditions: [] } },
      }],
      rules: [],
      capabilities: { version: '1.0.0', toolDefinitions: [], toolBindings: [], stageBindings: [] },
      experience: { version: '1.0.0', theme: { primaryColor: '#000', accentColor: '#fff', fontFamily: 'sans', borderRadius: '4px', customCssVars: {} }, cards: { allowedCardTypes: ['bundle'], defaultCardRenderer: '@journeyax/ui-cards' } },
      evaluations: [],
    });

    // Publish v1.0.0 then v1.0.1
    await publishBusinessPack(mockDb, makePack('1.0.0'));
    await publishBusinessPack(mockDb, makePack('1.0.1'));

    // Corrupt the checksum of v1.0.0
    const v1Release = memoryReleases.find((r) => r.version === '1.0.0');
    assert.ok(v1Release);
    const legitimateChecksum = v1Release.checksum;
    v1Release.checksum = 'corrupted_checksum_deadbeef';

    // Attempt rollback to v1.0.0 -> must be rejected with checksum mismatch error
    await assert.rejects(
      async () => {
        await rollbackBusinessPack(mockDb, 'rb-tenant', 'production', { targetVersion: '1.0.0' });
      },
      /checksum mismatch/
    );

    // Restore legitimate checksum
    v1Release.checksum = legitimateChecksum;

    // Rollback to v1.0.0 -> must succeed
    const rbResult = await rollbackBusinessPack(mockDb, 'rb-tenant', 'production', { targetVersion: '1.0.0' });
    assert.equal(rbResult.activeVersion, '1.0.0');
    assert.equal(rbResult.previousVersion, '1.0.1');
  });

  console.log(`\n==================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPackControlPlaneTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
