import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentTurnLoop } from '../src/agent/agent-loop';
import { ModelGateway } from '../src/kernel/model.gateway';
import { executeAgentTool } from '../src/agent/agent-tools';
import { captureSupportReceipt } from '../src/agent/support-handoff';
import { connectorPack, workspace } from './helpers/connector-pack';

async function turn(executor: any, message = 'Hello') {
  const model = new ModelGateway(); model.mockAgentExecutor = executor;
  return new AgentTurnLoop().execute({
    command: { tenantId: 'test-tenant', environmentId: 'test', workspaceId: 'ws', sessionId: 'ws', turnId: 'turn-1', correlationId: 'c-1', message, principalId: 'customer@example.com', principalRole: 'customer' } as any,
    release: connectorPack(), workspace: workspace(), modelGateway: model,
    catalogSearchHandler: { execute: async () => ({ items: [] }) } as any, sink: () => {},
  });
}
test('an ordinary conversation answer is not reported as completed commerce', async () => {
  const result = await turn(async (_request: any, delta: any) => { delta?.('How can I help?'); return { content: 'How can I help?', toolCalls: [] }; });
  assert.equal(result.turnResult.decision.type, 'respond');
});

test('product cards cannot turn unknown catalogue price or stock into model-supplied facts', async () => {
  const ctx: any = {
    tenantId: 'test-tenant', environmentId: 'test', release: connectorPack(), workspace: workspace(),
    readSourceIds: new Set(), turnProductSkus: new Set(['P1']),
    catalogProductCache: new Map([['P1', { sku: 'P1', title: 'Catalogued board' }]]),
    allowedClaimClasses: new Set(['catalog_fact', 'suggestion']), presentedCards: [],
  };
  const result = await executeAgentTool('present_card', { cardType: 'products', state: { products: [{ sku: 'P1', price: 1, inStock: true }] } }, ctx);
  assert.notEqual(result.ok, false);
  const product = ctx.presentedCards[0].state.products[0];
  assert.equal(product.price, undefined);
  assert.equal(product.inStock, undefined);
  assert.equal(product.availability, 'unknown');
});
test('a model failure returns failure without inventing human contact, success or a handoff tool trace', async () => {
  const result = await turn(async () => { throw new Error('fixture model unavailable'); });
  assert.equal(result.turnResult.decision.type, 'fail');
  assert.equal((result.turnResult.trace as any).handoffRequested, false);
  assert.equal(result.toolsCalled.some(tool => tool.name === 'hand_off_to_human'), false);
  assert.doesNotMatch(String(result.turnResult.assistantMessage), /notified|will assist|follow up/i);
});
test('support configuration and an actual ticket receipt are required before handoff success', async () => {
  const ctx: any = { tenantId: 'test-tenant', environmentId: 'test', principalId: 'customer@example.com', release: connectorPack(), workspace: workspace(), readSourceIds: new Set(), turnProductSkus: new Set(), catalogProductCache: new Map(), allowedClaimClasses: new Set(), presentedCards: [] };
  const result = await executeAgentTool('hand_off_to_human', { reason: 'Please help' }, ctx);
  assert.equal(result.handedOff, false); assert.equal(ctx.isHumanHandoffRequested, undefined);
  ctx.release.extensions.connectors = { connectors: [{ connectorId: 'support', tools: [{ name: 'create_case', sideEffect: 'write' }] }] };
  ctx.release.extensions.supportHandoff = { connector: 'support', tool: 'create_case', subject: 'Assistance', inputs: { subject: 'subject', description: 'description', requesterEmail: 'email' }, ticketIdPath: 'record.ticketId' };
  ctx.release.extensions.supportHandoff.receiptCard = { heading: 'Your request', title: 'Ticket {ticketId}', badge: 'Created' };
  assert.equal(captureSupportReceipt(ctx, 'support', 'create_case', { ok: true }), undefined);
  assert.equal(ctx.isHumanHandoffRequested, undefined);
  assert.deepEqual(captureSupportReceipt(ctx, 'support', 'create_case', { record: { ticketId: 'ticket-42' } }), { ticketId: 'ticket-42', connector: 'support' });
  assert.equal(ctx.workspace.facts.support_requests.value[0].ticketId, 'ticket-42');
  assert.equal(ctx.isHumanHandoffRequested, true);
  assert.equal(ctx.presentedCards[0].cardType, 'records');
  assert.equal(ctx.presentedCards[0].state.rows[0].title, 'Ticket ticket-42');
});
