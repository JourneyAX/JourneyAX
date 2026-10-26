import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { normaliseGroupId } from '@journeyax/shared-types';
import { DEMO_STAFF, DEMO_TEAMS } from '../../../scripts/placemakers/demo-staff';
import { ROLES as COMMERCETOOLS_ROLES } from '../../../packages/connectors-real/scripts/loaders/commercetools-b2b';
import { attachScenarioHelp, buildLibrary, checkLibrary, coverageCsv, readinessOf, stableJson, stateOf, type Mapping, type PersonaLibrary, type SheetNames, type Sheets } from '../../../scripts/placemakers/personas';

/**
 * The persona library: the owner's three sheets read into one file, and the decisions that tie it to the pack. These checks keep the
 * committed library honest (it is exactly what the sheets and the mapping give), keep the demo logins and the pack's teams in step with the
 * catalogue, and pin the readiness numbers the owner has been given.
 */
const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, 'docs/agent-instructions/personas');
const NAMES: SheetNames = { personas: 'PlaceMakers_Personas_Import.csv', useCases: 'PlaceMakers_UseCases_Import.csv', accessModel: 'PlaceMakers_AccessModel.csv', ticketing: 'PlaceMakers_TicketingTools.csv' };
const sheets = Object.fromEntries((Object.keys(NAMES) as Array<keyof Sheets>).map((key) => [key, readFileSync(path.join(dir, 'source', NAMES[key]), 'utf8')])) as unknown as Sheets;
const mapping = JSON.parse(readFileSync(path.join(dir, 'mapping.json'), 'utf8')) as Mapping;
const committed = readFileSync(path.join(dir, 'placemakers-personas.json'), 'utf8');
const library = JSON.parse(committed) as PersonaLibrary;
const draft = JSON.parse(readFileSync(path.join(root, 'docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const asGroup = (team: string) => normaliseGroupId(team);

const suite = createSuite('project-service: the PlaceMakers persona library');

async function main() {
  await suite.test('the committed library is exactly what the sheets and the mapping give now, and building it twice gives the same bytes', () => {
    const cases = JSON.parse(readFileSync(path.join(dir, 'test-cases.json'), 'utf8')).cases;
    const logins = DEMO_STAFF.map((person) => ({ email: person.email, persona: person.persona, teams: person.teams }));
    const fresh = attachScenarioHelp(buildLibrary(sheets, NAMES, mapping), logins, cases);
    assert.equal(stableJson(fresh), committed, 'run scripts/placemakers/import-personas.ts again');
    assert.equal(stableJson(attachScenarioHelp(buildLibrary(sheets, NAMES, mapping), logins, cases)), stableJson(fresh));
  });

  await suite.test('every persona that needs a sign-in has a demo login to try it with: its own, its team\'s, or the shopper\'s / delegated buyer\'s; the rest have none', () => {
    const emails = new Set(DEMO_STAFF.map((person) => person.email));
    for (const persona of library.personas) if (persona.demoLogin) assert.ok(emails.has(persona.demoLogin), `${persona.id}: ${persona.demoLogin} is a demo login`);
    const login = (id: string) => library.personas.find((persona) => persona.id === id)?.demoLogin;
    assert.equal(login('B02'), 'csr@placemakers.demo', 'a persona with its own login');
    assert.equal(login('B03'), 'csr@placemakers.demo', 'a team leader uses the team\'s login');
    assert.equal(login('B08'), 'sales@placemakers.demo');
    assert.equal(login('C01'), 'shopper@placemakers.demo', 'a retail shopper');
    assert.equal(login('C05'), 'trade.buyer@placemakers.demo', 'a trade customer without a login of their own');
    assert.equal(login('C04'), 'trade.admin@placemakers.demo');
    assert.equal(login('C19'), undefined, 'a carrier signs in to nothing here');
    for (const persona of library.personas.filter((candidate) => candidate.kind === 'staff')) {
      const team = library.teams.find((candidate) => candidate.team === persona.team)!;
      assert.equal(Boolean(persona.demoLogin), team.status === 'live' && DEMO_STAFF.some((person) => person.teams.some((name) => asGroup(name) === persona.team)), `${persona.id} (${persona.team})`);
    }
  });

  await suite.test('the test set travels with the library: every case has the e-mail to sign in with, and the page the owner reads says the same', () => {
    assert.equal(library.testCases?.length, 32);
    for (const entry of library.testCases ?? []) assert.ok(DEMO_STAFF.some((person) => person.email === entry.loginEmail), `${entry.id}: ${entry.loginEmail}`);
    assert.ok(!JSON.stringify(library.testCases).includes('demo-2026'), 'no password in the library');
  });

  await suite.test('the sheets and the mapping agree: every persona, role, team and playbook the mapping names exists', () => {
    assert.deepEqual(checkLibrary(library, mapping), []);
  });

  await suite.test('the numbers the owner has been given: 43 personas, 86 use cases, 16 access roles, and 8 / 62 / 10 / 6 by how ready they are', () => {
    assert.deepEqual({ personas: library.counts.personas, customers: library.counts.customers, staff: library.counts.staff, useCases: library.counts.useCases, accessRoles: library.counts.accessRoles }, { personas: 43, customers: 19, staff: 24, useCases: 86, accessRoles: 16 });
    assert.deepEqual(library.counts.readiness, { 'fully ready': 8, 'partly ready': 62, 'sample or pending only': 10, 'not possible yet': 6 });
    assert.deepEqual(library.counts.priorityP0, { personas: 20, useCases: 40 });
    assert.equal(library.accessRoles.filter((role) => role.side === 'external').length, 10);
    assert.equal(library.accessRoles.filter((role) => role.side === 'business').length, 6);
    assert.equal(coverageCsv(library).trim().split('\n').length, 87, 'a header and a row for each use case');
  });

  await suite.test('readiness follows the systems a use case needs: all ready is fully ready, some ready is partly, none ready is sample-or-pending, and nothing at all is not possible yet', () => {
    const small: Mapping = { ...mapping, systemStates: { ready: ['Shop'], sample: ['ERP'], pending: ['BI'] } };
    assert.equal(readinessOf(['Shop', 'shop'], small).readiness, 'fully ready');
    assert.deepEqual(readinessOf(['Shop', 'ERP', 'Courier'], small), { readiness: 'partly ready', missing: ['ERP (sample data only)', 'Courier (not connected)'] });
    assert.equal(readinessOf(['ERP', 'BI'], small).readiness, 'sample or pending only');
    assert.equal(readinessOf(['ERP', 'Courier'], small).readiness, 'sample or pending only');
    assert.equal(readinessOf(['Courier', 'Tracker'], small).readiness, 'not possible yet');
    assert.equal(stateOf('  SHOP ', small), 'ready', 'case and spaces do not matter');
    assert.equal(stateOf('Something new', small), 'not-connected', 'a system nobody has decided about is not connected');
  });

  await suite.test('the ticket desk is Salesforce Service Cloud: the library says so, the pack has Salesforce on and Zendesk off', () => {
    assert.equal(library.ticketing.ourDesk, 'Salesforce Service Cloud');
    assert.ok(library.ticketing.tools.some((tool) => tool.tool === 'Salesforce Service Cloud' && /Confirmed PlaceMakers/.test(tool.status)));
    assert.equal(library.ticketing.tools.some((tool) => /zendesk/i.test(tool.tool)), false, 'Zendesk is not in the owner\'s list');
    const enabled = new Set((draft.extensions.connectors.connectors as Array<{ connectorId: string; enabled?: boolean }>).filter((connector) => connector.enabled !== false).map((connector) => connector.connectorId));
    assert.equal(enabled.has('salesforce'), true);
    assert.equal(enabled.has('zendesk'), false);
  });

  await suite.test('every demo login stands for a persona of the catalogue, staff are in the team the catalogue gives that persona, and customers are signed-in shoppers with no team', () => {
    const byId = new Map(library.personas.map((persona) => [persona.id, persona]));
    for (const person of DEMO_STAFF.filter((entry) => entry.persona)) {
      const persona = byId.get(person.persona!);
      assert.ok(persona, `${person.email} stands for ${person.persona}, who is in the catalogue`);
      if (persona!.kind === 'staff') {
        assert.deepEqual(person.teams.map(asGroup), [persona!.team], `${person.email} is in the team the catalogue gives ${persona!.id}`);
        assert.notEqual(person.role, 'buyer');
      } else {
        assert.deepEqual(person.teams, [], `${person.email} is a customer and is in no team`);
        assert.equal(person.role, 'buyer', `${person.email} signs in as a shopper`);
      }
    }
    assert.equal(DEMO_STAFF.length, 12);
    assert.equal(new Set(DEMO_STAFF.map((person) => person.email)).size, 12);
    assert.deepEqual(DEMO_STAFF.filter((person) => person.role === 'buyer').map((person) => person.persona), ['C02', 'C04', 'C08', 'C07'], 'a retail shopper, a trade account administrator, a delegated buyer and a site foreman');
  });

  await suite.test('the teams: every live team of the catalogue is a team the demo logins can be in and one the pack gives a rule or an assistant; a planned team has neither yet', () => {
    const demoGroups = new Set(DEMO_TEAMS.map((team) => asGroup(team.name)));
    const policyGroups = new Set((draft.extensions.connectors.policy as Array<{ groups: string[] }>).flatMap((row) => row.groups));
    const agentGroups = new Set((draft.extensions.agentAccess.rows as Array<{ groups?: string[] }>).flatMap((row) => row.groups ?? []));
    for (const team of library.teams) {
      const named = policyGroups.has(team.team) || agentGroups.has(team.team);
      if (team.status === 'live') {
        assert.ok(demoGroups.has(team.team), `${team.team} is a demo team`);
        assert.ok(named, `${team.team} has a connector rule or an assistant in the pack`);
        assert.ok(team.personas.length > 0 || team.team === 'sales-managers', `${team.team} has personas`);
      } else {
        assert.equal(demoGroups.has(team.team), false, `${team.team} is planned: no demo team yet`);
        assert.equal(policyGroups.has(team.team), false, `${team.team} is planned: the pack has no rule for it yet`);
        assert.ok(team.waitingOn.length > 0, `${team.team} says what it is waiting on`);
      }
    }
    for (const group of demoGroups) assert.ok(library.teams.some((team) => team.team === group && team.status === 'live'), `${group} is a live team of the catalogue`);
  });

  await suite.test('the customer roles that name a commercetools associate role name one the loader really creates, and the one that does not exist yet is called a gap', () => {
    const real = new Set(COMMERCETOOLS_ROLES.map((role) => role.key));
    for (const role of library.accessRoles.filter((entry) => entry.commercetoolsRole)) assert.ok(real.has(role.commercetoolsRole!), `${role.role} maps to ${role.commercetoolsRole}, which commercetools has`);
    const viewer = library.accessRoles.find((role) => role.role === 'Order/Job viewer')!;
    assert.ok(viewer.gap && /view-only/i.test(viewer.gap), 'site-manager can place orders, so the view-only job role is a named gap');
    assert.deepEqual(library.accessRoles.filter((role) => role.gap).map((role) => role.role).sort(), ['Buying-group user', 'Order/Job viewer', 'Supplier portal user']);
  });

  await suite.test('the playbooks: each one the mapping names is a skill of the pack, each use case it serves lists it, and every playbook of the pack serves a use case', () => {
    const skills = new Set((draft.skills as Array<{ skillId: string }>).map((skill) => skill.skillId));
    const accessed = new Set((draft.extensions.skillAccess.rows as Array<{ skillId: string }>).map((row) => row.skillId));
    assert.deepEqual([...accessed].sort(), Object.keys(mapping.playbooks).sort(), 'the pack\'s playbooks and the mapping\'s are the same set');
    for (const [playbook, ids] of Object.entries(mapping.playbooks)) {
      assert.ok(skills.has(playbook), `${playbook} is a skill of the pack`);
      assert.ok(ids.length > 0, `${playbook} serves a use case`);
      for (const id of ids) assert.ok(library.useCases.find((useCase) => useCase.id === id)!.playbooks.includes(playbook), `${id} lists ${playbook}`);
    }
    const p0 = library.useCases.filter((useCase) => useCase.priority === 'P0' && useCase.playbooks.length > 0);
    assert.ok(p0.length >= 12, `the first playbooks serve at least twelve P0 use cases (${p0.length})`);
  });

  await suite.test('the source copies and the mapping are in the repo and nothing in the library holds a secret or a clock', () => {
    for (const name of Object.values(NAMES)) assert.ok(existsSync(path.join(dir, 'source', name)), name);
    assert.doesNotMatch(committed, /password|secret|token/i);
    assert.doesNotMatch(committed, /\d{4}-\d{2}-\d{2}T\d{2}:/, 'no timestamp, so a second run changes nothing');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
