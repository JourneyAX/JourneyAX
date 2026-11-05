import '../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { resolveAccess } from '../packages/business-pack/src/access';
import { operationalDesksFor, OperationalDesksSchema } from '../packages/business-pack/src/operational-desks';
import { JaxOntologyReleaseSchema } from '../packages/jax-iq/src/model/schema';

const read = (name: string) => JSON.parse(readFileSync(resolve(__dirname, '../docs/integration-contracts/placemakers', name), 'utf8'));
const overlay = read('release-overlay.json');
const operations = JaxOntologyReleaseSchema.parse(read('operations.json'));
const desks = OperationalDesksSchema.parse(read('desks.json'));
const registry = read('connectors.json');

test('all existing teams select a configured assistant without exposing staff agents to a shopper', () => {
  for (const group of ['sales', 'sales-managers', 'branch', 'finance', 'marketing', 'insights', 'leadership']) {
    assert.equal(resolveAccess(overlay.agents, overlay.extensions.agentAccess, { audience: 'staff', groups: [group] }).defaultAgentId, 'placemakers_staff_assistant', group);
  }
  assert.equal(resolveAccess(overlay.agents, overlay.extensions.agentAccess, { audience: 'staff', groups: ['customer-service'] }).defaultAgentId, 'placemakers_customer_service');
  const shopper = resolveAccess(overlay.agents, overlay.extensions.agentAccess, { audience: 'shopper', groups: [] });
  assert.deepEqual(shopper.agents.map(agent => agent.agentId), ['placemakers_product_advisor']);
  assert.equal(operationalDesksFor(desks, { audience: 'shopper', groups: [] }).length, 0);
});

test('operational desks follow existing source grants; unrelated teams receive no order backlog', () => {
  for (const group of ['customer-service', 'sales-managers', 'branch', 'finance', 'leadership', 'administrators']) {
    assert.ok(operationalDesksFor(desks, { audience: 'staff', groups: [group] }).some(desk => desk.deskId === 'commerce-orders'));
    assert.ok(registry.policy.some((row: any) => row.connectorId === 'commercetools' && row.tool === 'list_orders' && row.state === 'allow' && row.groups.includes(group)));
  }
  for (const group of ['marketing', 'insights', 'sales']) assert.ok(!operationalDesksFor(desks, { audience: 'staff', groups: [group] }).some(desk => desk.deskId === 'commerce-orders'), group);
  for (const group of ['sales', 'sales-managers', 'branch', 'finance', 'marketing', 'insights', 'leadership']) {
    assert.ok(!registry.policy.some((row: any) => row.state === 'allow' && registry.connectors.find((source: any) => source.connectorId === row.connectorId)?.tools.some((tool: any) => tool.name === row.tool && tool.sideEffect === 'write') && row.groups.includes(group)), `no automatic writes for ${group}`);
    const visibleFacts = operations.permissionRules.filter(rule => rule.mode === 'see' && rule.who.some(who => who.groups?.includes(group))).flatMap(rule => rule.target.facts ?? []);
    for (const field of ['Account.crmPhone', 'Account.commerceAddresses']) assert.ok(!visibleFacts.includes(field), `no new contact permission for ${group}`);
  }
});

test('order canvas and chat use the same IQ dictionary and exact source order number', () => {
  const desk = desks.desks.find(item => item.deskId === 'commerce-orders')!;
  assert.equal(desk.source.connector, operations.selfConnector);
  assert.equal(desk.detail.source.connector, operations.selfConnector);
  const order = operations.things.find(thing => thing.thing === 'Order')!;
  assert.deepEqual(order.sourceIdentity, { system: 'commercetools', keyKind: 'order_number' });
  const binding = operations.bindings.find(item => item.target.kind === 'link' && item.target.link === 'CommerceOverview.orders')!;
  assert.equal(binding.system, order.sourceIdentity!.system);
  assert.equal(binding.rows!.keyField, 'orderNumber');
  assert.equal(binding.rows!.keyKind, order.sourceIdentity!.keyKind);
  for (const factBinding of operations.bindings.filter(item => item.system === 'commercetools' && item.target.kind === 'fact' && item.target.fact.startsWith('Order.'))) {
    assert.deepEqual(factBinding.args.orderId, { from: 'key', kind: order.sourceIdentity!.keyKind }, 'the read must accept the exact source-native identity that IQ supplies');
  }
  const history = operations.bindings.find(item => item.target.kind === 'link' && item.target.link === 'Account.orders')!;
  assert.equal(history.rows!.keyKind, order.sourceIdentity!.keyKind);
  assert.equal(desk.preparation, undefined, 'order research cannot automatically propose a write');
});
