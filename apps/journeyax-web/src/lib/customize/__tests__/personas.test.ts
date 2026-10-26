/**
 * The persona library as the page reads it, and the scenario-to-tools check: for each use case, which tools it needs (from its playbooks and
 * from what people added) and whether the persona's team can use each one under the pack's rules.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/personas.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildOverview } from '../overview';
import { buildToolOptions } from '../toolOptions';
import { buildConnectorRules } from '../connectorRules';
import { checkScenarios, parsePersonaLibraryAnswer, toolIdsNamedIn, VERDICTS, type PersonaLibraryView } from '../personas';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const docs = path.resolve(__dirname, '../../../../../../docs/agent-instructions');
const draft = JSON.parse(readFileSync(path.join(docs, 'placemakers-draft.json'), 'utf8'));
const library = JSON.parse(readFileSync(path.join(docs, 'personas/placemakers-personas.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Sales Managers', 'Branch', 'Finance', 'Marketing', 'Insights', 'Leadership'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const connected = { salesforce: { checked: true as const, connected: true, missing: [] }, commercetools: { checked: true as const, connected: true, missing: [] } };
const overviewWith = (status: Record<string, any> = connected, edit: (p: any) => void = () => {}) => {
  const p = JSON.parse(JSON.stringify(pack));
  edit(p);
  const rules = buildConnectorRules(p.extensions.connectors, TEAMS, status);
  return buildOverview('placemakers', p, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(p, TEAMS), connectorRules: rules });
};
const overview = overviewWith();
const viewWith = (scenarioTools: Record<string, string[]> = {}, edit: (l: any) => void = () => {}): PersonaLibraryView => {
  const l = JSON.parse(JSON.stringify(library));
  edit(l);
  const answer = parsePersonaLibraryAnswer({ present: true, revision: 3, updatedAt: '2026-10-26T01:00:00Z', updatedBy: 'owner@example.com', library: l, scenarioTools });
  assert.ok(answer && answer.present);
  return answer as PersonaLibraryView;
};

console.log('reading the library');

check('the real library is read whole: 43 personas, 86 use cases, 13 teams, the tools people set', () => {
  const view = viewWith({ 'B06-UC01': ['salesforce.find_account'] });
  assert.equal(view.library.personas.length, 43);
  assert.equal(view.library.useCases.length, 86);
  assert.equal(view.library.teams.length, 13);
  assert.deepEqual([view.revision, view.updatedBy], [3, 'owner@example.com']);
  assert.deepEqual(view.scenarioTools, { 'B06-UC01': ['salesforce.find_account'] });
  assert.equal(view.library.personas.find((p) => p.id === 'C01')?.kind, 'customer');
  assert.equal(view.library.personas.find((p) => p.id === 'B02')?.team, 'customer-service');
});

check('nothing loaded is a plain answer; anything that is not the shape is refused, never half-read', () => {
  assert.deepEqual(parsePersonaLibraryAnswer({ present: false }), { present: false });
  for (const bad of [null, 'x', 7, {}, { present: true }, { present: true, revision: 1 }, { present: true, revision: 1, library: { personas: [] } }, { present: true, revision: 'one', library: { personas: [], useCases: [], teams: [] } }]) {
    assert.equal(parsePersonaLibraryAnswer(bad), null);
  }
  const lenient = parsePersonaLibraryAnswer({ present: true, revision: 1, library: { personas: [{ id: 'P1', name: 'Someone' }, { id: '' }, 5], useCases: [{ id: 'U1', personaId: 'P1', readiness: 'nonsense' }], teams: [] }, scenarioTools: { U1: ['a.b', 3], U2: 'x' } }) as PersonaLibraryView;
  assert.equal(lenient.library.personas.length, 1, 'an entry without an id or a name is dropped');
  assert.equal(lenient.library.useCases[0].readiness, 'partly ready', 'an unknown readiness reads as partly ready');
  assert.deepEqual(lenient.scenarioTools, { U1: ['a.b'] });
});

console.log('finding the tools a playbook names');

check('whole tool ids are found in text, not pieces of longer words', () => {
  const known = ['salesforce.list_cases', 'salesforce.get_case', 'commercetools.get_order'];
  assert.deepEqual(toolIdsNamedIn('Use salesforce.list_cases (accountId) then salesforce.get_case.', known).sort(), ['salesforce.get_case', 'salesforce.list_cases']);
  assert.deepEqual(toolIdsNamedIn('my_salesforce.list_cases and salesforce.list_cases_all', known), [], 'a longer name is not the tool');
  assert.deepEqual(toolIdsNamedIn('(commercetools.get_order)', known), ['commercetools.get_order']);
  assert.deepEqual(toolIdsNamedIn('', known), []);
});

console.log('the check');

check('a use case with a playbook is judged tool by tool for the persona\'s team', () => {
  const checks = checkScenarios(viewWith(), overview);
  const sales = checks.byUseCase['B01-UC01'];
  assert.deepEqual([sales.audience, sales.verdict], ['sales', 'ready']);
  assert.ok(sales.tools.length >= 5 && sales.tools.every((t) => t.from === 'playbook' && t.outcome === 'ok'));
  const csr = checks.byUseCase['B02-UC01'];
  assert.equal(csr.verdict, 'gaps');
  const blocked = csr.tools.filter((t) => t.outcome === 'blocked');
  assert.deepEqual(blocked.map((t) => t.id), ['salesforce.list_opportunities'], 'Customer Service may not read deals');
  assert.match(csr.issues.join(' '), /Blocked for Customer Service/);
  assert.equal(csr.summary, '1 thing in the way');
});

check('a tool that asks first still counts as working, and says so', () => {
  const cs = checkScenarios(viewWith(), overview).byUseCase['B13-UC01'];
  assert.equal(cs.verdict, 'ready');
  assert.equal(cs.tools.find((t) => t.id === 'salesforce.create_case')?.outcome, 'ask');
  assert.match(cs.summary, /1 asks first/);
});

check('a use case with no playbook and no tools is "no tools named" for staff and "not checked" for customers', () => {
  const checks = checkScenarios(viewWith(), overview);
  assert.equal(checks.byUseCase['B06-UC01'].verdict, 'unmapped');
  assert.equal(checks.byUseCase['C01-UC01'].verdict, 'unchecked');
  assert.equal(checks.byUseCase['C01-UC01'].audience, 'shopper');
});

check('tools a person adds are checked too, and a tool that is also in the playbook is marked as both', () => {
  const view = viewWith({ 'B06-UC01': ['commercetools.stock_by_branch'], 'B01-UC01': ['salesforce.get_account', 'salesforce.create_case'] });
  const checks = checkScenarios(view, overview);
  const estimating = checks.byUseCase['B06-UC01'];
  assert.equal(estimating.tools[0].from, 'you');
  assert.equal(estimating.tools[0].outcome, 'no-team', 'this project has no Estimating team yet, so no rule can allow the tool');
  assert.equal(estimating.verdict, 'gaps');
  const sales = checks.byUseCase['B01-UC01'];
  assert.equal(sales.tools.find((t) => t.id === 'salesforce.get_account')?.from, 'both');
  assert.equal(sales.tools.find((t) => t.id === 'salesforce.create_case')?.from, 'you');
});

check('customers never get a connected system: a tool added to a customer scenario is blocked, a built-in one works', () => {
  const view = viewWith({ 'C01-UC01': ['commercetools.find_product', 'present_card', 'no_such.tool'] });
  const c = checkScenarios(view, overview).byUseCase['C01-UC01'];
  assert.equal(c.tools.find((t) => t.id === 'commercetools.find_product')?.outcome, 'blocked');
  assert.equal(c.tools.find((t) => t.id === 'present_card')?.outcome, 'ok');
  assert.equal(c.tools.find((t) => t.id === 'no_such.tool')?.outcome, 'unknown');
  assert.equal(c.verdict, 'gaps');
});

check('a system that is switched off, or not connected, is named as the reason', () => {
  const off = checkScenarios(viewWith({ 'B01-UC01': ['power-bi.list_reports'] }), overview).byUseCase['B01-UC01'];
  const pb = off.tools.find((t) => t.id === 'power-bi.list_reports')!;
  assert.deepEqual([pb.outcome, pb.note], ['off', 'Power BI is switched off.']);
  const down = checkScenarios(viewWith(), overviewWith({ ...connected, commercetools: { checked: true, connected: false, missing: ['CT_CLIENT_ID'] } })).byUseCase['B01-UC01'];
  assert.equal(down.verdict, 'gaps');
  assert.ok(down.tools.some((t) => t.outcome === 'not-connected' && /needs CT_CLIENT_ID/.test(t.note)));
});

check('a playbook the assistant does not have is a gap', () => {
  const view = viewWith();
  const checks = checkScenarios(view, overviewWith(connected, (p) => { p.extensions.skills = p.extensions.skills.filter((s: any) => s.skillId !== 'account-360'); }));
  const sales = checks.byUseCase['B01-UC01'];
  assert.equal(sales.verdict, 'gaps');
  assert.deepEqual(sales.playbooks, [{ id: 'account-360', name: 'account-360', found: false }]);
  assert.match(sales.issues[0], /“account-360” is not in the assistant/);
});

check('the sheet calling a use case fully ready while its tools show a gap is flagged', () => {
  const view = viewWith({}, (l) => { l.useCases.find((u: any) => u.id === 'B02-UC01').readiness = 'fully ready'; });
  const c = checkScenarios(view, overview).byUseCase['B02-UC01'];
  assert.equal(c.disagrees, true);
  assert.equal(checkScenarios(viewWith(), overview).byUseCase['B02-UC01'].disagrees, false, 'it said partly ready, so there is nothing to flag');
});

check('totals add up: every use case is counted once, in its persona, its team (or the customers) and the whole', () => {
  const view = viewWith({ 'B06-UC01': ['salesforce.find_account'] });
  const checks = checkScenarios(view, overview);
  const sum = (c: Record<string, number>) => VERDICTS.reduce((n, v) => n + c[v], 0);
  assert.equal(sum(checks.totals), 86);
  assert.equal(sum(checks.customers), 38);
  assert.equal(Object.values(checks.byTeam).reduce((n, c) => n + sum(c), 0) + sum(checks.customers), 86);
  assert.equal(Object.values(checks.byPersona).reduce((n, c) => n + sum(c), 0), 86);
  assert.equal(sum(checks.byPersona['B02']), 2);
});

console.log(`✅ web: persona library and scenario check: ${passed} passed, 0 failed`);
