/**
 * The words for a step that reaches into a connected system.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/stepLabel.test.ts
 */
import assert from 'node:assert/strict';
import { connectorStepLabel, isCompletionNotice, UNKNOWN_STEP } from '../stepLabel';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('working strip: connector steps');

check('a known tool says what is being looked at', () => {
  assert.equal(connectorStepLabel('call_connector_tool', 'salesforce', 'list_cases'), 'Looking at open cases');
  assert.equal(connectorStepLabel('call_connector_tool', 'commercetools', 'order_history'), 'Looking at recent orders');
});

check('a tool without its own line says which system is being checked', () => {
  assert.equal(connectorStepLabel('call_connector_tool', 'salesforce', 'something_new'), 'Checking Salesforce');
  assert.equal(connectorStepLabel('call_connector_tool', 'commercetools'), 'Checking the order system');
  assert.equal(connectorStepLabel('call_connector_tool', 'a-new-system', 'x'), 'Checking a-new-system');
  assert.equal(connectorStepLabel('call_connector_tool'), 'Checking the company systems');
});

check('loading a system and listing systems read as plain steps', () => {
  assert.equal(connectorStepLabel('get_connector_tools', 'zendesk'), 'Opening Zendesk');
  assert.equal(connectorStepLabel('get_connector_tools'), 'Opening a connected system');
  assert.equal(connectorStepLabel('list_connectors'), 'Seeing which systems are connected');
});

check('no label carries a tool name, and a step that is not a connector one is left to the caller', () => {
  for (const label of [connectorStepLabel('call_connector_tool', 'salesforce', 'find_account'), connectorStepLabel('get_connector_tools', 'salesforce'), UNKNOWN_STEP]) {
    assert.ok(label && !/_/.test(label), String(label));
  }
  assert.equal(connectorStepLabel('search_products'), undefined);
});

check('a notice that a step finished is told apart from the step beginning', () => {
  assert.equal(isCompletionNotice({ toolId: 'call_connector_tool', status: 'success' }), true);
  assert.equal(isCompletionNotice({ toolId: 'call_connector_tool', status: 'failure' }), true);
  assert.equal(isCompletionNotice({ toolId: 'call_connector_tool', connector: 'salesforce', tool: 'list_cases' }), false);
  assert.equal(isCompletionNotice({ toolId: 'use_skill' }), false);
  assert.equal(isCompletionNotice(null), false);
});

console.log(`\n${passed} passed`);
