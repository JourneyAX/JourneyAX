/**
 * The Personas tab as a person sees it: team sections with persona cards, a persona's page with its use cases and the tools check, and the
 * dialog for adding the tools a scenario needs.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/customize/__tests__/personasPane.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PersonasPane, { PersonasView } from '../PersonasPane';
import ScenarioToolsDialog from '../ScenarioToolsDialog';
import { buildOverview } from '@/lib/customize/overview';
import { buildToolOptions } from '@/lib/customize/toolOptions';
import { buildConnectorRules } from '@/lib/customize/connectorRules';
import { checkScenarios, parsePersonaLibraryAnswer, type PersonaLibraryView } from '@/lib/customize/personas';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const docs = path.resolve(__dirname, '../../../../../../docs/agent-instructions');
const draft = JSON.parse(readFileSync(path.join(docs, 'placemakers-draft.json'), 'utf8'));
const library = JSON.parse(readFileSync(path.join(docs, 'personas/placemakers-personas.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Sales Managers', 'Branch', 'Finance', 'Marketing', 'Insights', 'Leadership'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const status = { salesforce: { checked: true as const, connected: true, missing: [] }, commercetools: { checked: true as const, connected: true, missing: [] } };
const rules = buildConnectorRules((pack.extensions as any).connectors, TEAMS, status);
const overview = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(pack, TEAMS), connectorRules: rules });
const reader = buildOverview('placemakers', pack, { canViewInstructions: false, canEdit: false });
const view = (scenarioTools: Record<string, string[]> = {}) => parsePersonaLibraryAnswer({ present: true, revision: 2, updatedAt: '2026-10-26T01:00:00Z', updatedBy: 'import-personas', library, scenarioTools }) as PersonaLibraryView;
const noop = () => {};
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(PersonasView as any, {
  overview, library: view(), query: '', open: null, onOpen: noop, onToast: noop, save: async () => ({ ok: true }), ...props,
}));

console.log('the personas list');

check('people who may not change the configuration are told the personas are not for them, and nothing is fetched', () => {
  const html = renderToStaticMarkup(React.createElement(PersonasPane as any, { overview: reader, query: '', tenant: 'placemakers', open: null, onOpen: noop, onToast: noop }));
  assert.ok(html.includes('Personas are for people who manage the assistant'));
  assert.ok(!html.includes('Customer Service'));
});

check('a summary says how many personas and use cases there are and when and by whom they were loaded, with the tools check in numbers', () => {
  const html = render({});
  assert.ok(html.includes('43 personas') && html.includes('86 use cases'));
  assert.ok(html.includes('loaded') && html.includes('import-personas'));
  assert.ok(html.includes('13 tools work') && html.includes('2 gaps') && html.includes('33 no tools named') && html.includes('38 not checked'));
});

check('each team is a section: live or planned, its note, who answers it, what it is waiting on, and its personas as cards', () => {
  const html = render({});
  for (const name of ['Customer Service', 'Sales', 'Branch', 'Finance', 'Operations', 'IT']) assert.ok(html.includes(name), name);
  assert.ok(html.includes('Live') && html.includes('Planned'));
  assert.ok(html.includes('Answered by placemakers_customer_service'));
  assert.ok(html.includes('No assistant is set up for this team yet.'));
  assert.ok(html.includes('Waiting on: ACE (sample, 2 use cases)'));
  assert.ok(html.includes('Trade Support Advisor / Telesales') && html.includes('2 use cases'));
  assert.equal((html.match(/class="ax-card"/g) || []).length, 24, 'a card for every member of staff');
});

check('customers are listed by group, and say why their scenarios are not checked', () => {
  const html = render({ initialView: 'customers' });
  assert.equal((html.match(/class="ax-card"/g) || []).length, 19);
  assert.ok(html.includes('DIY Retail Shopper') && html.includes('Retail B2C'));
  assert.ok(html.includes('never available to a shopper'));
});

check('searching narrows the cards (by name, description, group or a use case title) and says so when nothing matches', () => {
  const some = render({ query: 'Trade Support' });
  assert.ok(some.includes('Trade Support Advisor') && !some.includes('Warehouse Picker'));
  assert.ok(render({ query: 'zzzz-nothing' }).includes('No persona matches your search'));
});

console.log('one persona');

check('a persona\'s page: who they are, how they sign in, each use case with the sheet\'s word, the tools check and what is blocked and why', () => {
  const html = render({ open: 'B02' });
  assert.ok(html.includes('All personas'));
  assert.ok(html.includes('Trade Support Advisor / Telesales') && html.includes('Customer Service team'));
  assert.ok(html.includes('Signs in') && html.includes('As staff'));
  assert.ok(html.includes('Handle any account enquiry') && html.includes('Sheet: partly ready'));
  assert.ok(html.includes('1 thing in the way'));
  assert.ok(html.includes('Blocked') && html.includes('List opportunities') && html.includes('Blocked for Customer Service.'));
  assert.ok(html.includes('Playbook: Account 360 before a call or visit'));
  assert.ok(html.includes('Still missing, from the sheet: ACE (sample data only).'));
  assert.ok(html.includes('from the playbook'));
  assert.ok(html.includes('Edit tools'));
});

check('a use case whose tools all work says so, and one that asks first counts how many', () => {
  const html = render({ open: 'B13' });
  assert.ok(html.includes('Every tool works for Customer Service (1 asks first)'));
  assert.ok(html.includes('Asks first'));
});

check('a use case with nothing named says so; tools a person added show as added by them, and the button counts them', () => {
  const none = render({ open: 'B06' });
  assert.ok(none.includes('No tools named yet') && !none.includes('ax-toolrows'));
  const added = render({ open: 'B06', library: view({ 'B06-UC01': ['commercetools.stock_by_branch'] }) });
  assert.ok(added.includes('added by you') && added.includes('Edit tools (1 added)'));
  assert.ok(added.includes('No such team') && added.includes('This project has no team called “Estimating”'));
});

check('a persona the library does not have shows the list instead of an empty page', () => {
  const html = render({ open: 'NOPE' });
  assert.ok(html.includes('Staff teams') && !html.includes('All personas'));
});

console.log('the tools dialog');

const dialog = (props: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ScenarioToolsDialog as any, {
  title: 'Handle any account enquiry', audience: 'customer-service', audienceName: 'Customer Service', overview,
  fromPlaybook: checkScenarios(view(), overview).byUseCase['B02-UC01'].tools, current: [], busy: false, error: '', onSave: noop, onClose: noop, ...props,
}));

check('the dialog lists what the playbook already uses with the result, then every other tool by system with what it does for this team', () => {
  const html = dialog();
  assert.ok(html.includes('Tools for “Handle any account enquiry”'));
  assert.ok(html.includes('Already used by its playbook') && html.includes('List opportunities'));
  assert.ok(html.includes('Other tools it needs') && html.includes('Built-in tools') && html.includes('commercetools') && html.includes('Salesforce'));
  assert.ok(html.includes('for Customer Service'));
  assert.ok(html.includes('it does not give anyone a tool'), 'it says plainly that ticking changes nothing live');
  assert.ok(html.includes('No changes yet.') && /disabled=""[^>]*>Save tools/.test(html), 'saving is off until something changes');
});

check('tools already saved are ticked, and a saved tool the assistant no longer has is called out', () => {
  const html = dialog({ current: ['commercetools.stock_by_branch', 'gone.tool'] });
  assert.equal((html.match(/checked=""/g) || []).length, 1, 'the saved tool the assistant has is ticked; the one it lost has no box');
  assert.ok(html.includes('no longer has: gone.tool'));
});

check('a failed save shows its reason in the dialog', () => {
  assert.ok(dialog({ error: 'The persona library was changed since you loaded it.' }).includes('changed since you loaded it'));
  assert.ok(dialog({ busy: true }).includes('Saving…'));
});

console.log(`✅ web: Personas tab: ${passed} passed, 0 failed`);
