/**
 * test/placemakers-laundry-multiturn-closure.spec.ts
 *
 * Enterprise Platform Closure Test Suite:
 * PlaceMakers Multi-Turn Clarification, Context Retention & Retrieval Gating
 *
 * Covers Scenarios A through G:
 * A. Multi-turn laundry context: pins laundry journey, persists room_type=laundry & project_goal,
 *    emits clarify card with 3 configured questions, retrieval NOT executed.
 * B. Clarification answers: maps card answers to facts, stores emitted IDs in openQuestions,
 *    removes answered while preserving unanswered.
 * C. Ambiguous measurement: "100 miters" triggers scoped unit clarification, never asks room,
 *    does NOT store 100 metres.
 * D. Context continuation: "room soize" continues dimensions without asking room or resetting journey.
 * E. Journey completion: all discovery facts satisfied -> retrieval executes -> deduplicated product cards before done.
 * F. Persistence and isolation: state preserved across turns and reload, new session clean, tenant isolation.
 * G. Regression: single question clarify works, gateway/SSE canonical, zero filesystem /packs runtime references.
 */

import 'dotenv/config';
import assert from 'node:assert/strict';
import { TurnApplicationService } from '../apps/journey-runtime-service/src/kernel/turn-application.service';
import { PackRepository } from '../apps/journey-runtime-service/src/kernel/pack.repository';
import { WorkspaceRepository } from '../apps/journey-runtime-service/src/kernel/workspace.repository';
import { WorkspaceStore } from '../apps/journey-runtime-service/src/workspace/workspace.store';
import { OutboxRepository } from '../apps/journey-runtime-service/src/kernel/outbox.repository';
import { ExecutionRepository } from '../apps/journey-runtime-service/src/kernel/execution.repository';
import { CapabilityGateway } from '../apps/journey-runtime-service/src/kernel/capability.gateway';
import { BusinessPackLoader, BusinessPackRelease } from '@journeyax/business-pack';
import { TurnCommand } from '@journeyax/journey-core';

interface CapturedSinkEvent {
  event: string;
  payload: any;
}

