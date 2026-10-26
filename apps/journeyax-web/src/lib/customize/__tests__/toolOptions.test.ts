/**
 * The tools a skill may name, built from the real draft pack's connector rules.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/toolOptions.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILT_IN_TOOL_IDS, buildToolOptions, connectorToolIds } from '../toolOptions';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const TEAMS = ['customer-service', 'sales', 'branch', 'finance', 'marketing'].map((id) => ({ id, name: id }));
const options = buildToolOptions({ extensions: draft.extensions }, TEAMS);
const byId = new Map(options.map((o) => [o.id, o]));

console.log('tools a skill may name');

check('the built-in tools are listed first, without the skill-opening tool, each described', () => {
  assert.ok(!BUILT_IN_TOOL_IDS.includes('use_skill'));
  const builtIn = options.filter((o) => o.systemId === 'platform');
  assert.deepEqual(builtIn.map((o) => o.id), BUILT_IN_TOOL_IDS);
  assert.ok(builtIn.every((o) => o.summary.length > 10 && o.enabled && !o.states));
  assert.equal(options.slice(0, builtIn.length).every((o) => o.systemId === 'platform'), true);
});

check('every tool of every connected system is listed once as system.tool, as the pack lists them', () => {
  const ids = options.filter((o) => o.systemId !== 'platform').map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...connectorToolIds(draft.extensions.connectors)].sort());
  assert.ok(byId.has('salesforce.list_cases') && byId.has('commercetools.get_order') && byId.has('marketing-cloud.send_message'));
  assert.equal(byId.get('salesforce.create_case')!.sideEffect, 'write');
  assert.equal(byId.get('salesforce.list_cases')!.system, 'Salesforce');
});

check('what each team may do with a tool is the pack\'s own rule: allowed, asked first or blocked, and shoppers are blocked from every connector tool', () => {
  const state = (id: string, who: string) => byId.get(id)!.states![who];
  assert.equal(state('salesforce.list_opportunities', 'sales'), 'allow');
  assert.equal(state('salesforce.list_opportunities', 'customer-service'), 'blocked');
  assert.equal(state('salesforce.create_case', 'customer-service'), 'ask');
  assert.equal(state('salesforce.create_case', 'sales'), 'ask');
  assert.equal(state('salesforce.create_case', 'branch'), 'ask');
  assert.equal(state('salesforce.create_case', 'finance'), 'blocked');
  assert.equal(state('commercetools.add_to_cart', 'branch'), 'ask');
  assert.equal(state('commercetools.stock_by_branch', 'finance'), 'blocked');
  assert.equal(state('commercetools.get_order', 'finance'), 'allow');
  assert.equal(state('marketing-cloud.send_message', 'marketing'), 'ask');
  for (const o of options.filter((x) => x.systemId !== 'platform')) assert.equal(o.states!.shopper, 'blocked', `${o.id} for shoppers`);
});

check('a system that is switched off is still listed, marked off, with the states its rules would give once on', () => {
  const report = byId.get('power-bi.list_reports')!;
  assert.equal(report.enabled, false);
  assert.equal(report.states!.marketing, 'allow');
  assert.equal(byId.get('zendesk.find_tickets')!.enabled, true);
  assert.equal(byId.get('salesforce.list_cases')!.enabled, true);
});

check('a pack with no connector table gives only the built-in tools, and junk in the table is skipped', () => {
  assert.equal(buildToolOptions({}, TEAMS).every((o) => o.systemId === 'platform'), true);
  assert.equal(buildToolOptions({ extensions: { connectors: 'nope' } }, TEAMS).length, BUILT_IN_TOOL_IDS.length);
  assert.deepEqual(connectorToolIds({ connectors: [null, { connectorId: '', tools: [{ name: 'x' }] }, { connectorId: 'a', tools: [{ name: 'b' }, {}, null] }] }), ['a.b']);
});

console.log(`${passed} passed`);
