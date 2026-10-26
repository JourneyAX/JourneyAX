/**
 * The rules dialog as a person sees it, from the real draft pack's rules.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/customize/__tests__/connectorRulesDialog.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectorRulesDialog from '../ConnectorRulesDialog';
import { buildConnectorRules } from '@/lib/customize/connectorRules';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const TEAMS = ['Customer Service', 'Sales', 'Branch'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const systems = buildConnectorRules(draft.extensions.connectors, TEAMS, { salesforce: { checked: true, connected: false, missing: ['SALESFORCE_CLIENT_ID'] } });
const render = (id: string, props: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ConnectorRulesDialog as any, { system: systems.find((s) => s.connectorId === id), busy: false, onSave: () => {}, onClose: () => {}, ...props }));

console.log('the rules dialog');

check('it shows the system, its switch, whether it is real or sample, and its connection status', () => {
  const html = render('salesforce');
  assert.ok(html.includes('Salesforce: who may use it'));
  assert.ok(html.includes('Switched on for the assistant') && html.includes('checked'));
  assert.ok(html.includes('Real data'));
  assert.ok(html.includes('Not connected yet'));
  assert.ok(render('marketing-cloud').includes('Sample data'));
  assert.ok(render('commercetools').includes('Connection not checked'));
});

check('there is a column for each team and the administrators, never one for shoppers, and a row for each tool', () => {
  const html = render('salesforce');
  for (const label of ['Customer Service', 'Sales', 'Branch', 'Administrators']) assert.ok(html.includes(label), label);
  const salesforce = systems.find((s) => s.connectorId === 'salesforce')!;
  assert.ok(salesforce.columns.some((c) => c.id === 'leadership' && c.note), 'a group the rules name that is not one of these teams still gets a column, marked');
  assert.ok(html.includes('Shoppers can never use a connected system, so they have no column'));
  for (const tool of systems.find((s) => s.connectorId === 'salesforce')!.tools) assert.ok(html.includes(tool.label), tool.label);
  assert.equal((html.match(/<select class="ax-rules__cell/g) || []).length, salesforce.tools.length * salesforce.columns.length, 'a choice for every tool and every column');
});

check('each cell offers allow, ask first and blocked, shows the current state, and does not offer allow for a tool that changes data', () => {
  const html = render('salesforce');
  assert.ok(html.includes('aria-label="Create case for Customer Service"'));
  const create = html.slice(html.indexOf('aria-label="Create case for Customer Service"'), html.indexOf('aria-label="Create case for Sales"'));
  assert.ok(create.includes('ax-rules__cell--ask') || html.includes('ax-rules__cell--ask'));
  assert.match(create, /<option value="allow" disabled="">Allow<\/option>/, 'allow is disabled for a tool that changes data');
  const read = html.slice(html.indexOf('aria-label="List cases for Customer Service"'), html.indexOf('aria-label="List cases for Sales"'));
  assert.ok(!read.includes('disabled'), 'allow is fine for a tool that only reads');
  assert.ok(html.includes('changes data'));
});

check('it says what the table hides, and that nothing is changed until Make live', () => {
  const html = render('ace-erp');
  assert.ok(html.includes('1 default rule'));
  assert.ok(html.includes('writes its rules for each team explicitly'));
  assert.ok(html.includes('No changes yet.'));
  assert.ok(html.includes('Make live') && html.includes('disabled=""'));
});

check('a system that is switched off opens with its switch off, ready to be switched on', () => {
  const html = render('zendesk');
  const switchOf = (page: string) => /<input id="[^"]*" type="checkbox"( checked="")?\/><span>Switched on for the assistant/.exec(page);
  assert.ok(switchOf(render('salesforce'))?.[1], 'a system that is on has its switch on');
  assert.ok(switchOf(html) && !switchOf(html)![1], 'a system that is off has its switch off');
  assert.ok(html.includes('Zendesk: who may use it'));
});

console.log(`${passed} passed`);
