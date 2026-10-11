import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import assert from 'node:assert/strict';
import { connectToDatabase } from '@journeyax/database';
import { publishBusinessPack } from '@journeyax/business-pack';
import { CARD_TYPES } from '@journeyax/ui-cards';
import { OutcomeValidator } from '../apps/journey-runtime-service/src/turn/validate-outcome';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LOCAL END-TO-END REPEATABLE DEMO RUNNER
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: Client -> API Gateway (:3010) -> Journey Runtime Service (:3012) -> Mongo Pack
 * 
 * Verifies:
 * 1. Gateway & Runtime health checks
 * 2. Authenticated JWT token issuance from auth-service (:8080)
 * 3. Canonical publication of multi-journey Business Pack to isolated test DB
 * 4. Multi-turn conversation via Gateway HTTP & SSE endpoints
 * 5. Exactly one question per turn with structured fact priority & dependencies
 * 6. Same-turn stage transition and capability execution
 * 7. OutcomeValidator policy validation
 * 8. Registered @journeyax/ui-cards only (presentCard envelopes)
 * 9. Replay rejection on duplicate turnId at HTTP boundary (typed DUPLICATE_TURN)
 * 10. Durable workspace persistence reload via Gateway GET endpoint
 * 11. Truthful denial/handoff on nonmatching intent (zero positional fallback)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';
const RUNTIME_URL = process.env.JOURNEY_RUNTIME_SERVICE_URL || 'http://localhost:3012';
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8080';
const PROJECT_SERVICE_URL = process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const TEST_DB_NAME = process.env.MONGODB_DB_NAME || 'journeyx_test';

const RUN_ID = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const DEMO_TENANT = process.env.DEMO_TENANT || `tenant_e2e_${RUN_ID}`;
const DEMO_ENV = 'test';

