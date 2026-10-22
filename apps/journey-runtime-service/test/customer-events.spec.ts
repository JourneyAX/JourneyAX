import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlaceMakersStack, TENANT as PM_TENANT, ENVIRONMENT as PM_ENV } from './helpers/placemakers-stack';
import { buildAbercrombieStack, ABERCROMBIE_TENANT, ABERCROMBIE_ENV } from './helpers/abercrombie-stack';
import { readHistory } from '../src/conversation/history';
import { resolveCustomerEventAction } from '../src/kernel/customer-event-policy';
import { CustomerEventRequestSchema } from '../src/dto/turn.dto';

test('P3: Customer actions are events, not silent local state', async (t) => {
  await t.test('1. Schema & policy: CustomerEventRequestSchema and tenant event policy resolution', async () => {
    // Valid event structure
    const validEvent = {
      type: 'addToCart',
      payload: { sku: 'SKU-100', quantity: 2, title: 'Test Product' },
      sourceCard: { id: 'card-1', cardType: 'products', actionId: 'act-1' },
      timestamp: new Date().toISOString(),
    };
    const parsed = CustomerEventRequestSchema.safeParse(validEvent);
    assert.ok(parsed.success, 'Valid CustomerEvent parses cleanly');

    // Tenant-specific policy resolution
    const mockRelease = {
      conversationPolicy: {
        customerEvents: {
          autoTurnEvents: ['custom.start_turn', 'addToQuote'],
          recordOnlyEvents: ['custom.record_only', 'removeFromQuote'],
        },
      },
    };

    assert.equal(
      resolveCustomerEventAction('custom.start_turn', mockRelease),
      'start_turn',
      'respects tenant autoTurnEvents'
    );
    assert.equal(
      resolveCustomerEventAction('custom.record_only', mockRelease),
      'record_only',
      'respects tenant recordOnlyEvents'
    );
    assert.equal(
      resolveCustomerEventAction('removeFromQuote', mockRelease),
      'record_only',
      'removeFromQuote is record_only per tenant pack policy'
    );
  });

  await t.test('2. Building materials tenant (PlaceMakers): addToQuote starts agent turn; removeFromQuote is recorded only', async () => {
    const stack = await buildPlaceMakersStack({ agentMode: true });
    const service = stack.serviceFor({ servePacks: true });
    const workspaceId = 'ws-pm-customer-events';

    // Step A: Customer action "addToQuote" starts agent turn
    const turn1 = await service.executeTurn({
      tenantId: PM_TENANT,
      environmentId: PM_ENV,
      workspaceId,
      turnId: 'turn-pm-evt-1',
      customerEvent: {
        type: 'addToQuote',
        payload: {
          sku: '1000100',
          title: 'Exterior wood screw 8g x 50mm',
          quantity: 2,
        },
        sourceCard: {
          id: 'card-prod-1',
          cardType: 'products',
        },
      },
    });

    assert.ok(turn1.assistantMessage, 'addToQuote starts turn and produces assistant response');
    const msgLower = turn1.assistantMessage.toLowerCase();
    assert.ok(
      msgLower.includes('wood screw') || msgLower.includes('quote') || msgLower.includes('added'),
      `assistant acknowledges quote action (got: "${turn1.assistantMessage}")`
    );

    // Verify history recorded the customer action
    const history1 = readHistory(turn1.workspace.facts);
    assert.ok(
      history1.some((h) => h.role === 'customer' && h.content.includes('addToQuote')),
      'customer turn recorded in conversation history'
    );

    // Step B: Secondary action "removeFromQuote" is recorded only without starting an agent turn per policy
    const turn2 = await service.executeTurn({
      tenantId: PM_TENANT,
      environmentId: PM_ENV,
      workspaceId,
      turnId: 'turn-pm-evt-2',
      customerEvent: {
        type: 'removeFromQuote',
        payload: {
          sku: '1000100',
        },
        sourceCard: {
          cardType: 'cart',
        },
      },
    });

    // Per policy: recorded only, no assistant reply
    assert.equal(turn2.assistantMessage, undefined, 'removeFromQuote does not start an agent turn');
    assert.equal(turn2.trace?.eventRecorded, true, 'eventRecorded flag set in trace');
    assert.equal(turn2.trace?.eventType, 'removeFromQuote', 'trace records eventType');

    // Facts must record the event
    const lastEventFact = turn2.workspace.facts['last_customer_event']?.value as any;
    assert.ok(lastEventFact, 'last_customer_event fact exists in workspace');
    assert.equal(lastEventFact.type, 'removeFromQuote', 'recorded event type matches');

    const eventLogFact = turn2.workspace.facts['customer_events_log']?.value as any[];
    assert.ok(Array.isArray(eventLogFact) && eventLogFact.length >= 1, 'customer_events_log recorded in workspace');

    // Conversation history must include compact record of customer event
    const history2 = readHistory(turn2.workspace.facts);
    assert.ok(
      history2.some((h) => h.role === 'system' && h.content.includes('Customer Event: removeFromQuote')),
      'conversation history contains compact customer event record'
    );
  });

  await t.test('3. Apparel cart tenant (Abercrombie): addToCart starts agent turn; removeFromCart is recorded only', async () => {
    const stack = await buildAbercrombieStack();
    const service = stack.serviceFor();
    const workspaceId = 'ws-anf-customer-events';

    // Step A: Customer action "addToCart" starts agent turn
    const turn1 = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId,
      turnId: 'turn-anf-evt-1',
      customerEvent: {
        type: 'addToCart',
        payload: {
          sku: 'SKU-HOODIE-1',
          title: 'Essential Popover Hoodie',
          quantity: 1,
        },
        sourceCard: {
          id: 'card-anf-1',
          cardType: 'products',
        },
      },
    });

    assert.ok(turn1.assistantMessage, 'addToCart starts turn and produces assistant response on apparel tenant');
    const msgLower = turn1.assistantMessage.toLowerCase();
    assert.ok(
      msgLower.includes('hoodie') || msgLower.includes('cart') || msgLower.includes('added'),
      `assistant acknowledges cart action (got: "${turn1.assistantMessage}")`
    );

    // Verify history recorded the customer action
    const history1 = readHistory(turn1.workspace.facts);
    assert.ok(
      history1.some((h) => h.role === 'customer' && h.content.includes('addToCart')),
      'customer turn recorded in apparel conversation history'
    );

    // Step B: Secondary action "removeFromCart" is recorded only without starting an agent turn per policy
    const turn2 = await service.executeTurn({
      tenantId: ABERCROMBIE_TENANT,
      environmentId: ABERCROMBIE_ENV,
      workspaceId,
      turnId: 'turn-anf-evt-2',
      customerEvent: {
        type: 'removeFromCart',
        payload: {
          sku: 'SKU-HOODIE-1',
        },
        sourceCard: {
          cardType: 'cart',
        },
      },
    });

    // Per policy: recorded only, no assistant reply
    assert.equal(turn2.assistantMessage, undefined, 'removeFromCart does not start an agent turn');
    assert.equal(turn2.trace?.eventRecorded, true, 'eventRecorded flag set in trace for apparel tenant');
    assert.equal(turn2.trace?.eventType, 'removeFromCart', 'trace records eventType');

    // Facts must record the event
    const lastEventFact = turn2.workspace.facts['last_customer_event']?.value as any;
    assert.ok(lastEventFact, 'last_customer_event fact exists in workspace');
    assert.equal(lastEventFact.type, 'removeFromCart', 'recorded event type matches');

    // Conversation history must include compact record of customer event
    const history2 = readHistory(turn2.workspace.facts);
    assert.ok(
      history2.some((h) => h.role === 'system' && h.content.includes('Customer Event: removeFromCart')),
      'apparel conversation history contains compact customer event record'
    );
  });
});
