import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentDefinitionSchema,
  JourneyPlaybookSchema,
  normalizePlaybookStages,
} from '@journeyax/business-pack';
import {
  GENERIC_PLATFORM_OPERATING_PROMPT,
  formatAgentInstructions,
} from '../src/agent/agent-loop';
import {
  isReadOnlyTool,
  resolveBoundCapability,
  executeAgentTool,
  getAgentToolDefinitions,
  type AgentToolContext,
} from '../src/agent/agent-tools';
import { deriveJourneyChecklist } from '../src/agent/journey-checklist';
import { buildPlaceMakersStack, TENANT as PM_TENANT, ENVIRONMENT as PM_ENV } from './helpers/placemakers-stack';
import { buildAbercrombieStack, ABERCROMBIE_TENANT, ABERCROMBIE_ENV } from './helpers/abercrombie-stack';
import { readHistory } from '../src/conversation/history';
import { ModelGateway } from '../src/kernel/model.gateway';

test('P4: Journey as data, not code', async (t) => {
  await t.test('1. Schema & Normalization: JourneyPlaybookSchema and AgentDefinitionSchema', () => {
    // Stage schema verification
    const sampleStages = [
      {
        id: 's1',
        name: 'Discovery',
        goal: 'Understand customer requirements and identify suitable items',
        tools: ['search_products', 'get_journey_checklist'],
        exitCondition: 'Item is identified and selected',
      },
      {
        id: 's2',
        name: 'Verification',
        goal: 'Check accessories and stock',
        tools: ['check_stock', 'consult_business_knowledge'],
        exitCondition: 'Stock confirmed',
      },
    ];

    const parsedPlaybook = JourneyPlaybookSchema.parse({
      description: 'Standard multi-stage playbook',
      stages: sampleStages,
    });
    assert.equal(parsedPlaybook.stages.length, 2);

    // AgentDefinition with journeyPlaybook
    const agentDef = AgentDefinitionSchema.parse({
      agentId: 'journey_agent',
      purpose: 'Guides the customer through data-driven stages',
      modelPolicyRef: 'fast_intent',
      allowedTools: ['search_products', 'get_journey_checklist'],
      journeyPlaybook: sampleStages,
    });
    assert.ok(agentDef.journeyPlaybook);
    const stages = normalizePlaybookStages(agentDef.journeyPlaybook);
    assert.equal(stages.length, 2);
    assert.equal(stages[0].name, 'Discovery');
    assert.equal(stages[1].name, 'Verification');

    // Normalizes object format { stages: [...] } as well
    const stagesFromObj = normalizePlaybookStages({ stages: sampleStages });
    assert.equal(stagesFromObj.length, 2);
    assert.equal(stagesFromObj[0].name, 'Discovery');
  });

  await t.test('2. Platform Prompt & Instructions: Injects playbook and enforces clear next step', () => {
    // Generic platform prompt rules (Prompt P4 requirements)
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /after a selection event/i,
      'platform prompt instructs working through playbook follow-up after selection event'
    );
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /work through the playbook/i,
      'platform prompt instructs working through playbook follow-up stages'
    );
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /one clear.*next step/i,
      'platform prompt instructs always ending with one clear next step'
    );
    assert.match(
      GENERIC_PLATFORM_OPERATING_PROMPT,
      /get_journey_checklist/i,
      'platform prompt mentions get_journey_checklist tool'
    );

    // Formatted agent instructions include playbook stages
    const instructions = formatAgentInstructions({
      agent: {
        agentId: 'trade_rep',
        purpose: 'Trade specialist',
        modelPolicyRef: 'default',
        allowedTools: ['get_journey_checklist'],
        maxTurns: 3,
        handoffConditions: [],
        inputSchema: {},
        outputSchema: {},
        journeyPlaybook: [
          {
            name: 'Specification & Sizing',
            goal: 'Determine project dimensions and material specifications',
            tools: ['search_products'],
            exitCondition: 'Materials selected',
          },
          {
            name: 'Accessories & Fixings',
            goal: 'Select fasteners and accessories',
            tools: ['consult_business_knowledge'],
            exitCondition: 'Fasteners quoted',
          },
        ],
      },
      systemPrompt: 'Assist Kiwi tradespeople with accuracy.',
    });

    assert.match(instructions, /## Journey Playbook \(Ordered Stages\)/);
    assert.match(instructions, /Specification & Sizing/);
    assert.match(instructions, /Accessories & Fixings/);
    assert.match(instructions, /Tools: search_products/);
    assert.match(instructions, /Exit condition: Materials selected/);
  });

  await t.test('3. Tool Definition: get_journey_checklist is read-only and bound canonically', () => {
    assert.equal(isReadOnlyTool('get_journey_checklist'), true, 'get_journey_checklist is read-only');
    assert.equal(resolveBoundCapability(null, 'get_journey_checklist'), 'journey.checklist');

    const defs = getAgentToolDefinitions();
    const chkTool = defs.find((t) => t.name === 'get_journey_checklist');
    assert.ok(chkTool, 'get_journey_checklist is present in AGENT_TOOL_DEFINITIONS');
    assert.match(chkTool.description, /checklist|progress|playbook/i);
  });

  await t.test('4. Unit Derivation: deriveJourneyChecklist extracts past events, history actions, and playbook stage status', async () => {
    const mockContext: AgentToolContext = {
      tenantId: 'test_tenant',
      environmentId: 'test',
      correlationId: 'corr-unit-chk',
      turnProductSkus: new Set(),
      catalogProductCache: new Map(),
      readSourceIds: new Set(['src-fixing-guide']),
      allowedClaimClasses: new Set(),
      presentedCards: [],
      isHumanHandoffRequested: false,
      release: {
        manifest: { packId: 'test', version: '1.0.0', tenantId: 'test_tenant' },
      } as any,
      workspace: {
        tenantId: 'test_tenant',
        environmentId: 'test',
        workspaceId: 'ws-unit-1',
        packVersionId: '1.0.0',
        journeyId: 'j1',
        currentStage: 'init',
        goal: 'test',
        facts: {
          customer_events_log: {
            value: [
              {
                type: 'addToQuote',
                timestamp: '2026-10-22T10:00:00Z',
                payload: { sku: 'SKU-TIMBER-100', title: '100x50 Framing Timber', quantity: 12 },
              },
            ],
            updatedAt: new Date().toISOString(),
          },
          conversation_history: {
            value: [
              {
                role: 'tool_summary',
                content: 'Ran consult_business_knowledge -> topic="fasteners and fixing accessories"',
              },
              {
                role: 'tool_summary',
                content: 'Ran check_stock -> SKU SKU-TIMBER-100 available at Penrose branch (quantity: 45)',
              },
            ],
          },
        },
        decisions: [],
        selectedObjects: [],
        openQuestions: [],
        status: 'active',
        stateVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      agentPlaybook: [
        {
          name: 'Material Discovery',
          goal: 'Select target materials',
          tools: ['search_products'],
          exitCondition: 'Materials selected',
        },
        {
          name: 'Accessory & Fastener Check',
          goal: 'Verify fixing requirements',
          tools: ['consult_business_knowledge'],
          exitCondition: 'Fixings confirmed',
        },
        {
          name: 'Branch Stock & Availability',
          goal: 'Verify branch stock',
          tools: ['check_stock'],
          exitCondition: 'Stock confirmed',
        },
        {
          name: 'Quote Finalization',
          goal: 'Finalize quote delivery',
          tools: ['create_quote'],
          exitCondition: 'Quote delivered',
        },
      ],
      catalogSearchHandler: null as any,
    };

    const derived = await executeAgentTool('get_journey_checklist', {}, mockContext);
    assert.ok(derived);
    assert.equal(derived.productsSelected.length, 1);
    assert.equal(derived.productsSelected[0].sku, 'SKU-TIMBER-100');
    assert.equal(derived.productsSelected[0].quantity, 12);
    assert.equal(derived.accessoriesChecked, true, 'identified accessories consulted from history');
    assert.equal(derived.stockChecked, true, 'identified stock checked from history');
    assert.equal(derived.eventsRecorded.length, 1);

    // Playbook stages progress evaluation
    assert.ok(Array.isArray(derived.playbookStages));
    assert.equal(derived.playbookStages.length, 4);
    assert.equal(derived.playbookStages[0].status, 'completed', 'Material Discovery completed by product selection');
    assert.equal(derived.playbookStages[1].status, 'completed', 'Accessory check completed by knowledge lookup');
    assert.equal(derived.playbookStages[2].status, 'completed', 'Branch stock completed by check_stock');
    assert.equal(derived.playbookStages[3].status, 'in_progress', 'Final quote delivery is currently in progress');
    assert.match(derived.summary, /1 product\(s\) selected/i);
    assert.match(derived.nextStep, /Continue with: Quote Finalization/i);
  });

  for (const input of [
    { name: 'PlaceMakers', tenant: PM_TENANT, environment: PM_ENV, build: () => buildPlaceMakersStack({ agentMode: true }), event: 'addToQuote', sku: '1000100' },
    { name: 'Abercrombie', tenant: ABERCROMBIE_TENANT, environment: ABERCROMBIE_ENV, build: buildAbercrombieStack, event: 'addToCart', sku: 'SKU-HOODIE-1' },
  ]) await t.test(`${input.name}: a browser selection retains context but cannot fabricate a cart receipt or require a stage follow-up`, async () => {
    const stack = await input.build();
    const model = new ModelGateway();
    const reply = 'I can review that selection with you. What would you like to check?';
    const requests: any[] = [];
    model.mockAgentExecutor = async (request, onDelta) => {
      requests.push(request);
      if (request.messages.some(message => typeof message.content === 'string' && message.content.includes('Answer with yes or no'))) return { content: 'no', toolCalls: [] };
      onDelta?.(reply);
      return { content: reply, toolCalls: [] };
    };
    const service = (stack.serviceFor as any)({ servePacks: true, modelGateway: model });
    const workspaceId = `selection-${input.tenant}`;
    const turn = await service.executeTurn({ tenantId: input.tenant, environmentId: input.environment, workspaceId, sessionId: workspaceId, turnId: 'selection-1', customerEvent: { type: input.event, payload: { sku: input.sku, quantity: 1 }, sourceCard: { cardType: 'products' } } });
    assert.ok(requests.length > 0, 'the model chooses the conversational response');
    assert.equal(turn.assistantMessage, reply);
    assert.equal(turn.workspace.facts.last_customer_event.value.payload.sku, input.sku);
    assert.equal(turn.workspace.facts.commerce_cart, undefined, 'an untrusted browser event is not a committed cart');
    assert.equal(turn.workspace.facts.support_requests, undefined);
    assert.ok(readHistory(turn.workspace.facts).length > 0, 'selection context persists for follow-up');
    assert.doesNotMatch(turn.assistantMessage || '', /added.*(?:quote|cart)|now continue with|product\(s\) selected/i);
  });
});