async function runLocalE2EDemo() {
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log('🚀 STARTING REAL LOCAL END-TO-END JOURNEYAX DEMO CONVERSATION');
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log(`[Config] Gateway:  ${GATEWAY_URL}`);
  console.log(`[Config] Runtime:  ${RUNTIME_URL}`);
  console.log(`[Config] Project:  ${PROJECT_SERVICE_URL}`);
  console.log(`[Config] Auth:     ${AUTH_URL}`);
  console.log(`[Config] Database: ${TEST_DB_NAME}`);
  console.log(`[Config] Tenant:   ${DEMO_TENANT} (${DEMO_ENV})\n`);

  // ── 1. PRE-FLIGHT HEALTH CHECKS ───────────────────────────────────────────
  console.log('1. Checking service health and network gateway wiring...');
  
  // 1a. Gateway Health
  const gatewayHealthRes = await fetch(`${GATEWAY_URL}/health`).catch(() => null);
  assert.ok(gatewayHealthRes && gatewayHealthRes.ok, `Gateway at ${GATEWAY_URL} is not reachable`);
  const gatewayHealth = await gatewayHealthRes.json();
  assert.equal(gatewayHealth.status, 'ok', 'Gateway health status must be ok');
  console.log('   ✅ API Gateway (:3010) healthy.');

  // 1b. Runtime Service Health
  const runtimeHealthRes = await fetch(`${RUNTIME_URL}/health`).catch(() => null);
  assert.ok(runtimeHealthRes && runtimeHealthRes.ok, `Journey Runtime at ${RUNTIME_URL} is not reachable`);
  const runtimeHealth = await runtimeHealthRes.json();
  assert.equal(runtimeHealth.status, 'ok', 'Runtime health status must be ok');
  console.log('   ✅ Journey Runtime (:3012) healthy.');

  // 1c. Authentication Token Issuance (Fail-closed: no hardcoded defaults)
  const authTokenEnv = process.env.DEMO_AUTH_TOKEN;
  const authEmail = process.env.DEMO_AUTH_EMAIL;
  const authPassword = process.env.DEMO_AUTH_PASSWORD;

  let authToken = authTokenEnv;
  if (!authToken) {
    if (!authEmail || !authPassword) {
      throw new Error(
        'E2E runner requires either DEMO_AUTH_TOKEN or both DEMO_AUTH_EMAIL and DEMO_AUTH_PASSWORD environment variables. No default credentials are permitted.'
      );
    }
    console.log('   Authenticating with Auth Service (:8080) using environment credentials...');
    const loginRes = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: authEmail, password: authPassword }),
    });
    assert.ok(loginRes.ok, `Failed to authenticate with Auth Service at ${AUTH_URL} (status ${loginRes.status})`);
    const loginData = await loginRes.json();
    authToken = loginData.tokens?.accessToken;
    assert.ok(authToken, 'Access token missing from login response');
    console.log('   ✅ Authenticated Gateway bearer token issued (credentials verified, token withheld from logs).\n');
  } else {
    console.log('   ✅ Using environment-supplied DEMO_AUTH_TOKEN (token withheld from logs).\n');
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
    'X-Tenant-ID': DEMO_TENANT,
  };

  // ── 2. ISOLATED DATABASE SETUP & PACK PUBLICATION ───────────────────────────
  console.log('2. Setting up isolated test tenant configuration and publishing synthetic Business Pack...');
  const projectDbName = process.env.PROJECT_MONGODB_DB_NAME || TEST_DB_NAME;
  const { db: projectDb, client: projectClient } = await connectToDatabase(MONGODB_URI, projectDbName);
  const tenantConfigsCol = projectDb.collection('tenant_configs');

  // Fail-closed verification: ensure we never overwrite an existing tenant config
  const existingConfig = await tenantConfigsCol.findOne({ projectId: DEMO_TENANT });
  if (existingConfig) {
    throw new Error(
      `[Demo E2E] Fail-closed: tenant config for '${DEMO_TENANT}' already exists in '${projectDbName}'. Aborting to prevent overwriting pre-existing record.`
    );
  }

  // Register synthetic test tenant in tenant_configs so gateway tenant validation passes
  let tenantConfigInserted = false;
  await tenantConfigsCol.insertOne({
    projectId: DEMO_TENANT,
    orgId: 'org-test-isolated',
    name: 'Synthetic Test Tenant',
    companyName: 'Synthetic Architectural Solutions Ltd',
    slug: `test-isolated-${RUN_ID}`,
    domain: `${DEMO_TENANT}.journeyax.local`,
    status: 'active',
    scope: {
      rooms: ['Master Ensuite', 'Family Bathroom', 'Powder Room'],
      finishes: ['Chrome', 'Matte Black', 'Brushed Nickel'],
      categories: ['basin', 'toilet', 'tapware', 'shower'],
      complianceTags: ['StandardISO'],
      excludedSkus: [],
    },
    pricing: { currency: 'USD', symbol: '$', taxRate: 0.10, discountRate: 0.10 },
    persona: {
      systemName: 'Synthetic Architectural Consultant',
      systemPromptOverrides: 'Synthetic consultant advisor.',
      greetingMessage: 'Welcome to the test assistant.',
    },
    channels: { web: true, mobile: true, email: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  tenantConfigInserted = true;

  // Explicit Pre-requisite: verify project-service is running against the isolated test database
  const projectVerifyRes = await fetch(`${PROJECT_SERVICE_URL}/api/v1/projects/${encodeURIComponent(DEMO_TENANT)}/published`).catch(() => null);
  if (!projectVerifyRes || projectVerifyRes.status !== 200) {
    throw new Error(
      `[Prerequisite Failed] project-service (${PROJECT_SERVICE_URL}) cannot resolve tenant '${DEMO_TENANT}' from isolated DB '${projectDbName}' (HTTP ${projectVerifyRes?.status || 'unreachable'}). ` +
      `Ensure project-service is running with PROJECT_MONGODB_DB_NAME=${projectDbName} (or MONGODB_DB_NAME=${projectDbName}). Cross-database lookups and demo path hacks are strictly forbidden.`
    );
  }
  console.log(`   ✅ project-service confirmed reading directly from isolated database '${projectDbName}'.`);

  const { db: testDb, client: testClient } = await connectToDatabase(MONGODB_URI, TEST_DB_NAME);

  try {
    const multiJourneyPackData: any = {
      manifest: {
        packId: `pack-synthetic-e2e-${Date.now()}`,
        name: 'Synthetic Multi-Journey Commercial & Residential Design',
        version: `1.${Date.now() % 100000}.0`,
        description: 'Synthetic multi-journey commercial and residential planning',
        tenantId: DEMO_TENANT,
        environmentId: DEMO_ENV,
        status: 'active',
        publishedAt: new Date().toISOString(),
        publishedBy: authEmail || 'automated-runner@isolated.test',
        checksum: '',
      },
      profile: {
        companyName: 'Synthetic Architectural Solutions Ltd',
        industry: 'Architectural & Building Fixtures',
        brandTone: 'direct',
        primaryCurrency: 'USD',
        supportedCurrencies: ['USD', 'EUR', 'AUD'],
        primaryLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      vocabulary: {
        version: '1.0.0',
        terms: [],
        acronyms: {},
        slotSynonyms: {},
        slotMappings: {},
        prohibitedTerms: [],
        slotQuestions: {
          room_type: {
            text: 'Which room are you renovating or designing fixtures for?',
            options: ['Master Ensuite', 'Family Bathroom', 'Powder Room'],
            multi: false,
          },
          installation_type: {
            text: 'What type of plumbing installation will be performed?',
            options: ['Licensed Plumber Installation', 'Owner DIY Installation'],
            multi: false,
          },
        },
      },
      entities: {
        version: '1.0.0',
        entities: [
          {
            entityId: 'room_type',
            displayName: 'Room Type',
            attributes: [
              {
                name: 'room_type',
                type: 'string',
                enum: ['Master Ensuite', 'Family Bathroom', 'Powder Room'],
                required: true,
              },
            ],
          },
          {
            entityId: 'installation_type',
            displayName: 'Installation Type',
            attributes: [
              {
                name: 'installation_type',
                type: 'string',
                enum: ['Licensed Plumber Installation', 'Owner DIY Installation'],
                required: true,
              },
            ],
          },
        ],
      },
      conversationPolicy: {
        fencingRules: [],
        prohibitedTopics: [],
        escalationThresholds: { sentimentFloor: -0.5, maxTurnsWithoutProgress: 3 },
      },
      // MULTI-JOURNEY: Proves zero positional fallback to journeys[0]
      journeys: [
        {
          journeyId: 'journey_commercial_procurement',
          version: '1.0.0',
          displayName: 'Commercial Bulk Procurement',
          goals: ['Procure commercial high-rise piping and industrial HVAC chillers'],
          initialStage: 'stage_commercial_intake',
          stages: {
            stage_commercial_intake: {
              stageId: 'stage_commercial_intake',
              displayName: 'Commercial Intake',
              requiredFacts: ['tender_id'],
              allowedCapabilities: [],
              exitConditions: [],
            },
          },
          metadata: {
            triggerIntents: ['commercial_procurement', 'industrial_piping', 'bulk_tender'],
          },
        },
        {
          journeyId: 'journey_residential_renovation',
          version: '2.0.0',
          displayName: 'Residential Bathroom Renovation',
          goals: ['Plan and configure fixtures for residential bathroom renovation'],
          initialStage: 'stage_space_discovery',
          stages: {
            stage_space_discovery: {
              stageId: 'stage_space_discovery',
              displayName: 'Space Discovery Intake',
              requiredFacts: [
                {
                  key: 'room_type',
                  priority: 200,
                  question: 'Which room are you renovating or designing fixtures for?',
                  options: ['Master Ensuite', 'Family Bathroom', 'Powder Room'],
                  dependencies: [],
                  required: true,
                },
                {
                  key: 'installation_type',
                  priority: 100,
                  question: 'What type of plumbing installation will be performed?',
                  options: ['Licensed Plumber Installation', 'Owner DIY Installation'],
                  dependencies: ['room_type'], // BLOCKED until room_type is satisfied
                  required: true,
                },
              ],
              optionalFacts: [
                {
                  key: 'water_saving_priority',
                  priority: 50,
                  question: 'Do you require high water-saving ratings?',
                  dependencies: [],
                  required: false,
                },
              ],
              allowedCapabilities: [],
              nextDecisionPolicy: 'dependency-first' as const,
              exitConditions: [
                {
                  allFactsPresent: ['room_type', 'installation_type'],
                  nextStage: 'stage_fixture_selection',
                },
              ],
            },
            stage_fixture_selection: {
              stageId: 'stage_fixture_selection',
              displayName: 'Fixture Selection & Sizing',
              requiredFacts: [],
              allowedCapabilities: ['catalog.search'],
              nextDecisionPolicy: 'dependency-first' as const,
              exitConditions: [],
            },
          },
          metadata: {
            triggerIntents: ['residential_renovation', 'bathroom_renovation', 'renovate_bathroom'],
          },
        },
      ],
      rules: [
        {
          ruleId: 'valid_catalog_results',
          name: 'Catalog Execution Validity Check',
          description: 'Catalog search total count must be non-negative',
          condition: {
            ruleExpression: 'outcome.total >= 0',
          },
          action: 'allow' as const,
          remediationMessage: 'Catalog query failed schema integrity check',
        },
      ],
      capabilities: {
        version: '1.0.0',
        toolDefinitions: [
          {
            toolId: 'catalog.search',
            displayName: 'Search Fixture Catalog',
            description: 'Searches authoritative product catalog for matching fixtures',
            version: '1.0.0',
            inputSchema: {
              properties: {
                room_type: { type: 'string' },
                installation_type: { type: 'string' },
              },
              required: ['room_type'],
            },
            outputSchema: {
              properties: {
                items: { type: 'object' },
                total: { type: 'number' },
              },
              required: ['items', 'total'],
            },
            sideEffect: 'read' as const,
            risk: 'low' as const,
            timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
            idempotencyPolicy: { required: false, ttlSeconds: 86400 },
            approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
            dataClassification: 'internal' as const,
          },
        ],
        toolBindings: [
          {
            toolId: 'catalog.search',
            tenantId: DEMO_TENANT,
            environmentId: DEMO_ENV as const,
            bindingVersion: '1.0.0',
            executor: {
              type: 'native_capability' as const,
              nativeHandler: 'catalog.search',
            },
            enabled: true,
            policy: {
              requiredRole: 'customer',
              requiresConfirmation: false,
              idempotencyRequired: false,
              timeoutMs: 5000,
              retryAttempts: 0,
            },
          },
        ],
        stageBindings: [
          {
            journeyId: 'journey_residential_renovation',
            stageId: 'stage_fixture_selection',
            tools: [
              {
                toolId: 'catalog.search',
              },
            ],
          },
        ],
      },
      agents: [
        {
          agentId: 'stylist-agent',
          name: 'Fixture Stylist',
          purpose: 'Residential fixture design consultant',
          modelPolicyRef: 'default-policy',
          allowedTools: ['catalog.search'],
          maxTurns: 5,
          handoffConditions: [],
          inputSchema: {},
          outputSchema: {},
        },
      ],
      modelPolicy: {
        version: '1.0.0',
        defaultPolicy: 'default-policy',
        policies: [
          {
            policyId: 'default-policy',
            candidates: [{ provider: 'custom', model: 'deterministic-test-model', priority: 1 }],
            dataResidency: 'us',
            maxInputTokens: 4000,
            maxOutputTokens: 1000,
            fallbackAllowed: true,
            timeoutMs: 5000,
          },
        ],
      },
      experience: {
        version: '1.0.0',
        theme: {
          primaryColor: '#0F172A',
          accentColor: '#3B82F6',
          fontFamily: 'Inter, sans-serif',
          borderRadius: '8px',
          customCssVars: {},
        },
        cards: {
          bundle: {
            heading: 'Verified Bathroom Fixture Package',
            summary: 'Authoritative fixtures matched to selected room specifications',
            primaryActionLabel: 'Confirm Package',
            secondaryActionLabel: 'Adjust Selections',
          },
        },
      },
    };

    const published = await publishBusinessPack(
      testDb,
      multiJourneyPackData,
      { publishedBy: authEmail || 'automated-runner@isolated.test' }
    );

    assert.ok(published.checksum, 'Published pack must contain valid sha256 checksum');
    console.log(`   ✅ Published synthetic release v${published.release.manifest.version} into isolated DB '${TEST_DB_NAME}' (checksum: ${published.checksum.slice(0, 16)}...)\n`);

    // ── 3. EXECUTE PUBLIC MULTI-TURN CONVERSATION VIA API GATEWAY ─────────────
    console.log('3. Executing public multi-turn conversation via Gateway (:3100 / :3010)...');

    const sessionId = `sess-e2e-${Date.now()}`;
    const workspaceId = `ws-e2e-${Date.now()}`;

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 1: Public initiation -> Goal matches journey_residential_renovation (NOT journey 0)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('   Turn 1: User sends renovation goal (POST /runtime/turn via Gateway)...');
    const turn1Payload = {
      sessionId,
      workspaceId,
      turnId: `turn-${Date.now()}-001`,
      correlationId: `corr-${Date.now()}-001`,
      message: 'I want to plan a residential bathroom renovation and select fixtures',
      inputFacts: {},
    };

    const turn1Res = await fetch(`${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/turn`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(turn1Payload),
    });
    if (!turn1Res.ok) {
      console.error('Turn 1 HTTP failed:', turn1Res.status, await turn1Res.text());
    }
    assert.ok(turn1Res.status === 200 || turn1Res.status === 201, 'Turn 1 HTTP request must succeed');
    const turn1Result = await turn1Res.json();

    // 3a. Verify Journey Selection: selected journey_residential_renovation, NOT journeys[0] (commercial)!
    assert.equal(
      turn1Result.workspace.journeyId,
      'journey_residential_renovation',
      'Must match journey_residential_renovation based on goal (zero positional fallback)'
    );
    assert.equal(turn1Result.decision.type, 'ask_fact');
    // 3b. Verify structured fact priority: asks room_type (priority 200); blocks installation_type (dep on room_type)
    assert.equal(turn1Result.decision.payload.targetFact, 'room_type');
    assert.equal(turn1Result.workspace.openQuestions.length, 1);
    assert.equal(turn1Result.workspace.openQuestions[0], 'room_type');
    // 3c. Verify UI Card: clarify component emitted with registered presentCard envelope
    assert.equal(turn1Result.uiInstructions.length, 1);
    assert.equal(turn1Result.uiInstructions[0].component, 'clarify');
    assert.equal(turn1Result.uiInstructions[0].envelope?.name, 'presentCard');
    assert.ok(
      turn1Result.uiInstructions[0].component in CARD_TYPES,
      `Turn 1 component '${turn1Result.uiInstructions[0].component}' must be registered in CARD_TYPES`
    );
    const turn1CardType =
      turn1Result.uiInstructions[0].envelope?.arguments?.card?.cardType ||
      turn1Result.uiInstructions[0].envelope?.card?.cardType;
    assert.ok(
      turn1CardType && turn1CardType in CARD_TYPES,
      `Turn 1 presentCard cardType '${turn1CardType}' must be registered in CARD_TYPES`
    );
    assert.equal(
      turn1CardType,
      turn1Result.uiInstructions[0].component,
      'Envelope cardType must match component'
    );
    console.log('   ✅ Turn 1: Successfully selected journey_residential_renovation, asked priority fact "room_type" with registered presentCard UI.');

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 2: Answers room_type -> Workspace persists fact, asks installation_type
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n   Turn 2: User answers room_type (POST /runtime/turn via Gateway)...');
    const turn2Payload = {
      sessionId,
      workspaceId,
      turnId: `turn-${Date.now()}-002`,
      correlationId: `corr-${Date.now()}-002`,
      message: 'The room is Master Ensuite',
      inputFacts: {
        room_type: 'Master Ensuite',
      },
    };

    const turn2Res = await fetch(`${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/turn`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(turn2Payload),
    });
    if (!turn2Res.ok) {
      console.error('Turn 2 HTTP failed:', turn2Res.status, await turn2Res.text());
    }
    assert.ok(turn2Res.status === 200 || turn2Res.status === 201, 'Turn 2 HTTP request must succeed');
    const turn2Result = await turn2Res.json();

    assert.equal(turn2Result.decision.type, 'ask_fact');
    assert.equal(turn2Result.decision.payload.targetFact, 'installation_type');
    assert.equal(turn2Result.workspace.facts['room_type']?.value, 'Master Ensuite');
    assert.equal(turn2Result.workspace.openQuestions.length, 1);
    assert.equal(turn2Result.workspace.openQuestions[0], 'installation_type');
    console.log('   ✅ Turn 2: Fact persisted, now asks unblocked "installation_type".');

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 3: SSE Streaming via Gateway -> Stage exit, same-turn capability & OutcomeValidator
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n   Turn 3: User answers installation_type via SSE Stream (POST /runtime/chat/stream)...');
    const turn3TurnId = `turn-${Date.now()}-003`;
    const turn3Payload = {
      sessionId,
      workspaceId,
      turnId: turn3TurnId,
      correlationId: `corr-${Date.now()}-003`,
      idempotencyKey: `idem-tool-${Date.now()}`,
      message: 'Installation is Licensed Plumber Installation',
      inputFacts: {
        installation_type: 'Licensed Plumber Installation',
      },
    };

    const streamRes = await fetch(`${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/chat/stream`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(turn3Payload),
    });
    if (!streamRes.ok) {
      console.error('Turn 3 SSE failed:', streamRes.status, await streamRes.text());
    }
    assert.ok(streamRes.status === 200 || streamRes.status === 201, 'SSE stream connection must succeed');
    assert.equal(streamRes.headers.get('content-type')?.includes('text/event-stream'), true, 'Must return SSE Content-Type');

    // Parse SSE stream events
    const rawText = await streamRes.text();
    const sseEvents: Array<{ event: string; data: any }> = [];
    const lines = rawText.split('\n');
    let currentEvent = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.replace('event:', '').trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.replace('data:', '').trim();
        try {
          sseEvents.push({ event: currentEvent, data: JSON.parse(dataStr) });
        } catch {
          sseEvents.push({ event: currentEvent, data: dataStr });
        }
      }
    }

    const eventTypes = sseEvents.map((e) => e.event);
    assert.ok(eventTypes.includes('session'), 'Stream must emit session event');
    assert.ok(eventTypes.includes('done'), 'Stream must emit done event');

    const doneEvent = sseEvents.find((e) => e.event === 'done');
    assert.ok(doneEvent && doneEvent.data, 'Done event must contain payload');
    assert.equal(
      doneEvent.data.trace?.stage,
      'stage_fixture_selection',
      'Must have transitioned to stage_fixture_selection'
    );
    // ── 3c. PROVE EXACT INVOKE_CAPABILITY DECISION VIA PUBLIC RESPONSE ─────────
    assert.ok(doneEvent.data.decision, 'Must emit decision in stage fixture selection');
    assert.equal(
      doneEvent.data.decision.type,
      'invoke_capability',
      'Turn 3 decision type must be invoke_capability'
    );
    assert.equal(
      doneEvent.data.decision.targetCapability,
      'catalog.search',
      'Turn 3 targetCapability must be catalog.search'
    );
    assert.deepEqual(
      doneEvent.data.decision.payload,
      {
        room_type: 'Master Ensuite',
        installation_type: 'Licensed Plumber Installation',
      },
      'Turn 3 decision payload must contain authoritative room_type and installation_type facts'
    );
    console.log('   ✅ Turn 3 Public SSE: Proved decision is invoke_capability targeting "catalog.search".');

    // ── 3d. PROVE CAPABILITY EXECUTION VIA ISOLATED DATABASE RECORD ───────────
    const execRecord = await testDb.collection('tool_executions').findOne({
      tenantId: DEMO_TENANT,
      workspaceId,
      toolId: 'catalog.search',
    });
    assert.ok(execRecord, 'Isolated tool execution record must exist in database');
    assert.equal(execRecord.toolId, 'catalog.search', 'Execution toolId must be catalog.search');
    assert.equal(execRecord.status, 'completed', 'Execution record status must be completed');
    assert.deepEqual(
      execRecord.inputPayload,
      {
        room_type: 'Master Ensuite',
        installation_type: 'Licensed Plumber Installation',
      },
      'Execution inputPayload must match turn decision payload'
    );
    assert.ok(execRecord.outputPayload != null, 'Execution outputPayload must be present');
    assert.ok(Array.isArray(execRecord.outputPayload.items), 'Output items must be an array');
    assert.equal(typeof execRecord.outputPayload.total, 'number', 'Output total must be a number');
    assert.ok(execRecord.outputPayload.total >= 0, 'Output total must be non-negative');
    console.log(`   ✅ Turn 3 Execution Record: Proved catalog.search executed successfully (status: ${execRecord.status}, total: ${execRecord.outputPayload.total}).`);

    // ── 3e. PROVE OUTCOMEVALIDATOR SCHEMA & PACK RULE EVIDENCE ────────────────
    const outcomeValidator = new OutcomeValidator();

    // 1. Authoritative positive validation against applied pack rule
    const turn3WorkspaceState: any = {
      workspaceId,
      tenantId: DEMO_TENANT,
      environmentId: DEMO_ENV,
      currentStage: 'stage_fixture_selection',
      journeyId: 'journey_residential_renovation',
      facts: {
        room_type: { value: 'Master Ensuite', source: 'customer', confidence: 1 },
        installation_type: { value: 'Licensed Plumber Installation', source: 'customer', confidence: 1 },
      },
      openQuestions: [],
      decisions: [],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const validationResult = outcomeValidator.validate(
      doneEvent.data.decision,
      execRecord.outputPayload,
      multiJourneyPackData,
      turn3WorkspaceState
    );
    assert.equal(validationResult.valid, true, 'Execution output must be valid according to OutcomeValidator');
    assert.equal(validationResult.status, 'success', 'Validation status must be success');
    assert.ok(
      validationResult.appliedRules.includes('valid_catalog_results'),
      'OutcomeValidator must record applied pack rule valid_catalog_results'
    );
    console.log('   ✅ OutcomeValidator Proof: Output schema valid; applied pack rule "valid_catalog_results" verified.');

    // 2. Controlled negative rule case: outcome violating pack deny rule fails validation
    const negativeRuleValidation = outcomeValidator.validate(
      doneEvent.data.decision,
      { items: [], total: -1 },
      {
        ...multiJourneyPackData,
        rules: [
          {
            ruleId: 'valid_catalog_results',
            name: 'Catalog Execution Validity Check',
            condition: { ruleExpression: 'outcome.total >= 0' },
            action: 'deny' as const,
            remediationMessage: 'Catalog search total count must be non-negative',
          },
        ],
      },
      turn3WorkspaceState
    );
    assert.equal(negativeRuleValidation.valid, false, 'Controlled negative rule case must fail validation');
    assert.equal(negativeRuleValidation.status, 'failed', 'Negative rule validation status must be failed');
    assert.ok(
      negativeRuleValidation.appliedRules.includes('valid_catalog_results'),
      'OutcomeValidator must record applied negative rule in appliedRules'
    );
    console.log('   ✅ OutcomeValidator Proof: Controlled negative rule case correctly rejected with failure.');

    // 3. Controlled negative schema case: outcome missing required field fails validation
    const negativeSchemaValidation = outcomeValidator.validate(
      doneEvent.data.decision,
      { items: [] }, // missing required 'total'
      multiJourneyPackData,
      turn3WorkspaceState
    );
    assert.equal(negativeSchemaValidation.valid, false, 'Controlled negative schema case must fail validation');
    assert.equal(negativeSchemaValidation.status, 'failed', 'Negative schema validation status must be failed');
    assert.ok(
      negativeSchemaValidation.notes?.includes("missing required field 'total'"),
      'OutcomeValidator must record missing required field in schema failure notes'
    );
    console.log('   ✅ OutcomeValidator Proof: Controlled negative schema case correctly rejected with failure.');

    // ── 3f. PROVE UI ACTION PRESENTATION & CARD_TYPES REGISTRATION ────────────
    const uiActionEvents = sseEvents.filter((e) => e.event === 'uiAction');

    // Runtime SSE stream assertion: truthfully assert zero cards for empty grounded results (no fabricated cards)
    if (execRecord.outputPayload.total === 0) {
      assert.equal(
        uiActionEvents.length,
        0,
        'SSE stream must truthfully emit zero UI cards for empty grounded results (zero fabrication)'
      );
      console.log('   ✅ UI Cards Proof: Truthfully emitted 0 cards for empty grounded results (zero fabrication).');
    }

    // Assert presentation contract on any emitted runtime UI actions
    for (const uiEvent of uiActionEvents) {
      assert.equal(uiEvent.data?.name, 'presentCard', 'SSE uiAction event must use presentCard envelope');
      const cardType = uiEvent.data?.card?.cardType || uiEvent.data?.arguments?.card?.cardType;
      assert.ok(
        cardType && cardType in CARD_TYPES,
        `Emitted cardType '${cardType}' must be registered in @journeyax/ui-cards CARD_TYPES`
      );
    }

    console.log('   ✅ Turn 3: Stage exit transition, same-turn capability, execution, and validation fully proven.');

    // ──────────────────────────────────────────────────────────────────────────
    // 4. PROVING TRUTHFUL REPLAY REJECTION AT HTTP BOUNDARY (TYPED DUPLICATE_TURN)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n4. Proving turn replay rejection at HTTP Gateway boundary...');
    const replayRes = await fetch(`${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/turn`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(turn3Payload), // IDENTICAL turnId!
    });
    assert.equal(replayRes.status, 400, 'Replaying identical turnId must be rejected with HTTP 400/Bad Request');
    const replayError = await replayRes.json();
    assert.equal(replayError.code, 'DUPLICATE_TURN', 'Error response must contain typed domain code DUPLICATE_TURN');
    assert.equal(replayError.turnId, turn3TurnId, 'Error response must identify rejected duplicate turnId');
    console.log('   ✅ HTTP Replay Rejection: Identical turnId rejected with typed DUPLICATE_TURN error.');

    // ──────────────────────────────────────────────────────────────────────────
    // 5. PROVING DURABLE WORKSPACE RELOAD ACROSS PUBLIC GATEWAY
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n5. Proving durable workspace state reload via Gateway GET endpoint...');
    const wsGetRes = await fetch(
      `${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/workspaces/${workspaceId}`,
      {
        method: 'GET',
        headers: authHeaders,
      }
    );
    assert.equal(wsGetRes.status, 200, 'Workspace GET request must succeed');
    const persistedWorkspace = await wsGetRes.json();
    assert.equal(persistedWorkspace.workspaceId, workspaceId);
    assert.equal(persistedWorkspace.facts['room_type']?.value, 'Master Ensuite');
    assert.equal(persistedWorkspace.facts['installation_type']?.value, 'Licensed Plumber Installation');
    assert.equal(persistedWorkspace.lastProcessedTurnId, turn3TurnId);
    console.log('   ✅ Workspace State Persistence: Authoritatively retrieved via public Gateway GET route.');

    // ──────────────────────────────────────────────────────────────────────────
    // 6. PROVING TRUTHFUL DENIAL / HANDOFF OUTPUT ON UNMATCHED INTENT
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n6. Proving truthful denial/handoff on nonmatching intent (zero positional fallback)...');
    const unmatchedRes = await fetch(`${GATEWAY_URL}/api/v1/${DEMO_TENANT}/${DEMO_ENV}/runtime/turn`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sessionId: `sess-unmatched-${Date.now()}`,
        workspaceId: `ws-unmatched-${Date.now()}`,
        turnId: `turn-unmatched-${Date.now()}`,
        correlationId: `corr-unmatched-${Date.now()}`,
        message: 'Can you book an interstellar rocket to Mars next Tuesday?',
        inputFacts: {},
      }),
    });
    assert.ok(unmatchedRes.status === 200 || unmatchedRes.status === 201);
    const unmatchedResult = await unmatchedRes.json();
    assert.equal(unmatchedResult.decision.type, 'handoff', 'Must return typed handoff decision');
    assert.ok(
      unmatchedResult.assistantMessage.includes('unable to complete') ||
      unmatchedResult.assistantMessage.includes('No matching journey') ||
      unmatchedResult.decision.reason.includes('No matching journey'),
      'Must truthfully report failure to match any journey'
    );
    console.log('   ✅ Truthful Failure Output: Nonmatching request properly handed off without positional fallback.');

    console.log('\n════════════════════════════════════════════════════════════════════════════');
    console.log('🎉 REAL LOCAL END-TO-END DEMO CONVERSATION FULLY PROVEN AND OPERATIONAL!');
    console.log('════════════════════════════════════════════════════════════════════════════\n');
  } finally {
    // Hermetic Teardown: Clean up synthetic test records
    console.log('Teardown: Cleaning up synthetic test tenant records from test database and config registry...');
    try {
      if (tenantConfigInserted) {
        await tenantConfigsCol.deleteOne({ projectId: DEMO_TENANT });
      }
      await testDb.collection('releases').deleteMany({ tenantId: DEMO_TENANT });
      await testDb.collection('pointers').deleteMany({ tenantId: DEMO_TENANT });
      await testDb.collection('workspaces').deleteMany({ tenantId: DEMO_TENANT });
      await testDb.collection('tool_executions').deleteMany({ tenantId: DEMO_TENANT });
      console.log('✅ Teardown completed. Zero modifications to existing tenants.');
    } catch (e: any) {
      console.warn('Teardown warning:', e.message);
    } finally {
      if (projectClient) {
        await projectClient.close();
      }
      if (testClient && testClient !== projectClient) {
        await testClient.close();
      }
    }
  }
}

runLocalE2EDemo()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ LOCAL E2E DEMO FAILED:');
    console.error(err);
    process.exit(1);
  });
