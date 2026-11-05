import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentCommerceCapabilities, compileCommerceSettings } from '../src';
const scope = { tenantId: 'tenant-a', environmentId: 'test' };
const empty: any = { version: '1.0.0', toolDefinitions: [], toolBindings: [], stageBindings: [] };

test('agent commerce tools compile to canonical capabilities without a journey or stage', () => {
  const compiled = compileAgentCommerceCapabilities(empty, [{ allowedTools: ['update_cart', 'create_quote', 'update_quote'] }], scope);
  assert.deepEqual(compiled.toolDefinitions.map(tool => tool.toolId).sort(), ['cart.update', 'quote.create', 'quote.update']);
  assert.ok(compiled.toolDefinitions.every(tool => tool.sideEffect === 'write' && tool.idempotencyPolicy.required));
  assert.ok(compiled.toolBindings.every(binding => binding.tenantId === scope.tenantId && binding.environmentId === scope.environmentId));
  assert.deepEqual(compiled.stageBindings, []);
  assert.deepEqual(compileAgentCommerceCapabilities(compiled, [{ allowedTools: ['*'] }], scope), compiled);
  assert.equal(empty.toolDefinitions.length, 0);
});

test('explicit connector choices, confirmation requirements and disabled bindings survive compilation', () => {
  const configured: any = { ...empty, toolDefinitions: [{ toolId: 'update_cart', sideEffect: 'read' }], toolBindings: [{ toolId: 'update_cart', ...scope, executor: { type: 'mcp_tool', mcpServerName: 'commerce', mcpToolName: 'update_cart' }, enabled: false, policy: { requiredRole: 'manager', requiresConfirmation: true } }] };
  const compiled = compileAgentCommerceCapabilities(configured, [{ allowedTools: ['update_cart'] }], scope);
  const binding = compiled.toolBindings.find(entry => entry.toolId === 'cart.update')!;
  assert.equal(binding.enabled, false);
  assert.equal(binding.policy.requiredRole, 'manager');
  assert.equal(binding.policy.requiresConfirmation, true);
  assert.equal(binding.executor.type, 'mcp_tool');
  assert.equal(compiled.toolDefinitions[0].sideEffect, 'write');
  assert.equal(compileAgentCommerceCapabilities(empty, [{ allowedTools: ['search_products'] }], scope).toolDefinitions.length, 0);
});


test('merchant pricing is frozen from the Studio form without invented tax or mutable runtime reads', () => {
  const pricing = { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0, monthlyCap: 100 };
  const frozen: any = compileCommerceSettings(pricing, { quoteTitle: 'Merchant quote', pricing: { taxRate: 0.2 } });
  assert.deepEqual(frozen.pricing, { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 });
  assert.equal(frozen.quoteTitle, 'Merchant quote');
  assert.throws(() => compileCommerceSettings({ currency: 'NZD', symbol: '$' }), /tax and discount/);
  assert.throws(() => compileCommerceSettings({ ...pricing, taxRate: '0.15' }), /tax and discount/);
});

test('an explicitly selected checkout receipt tool publishes an owner-scoped read capability without a journey', () => {
  const compiled = compileAgentCommerceCapabilities(empty, [{ allowedTools: ['get_checkout_receipt'] }], scope);
  assert.equal(compiled.toolDefinitions.length, 1);
  assert.equal(compiled.toolDefinitions[0].sideEffect, 'read');
  assert.equal(compiled.toolBindings[0].agentTool, 'get_checkout_receipt');
  assert.equal(compiled.toolBindings[0].executor.nativeHandler, 'checkout.receipt');
  assert.deepEqual(compiled.stageBindings, []);
});