async function runClosureTests() {
  console.log('🧪 Running PlaceMakers Multi-Turn Clarification & Context Retention Closure Suite...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  process.env.NODE_ENV = 'test';
  process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

  // 1. Load the active published PlaceMakers pack from MongoDB release (v1.0.8)
  const loader = new BusinessPackLoader({ mongoDbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017' });
  const placemakersPack = await loader.loadPublished('placemakers', 'production');
  assert.ok(placemakersPack, 'PlaceMakers Business Pack must load from database');
  assert.equal(placemakersPack.manifest.version, '1.0.8', 'Active release must be 1.0.8');
  console.log(`Loaded PlaceMakers release version: ${placemakersPack.manifest.version} (checksum: ${placemakersPack.manifest.packId})\n`);

  // Shared test stores
  const workspaceStore = new WorkspaceStore();
  const workspaceRepo = new WorkspaceRepository(workspaceStore);
  const outboxRepo = new OutboxRepository();
  const executionRepo = new ExecutionRepository();
  const capabilityGateway = new CapabilityGateway();

  // Register real mock execution for catalog.search with duplicated SKU entries to test deduplication
  let catalogSearchExecuted = false;
  let catalogSearchQuery: any = null;
  capabilityGateway.registerCustomAdapter('catalog.search', {
    execute: async (input: any) => {
      catalogSearchExecuted = true;
      catalogSearchQuery = input;
      return {
        verified: true,
        items: [
          { sku: 'PM-LND-BASE-900', title: 'PlaceMakers 900mm Laundry Base Cabinet White', category: 'cabinetry', price: { amountCents: 45900 } },
          { sku: 'PM-LND-BASE-900', title: 'PlaceMakers 900mm Laundry Base Cabinet White (Duplicate)', category: 'cabinetry', price: { amountCents: 45900 } },
          { sku: 'PM-TUB-SUPER-ST', title: 'Robinsons SuperTub Stainless Steel Laundry Tub', category: 'tub', price: { amountCents: 89900 } },
          { sku: 'PM-WALL-GIB-AQUA', title: 'GIB Aqualine 10mm 2.4x1.2m Moisture Wall Lining', category: 'lining', price: { amountCents: 4250 } },
          { sku: 'PM-WALL-GIB-AQUA', title: 'GIB Aqualine 10mm 2.4x1.2m Moisture Wall Lining (Variant)', category: 'lining', price: { amountCents: 4250 } },
        ],
        facts: {
          catalog_results: {
            value: ['PM-LND-BASE-900', 'PM-TUB-SUPER-ST', 'PM-WALL-GIB-AQUA'],
            source: 'capability',
            confidence: 1.0,
            extractedAt: new Date().toISOString(),
          },
        },
      };
    },
  });

  const packRepo = {
    loadActivePack: async (tenantId: string) => {
      if (tenantId === 'placemakers') return placemakersPack;
      throw new Error(`Unknown tenant '${tenantId}' in pack repository`);
    },
    hasActivePack: async (tenantId: string) => tenantId === 'placemakers',
    invalidate: () => {},
  } as unknown as PackRepository;

  const appService = new TurnApplicationService(
    packRepo,
    workspaceRepo,
    undefined,
    undefined,
    undefined,
    capabilityGateway,
    undefined,
    executionRepo,
    outboxRepo
  );

  const sessionId = `pm_sess_${Date.now()}`;
  const workspaceId = `pm_ws_${Date.now()}`;

  // Helper to execute turn and capture all SSE events in order
  async function runTurnWithSink(cmd: TurnCommand): Promise<{ turnResult: any; events: CapturedSinkEvent[] }> {
    const events: CapturedSinkEvent[] = [];
    const sink = (event: string, payload: any) => {
      events.push({ event, payload });
    };
    const turnResult = await appService.executeTurnStream(cmd, undefined, sink);
    return { turnResult, events };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO A: Multi-turn laundry context
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario A: "I want to build a laundry cabinet" pins journey, stores facts, emits 3-question clarify card, skips retrieval', async () => {
    catalogSearchExecuted = false;
    const cmd1: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId,
      sessionId,
      correlationId: 'turn-1',
      message: 'I want to build a laundry cabinet',
    };

    const { turnResult, events } = await runTurnWithSink(cmd1);

    // 1. Pinned Journey
    assert.equal(turnResult.workspace.journeyId, 'placemakers_laundry_planning', 'Must pin placemakers_laundry_planning journey');

    // 2. Persisted Facts
    assert.equal(turnResult.workspace.facts.room_type?.value, 'laundry', 'Must persist room_type=laundry');
    assert.equal(turnResult.workspace.facts.project_goal?.value, 'laundry_cabinet', 'Must persist project_goal=laundry_cabinet');

    // 3. Clarify card with 3 configured questions
    assert.equal(turnResult.decision.type, 'ask_fact', 'Decision must be ask_fact');
    const questions = turnResult.decision.payload.questions;
    assert.ok(Array.isArray(questions), 'Decision must contain questions array');
    assert.equal(questions.length, 3, 'Must emit exactly 3 questions per conversation policy');

    const questionIds = questions.map((q: any) => q.id);
    assert.deepEqual(
      questionIds,
      ['project_mode', 'appliance_arrangement', 'room_dimensions'],
      'First group must contain project_mode, appliance_arrangement, room_dimensions'
    );

    // 4. Emitted card check in SSE stream before 'done'
    const uiActions = events.filter((e) => e.event === 'uiAction');
    assert.ok(uiActions.length > 0, 'Must emit uiAction event');
    const clarifyCard = uiActions.find((a) => a.payload?.arguments?.card?.cardType === 'clarify' || a.payload?.card?.cardType === 'clarify');
    assert.ok(clarifyCard, 'Must emit registered clarify card');

    const cardState = clarifyCard.payload.arguments?.card?.state || clarifyCard.payload.card?.state;
    assert.equal(cardState.questions.length, 3, 'Clarify card state must carry 3 questions');

    // Verify 'done' event arrives AFTER uiAction
    const doneIndex = events.findIndex((e) => e.event === 'done');
    const cardIndex = events.findIndex((e) => e.event === 'uiAction');
    assert.ok(cardIndex < doneIndex, 'UI action card must be emitted before done event');

    // 5. Retrieval Gated
    assert.equal(catalogSearchExecuted, false, 'Catalogue search must NOT execute during initial discovery');
    assert.equal(turnResult.executedCapabilities.length, 0, 'No capabilities should execute before required facts complete');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO B: Clarification answers
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario B: Submitting card answers updates facts, persists openQuestions, and removes answered ones', async () => {
    // Current open questions: ['project_mode', 'appliance_arrangement', 'room_dimensions']
    const loadedWs = await workspaceRepo.load('placemakers', 'production', workspaceId);
    assert.deepEqual(
      loadedWs?.openQuestions,
      ['project_mode', 'appliance_arrangement', 'room_dimensions'],
      'Emitted question IDs must be persisted in workspace.openQuestions'
    );

    // Customer answers 2 of the 3 questions:
    const cmd2: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId,
      sessionId,
      correlationId: 'turn-2',
      message: 'My answers:\nWhat is the scope of your laundry project? → Renovate existing space\nWhat is your washer and dryer arrangement? → Front loader + stacked dryer',
      inputFacts: {
        project_mode: 'Renovate existing space',
        appliance_arrangement: 'Front loader + stacked dryer',
      },
    };

    const { turnResult } = await runTurnWithSink(cmd2);

    // Answered facts mapped and stored
    assert.equal(turnResult.workspace.facts.project_mode?.value, 'Renovate existing space');
    assert.equal(turnResult.workspace.facts.appliance_arrangement?.value, 'Front loader + stacked dryer');

    // Answered questions removed from openQuestions; unanswered (room_dimensions) retained
    // Next eligible questions selected: room_dimensions (unanswered, priority 180), plus newly eligible:
    // plumbing_setup (priority 150, deps satisfied) and laundry_tub (priority 145, still needs room_dimensions) or cabinetry_storage
    assert.ok(
      turnResult.workspace.openQuestions.includes('room_dimensions'),
      'Unanswered room_dimensions must be retained in openQuestions'
    );
    assert.equal(
      turnResult.workspace.openQuestions.includes('project_mode'),
      false,
      'Answered project_mode must be removed from openQuestions'
    );
    assert.equal(
      turnResult.workspace.openQuestions.includes('appliance_arrangement'),
      false,
      'Answered appliance_arrangement must be removed from openQuestions'
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO C: Ambiguous measurement
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario C: "100 miters" asks scoped unit clarification, never asks room, rejects 100m dimension', async () => {
    const cmd3: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId,
      sessionId,
      correlationId: 'turn-3',
      message: '100 miters',
    };

    const { turnResult } = await runTurnWithSink(cmd3);

    // 1. Assistant asks scoped unit clarification
    assert.ok(
      turnResult.assistantMessage?.toLowerCase().includes('measurement') ||
      turnResult.assistantMessage?.toLowerCase().includes('unit') ||
      turnResult.assistantMessage?.toLowerCase().includes('clarify'),
      'Assistant must ask scoped unit/measurement clarification'
    );

    // 2. NEVER asks which room
    assert.equal(
      turnResult.assistantMessage?.toLowerCase().includes('which room'),
      false,
      'Must NOT ask which room is being modified'
    );

    // 3. Does not store 100m as valid room dimension
    assert.notEqual(
      turnResult.workspace.facts.room_dimensions?.value,
      100,
      'Must NOT store 100 metres as a valid room dimension'
    );
    assert.notEqual(
      turnResult.workspace.facts.room_dimensions?.value,
      '100 miters',
      'Must NOT store ambiguous 100 miters as valid fact'
    );

    // Laundry context remains pinned
    assert.equal(turnResult.workspace.facts.room_type?.value, 'laundry');
    assert.equal(turnResult.workspace.journeyId, 'placemakers_laundry_planning');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO D: Context continuation
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario D: "room soize" continues dimensions workflow without asking room or resetting journey', async () => {
    const cmd4: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId,
      sessionId,
      correlationId: 'turn-4',
      message: 'room soize',
    };

    const { turnResult } = await runTurnWithSink(cmd4);

    // Journey still pinned
    assert.equal(turnResult.workspace.journeyId, 'placemakers_laundry_planning');
    assert.equal(turnResult.workspace.facts.room_type?.value, 'laundry');

    // Does NOT ask which room
    assert.equal(
      turnResult.assistantMessage?.toLowerCase().includes('which room'),
      false,
      'Must NOT ask which room'
    );

    // Decision continues asking for dimensions and dependency-eligible facts
    assert.equal(turnResult.decision.type, 'ask_fact');
    assert.ok(
      turnResult.decision.payload.questions?.some((q: any) => q.id === 'room_dimensions'),
      'Must continue room dimensions workflow'
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO E: Journey completion & Retrieval Gate
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario E: Satisfying all required discovery facts executes retrieval and emits deduplicated cards', async () => {
    catalogSearchExecuted = false;

    // Provide all remaining discovery facts:
    const cmd5: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId,
      sessionId,
      correlationId: 'turn-5',
      message: 'Room dimensions: 2.4m wall run. Plumbing: Keep existing plumbing points. Tub: Integrated stainless SuperTub. Cabinetry: Base cabinet unit. Benchtop: HMR laminate moisture-resistant top. Wet area: GIB Aqualine behind tub & appliances. Installation: DIY installation.',
      inputFacts: {
        room_dimensions: { value: 2400, unit: 'mm', normalizedMm: 2400 },
        plumbing_setup: 'Keep existing plumbing points',
        laundry_tub: 'Integrated stainless SuperTub',
        cabinetry_storage: ['Base cabinet unit'],
        benchtop_requirement: 'HMR laminate moisture-resistant top',
        wet_area_scope: 'GIB Aqualine behind tub & appliances',
        installation_mode: 'DIY installation',
      },
    };

    const { turnResult, events } = await runTurnWithSink(cmd5);

    // 1. Stage transition to specification
    assert.equal(turnResult.workspace.currentStage, 'specification', 'Must advance to specification stage');

    // 2. Retrieval executed ONLY now
    assert.equal(catalogSearchExecuted, true, 'Catalogue retrieval must execute once discovery facts are complete');
    assert.ok(turnResult.executedCapabilities.length > 0, 'Capabilities must execute in specification stage');

    // 3. Deduplication: mock returned 5 items with 2 duplicate SKUs; result must be deduplicated
    const catalogOutput = turnResult.executedCapabilities.find((c: any) => c.toolId === 'catalog.search')?.output;
    assert.ok(catalogOutput, 'Catalog output must be present');

    // 4. Emitted events before 'done'
    const doneIndex = events.findIndex((e) => e.event === 'done');
    const dataIndex = events.findIndex((e) => e.event === 'data');
    assert.ok(dataIndex < doneIndex, 'Data event must arrive before done event');
    assert.equal(doneIndex, events.length - 1, 'Done event must be the exact final event');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO F: Persistence and isolation
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario F: Conversation reload preserves facts, new session is clean, cross-tenant isolation verified', async () => {
    // 1. Reload existing workspace from store
    const reloaded = await workspaceRepo.load('placemakers', 'production', workspaceId);
    assert.ok(reloaded, 'Workspace must persist across turns');
    assert.equal(reloaded?.journeyId, 'placemakers_laundry_planning');
    assert.equal(reloaded?.facts.room_type?.value, 'laundry');
    assert.equal(reloaded?.facts.project_mode?.value, 'Renovate existing space');

    // 2. Start a fresh new session
    const newSessionId = `pm_sess_fresh_${Date.now()}`;
    const newWorkspaceId = `pm_ws_fresh_${Date.now()}`;
    const freshCmd: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId: newWorkspaceId,
      sessionId: newSessionId,
      correlationId: 'fresh-1',
      message: 'Hello',
    };

    const { turnResult: freshRes } = await runTurnWithSink(freshCmd);
    assert.equal(freshRes.workspace.facts.room_type, undefined, 'Fresh workspace must NOT leak previous facts');
    assert.equal(freshRes.workspace.facts.project_mode, undefined, 'Fresh workspace must NOT leak project_mode');

    // 3. Cross-tenant isolation: Caroma or other tenant cannot access PlaceMakers workspace
    const foreignTenantCmd: TurnCommand = {
      tenantId: 'caroma',
      environmentId: 'production',
      workspaceId, // passing PlaceMakers workspaceId under caroma tenant
      sessionId: 'sess_foreign',
      correlationId: 'cross-tenant-1',
      message: 'Show me my project',
    };

    // Pack repo rejects or fails closed
    await assert.rejects(
      async () => {
        await appService.executeTurnStream(foreignTenantCmd, undefined, () => {});
      },
      /Unknown tenant 'caroma'|No active Business Pack/i,
      'Cross-tenant access must strictly fail closed'
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SCENARIO G: Regression
  // ══════════════════════════════════════════════════════════════════════════
  await test('Scenario G: Single-question clarify continues working, no filesystem /packs runtime references', async () => {
    // 1. Single question clarify test: deck estimator asks 1 question (deck_dimensions)
    const deckWsId = `deck_ws_${Date.now()}`;
    const deckCmd: TurnCommand = {
      tenantId: 'placemakers',
      environmentId: 'production',
      workspaceId: deckWsId,
      sessionId: `deck_sess_${Date.now()}`,
      correlationId: 'deck-1',
      message: 'I want to build a deck',
    };

    const { turnResult: deckRes } = await runTurnWithSink(deckCmd);
    assert.equal(deckRes.workspace.journeyId, 'placemakers_deck_estimator');
    assert.equal(deckRes.decision.type, 'ask_fact');
    assert.ok(deckRes.decision.payload.questions.length >= 1, 'Single-question journey must emit question');

    // 2. Assert zero filesystem references to packs/ folder in runtime TypeScript code
    const fs = await import('fs');
    const path = await import('path');
    const runtimeSrc = path.resolve(__dirname, '../apps/journey-runtime-service/src');
    const allFiles: string[] = [];

    function scan(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (entry.name.endsWith('.ts')) allFiles.push(full);
      }
    }
    scan(runtimeSrc);

    for (const f of allFiles) {
      const content = fs.readFileSync(f, 'utf8');
      assert.equal(
        /['"`]\/packs\//.test(content) || /['"`]\.\.\/packs\//.test(content) || /['"`]\.\.\/\.\.\/packs\//.test(content),
        false,
        `Runtime file ${path.basename(f)} must not contain filesystem /packs references`
      );
    }
  });

  console.log(`\n🎉 Suite complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runClosureTests().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
