import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSuite } from '@journeyax/test-support';
import { ADMIN_GROUP, normaliseGroups } from '@journeyax/shared-types';
import { connectorToolState, resolveSkillTiers, usableConnectors, type ConnectorsExtension } from '@journeyax/business-pack';
import { DEMO_STAFF, planDemoStaff } from '../../../scripts/placemakers/demo-staff';
import { casesMarkdown, type PersonaLibrary, type TestCase } from '../../../scripts/placemakers/personas';
import { buildAccessPreview } from '../src/access-preview';

/**
 * The small test set (docs/agent-instructions/personas/test-cases.json): a person, a question, and what the pack must allow, ask about or
 * block for that person. Nothing here calls a model, so it costs nothing and cannot wobble: it proves the doors are right. What the
 * assistant then SAYS is read from a live chat (shouldSay / shouldNot) and has not been run.
 */
const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, 'docs/agent-instructions/personas');
const draft = JSON.parse(readFileSync(path.join(root, 'docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const library = JSON.parse(readFileSync(path.join(dir, 'placemakers-personas.json'), 'utf8')) as PersonaLibrary;
const file = JSON.parse(readFileSync(path.join(dir, 'test-cases.json'), 'utf8')) as { cases: Case[] };
interface Case {
  id: string; login: string; useCase: string | null; playbook: string | null; prompt: string; opensOn: string;
  allow: string[]; ask: string[]; blocked: string[]; shouldSay: string[]; shouldNot: string[]; note?: string;
}

const published = draft.extensions.connectors as ConnectorsExtension;
const REAL = ['commercetools', 'salesforce', 'google-analytics', 'power-bi', 'zendesk'];
/** The pack switches the real systems on one at a time; these cases are about who may do what once they are on, so they use a copy with them on. */
const connectors = { ...published, connectors: published.connectors.map((connector) => (REAL.includes(connector.connectorId) ? { ...connector, enabled: true } : connector)) } as ConnectorsExtension;
const plan = planDemoStaff('placemakers');
const loginKey = (email: string) => email.split('@')[0];
const person = (login: string) => {
  const found = DEMO_STAFF.find((entry) => loginKey(entry.email) === login);
  assert.ok(found, `${login} is a demo login`);
  const staff = found!.teams.length > 0;
  return { demo: found!, principal: staff ? { audience: 'staff' as const, groups: normaliseGroups(found!.teams) } : { audience: 'shopper' as const, groups: [] as string[] } };
};
const stateOfTool = (key: string, who: ReturnType<typeof person>) => {
  const [connectorId, tool] = key.split('.');
  const got = connectorToolState(connectors, connectorId, tool, who.principal);
  assert.equal(got.known, true, `${key} is a tool the pack lists`);
  return got.state;
};

const suite = createSuite('project-service: the persona test set (the doors, with no model)');

async function main() {
  await suite.test('the file is well formed: unique ids, a question for each, no tool in two lists, tools written as connector.tool', () => {
    assert.ok(file.cases.length >= 24, 'a small test set, not a handful');
    assert.equal(new Set(file.cases.map((entry) => entry.id)).size, file.cases.length);
    for (const entry of file.cases) {
      assert.match(entry.id, /^TC-\d{2}$/);
      assert.ok(entry.prompt.length > 10, `${entry.id} has a question to type`);
      assert.ok(entry.shouldSay.length > 0 || entry.blocked.length > 0, `${entry.id} says what should happen`);
      const all = [...entry.allow, ...entry.ask, ...entry.blocked];
      assert.equal(new Set(all).size, all.length, `${entry.id} lists a tool in two places`);
      for (const key of all) assert.match(key, /^[a-z-]+\.[a-z_]+$/, `${entry.id}: ${key}`);
    }
  });

  await suite.test('each case: the login exists, the use case is in the catalogue, and the person is in the team (or the customer role) the catalogue gives that use case\'s persona', () => {
    const personas = new Map(library.personas.map((persona) => [persona.id, persona]));
    const useCases = new Map(library.useCases.map((useCase) => [useCase.id, useCase]));
    for (const entry of file.cases) {
      const who = person(entry.login);
      if (!entry.useCase) continue;
      const useCase = useCases.get(entry.useCase);
      assert.ok(useCase, `${entry.id}: ${entry.useCase} is a use case of the catalogue`);
      const persona = personas.get(useCase!.personaId)!;
      if (persona.kind === 'staff') {
        assert.deepEqual(who.demo.teams.map((team) => normaliseGroups([team])[0]), [persona.team], `${entry.id}: ${entry.login} is in ${persona.team}, the team of ${persona.id}`);
      } else {
        assert.equal(who.principal.audience, 'shopper', `${entry.id}: a customer case is asked by a signed-in shopper`);
      }
    }
  });

  await suite.test('each case: the person opens on the assistant the case says', () => {
    const project = { agents: draft.agents, extensions: draft.extensions, defaultAgentId: draft.defaultAgentId };
    for (const entry of file.cases) {
      const who = person(entry.login);
      const opens = buildAccessPreview(project as any, plan.teams, who.principal).agents.find((agent) => agent.opensFirst)?.agentId;
      assert.equal(opens, entry.opensOn, `${entry.id}: ${entry.login}`);
    }
  });

  await suite.test('each case: every tool it says is allowed, asked about or blocked is exactly that for this person, under the real rule engine and the draft pack', () => {
    const wrong: string[] = [];
    for (const entry of file.cases) {
      const who = person(entry.login);
      for (const [list, want] of [[entry.allow, 'allow'], [entry.ask, 'ask'], [entry.blocked, 'blocked']] as const) {
        for (const key of list) {
          const got = stateOfTool(key, who);
          if (got !== want) wrong.push(`${entry.id} ${entry.login} ${key}: wanted ${want}, got ${got}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  await suite.test('each case: the playbook it names is on demand for this person, and the assistant they open on carries it', () => {
    const skills = draft.skills as Array<{ skillId: string; tier?: 'always' | 'on_demand' }>;
    for (const entry of file.cases.filter((candidate) => candidate.playbook)) {
      const who = person(entry.login);
      const got = resolveSkillTiers(skills.filter((skill) => skill.skillId === entry.playbook), draft.extensions.skillAccess, who.principal);
      assert.equal(got[0]?.tier, 'on_demand', `${entry.id}: ${entry.login} has ${entry.playbook} on demand`);
      const agent = draft.agents.find((candidate: any) => candidate.agentId === entry.opensOn);
      assert.ok((agent.skills ?? []).includes(entry.playbook), `${entry.id}: ${entry.opensOn} carries ${entry.playbook}`);
      if (entry.useCase) {
        const useCase = library.useCases.find((candidate) => candidate.id === entry.useCase)!;
        if (useCase.playbooks.length > 0) assert.ok(useCase.playbooks.includes(entry.playbook!), `${entry.id}: the catalogue serves ${entry.useCase} with ${useCase.playbooks.join(', ')}`);
      }
    }
  });

  await suite.test('customers: a signed-in shopper has no connector at all, whatever they claim, and no playbook', () => {
    const skills = draft.skills as Array<{ skillId: string; tier?: 'always' | 'on_demand' }>;
    for (const entry of file.cases.filter((candidate) => person(candidate.login).principal.audience === 'shopper')) {
      const who = person(entry.login);
      assert.deepEqual(usableConnectors(published, who.principal), [], `${entry.id}: ${entry.login} sees no connector`);
      assert.deepEqual(usableConnectors(published, { audience: 'shopper', groups: ['customer-service', ADMIN_GROUP] }), [], 'a group claimed by a shopper changes nothing');
      assert.deepEqual(resolveSkillTiers(skills, draft.extensions.skillAccess, who.principal).filter((got) => (draft.extensions.skillAccess.rows as Array<{ skillId: string }>).some((row) => row.skillId === got.skill.skillId)), [], `${entry.id}: a shopper has no playbook`);
      assert.equal(entry.allow.length + entry.ask.length, 0, `${entry.id}: a shopper case lists nothing as allowed`);
    }
  });

  await suite.test('the set covers what was promised: every demo login, every playbook, every P0 use case of customer service, sales, branch and finance, and the trade customer roles', () => {
    const logins = new Set(file.cases.map((entry) => entry.login));
    for (const demo of DEMO_STAFF) assert.ok(logins.has(loginKey(demo.email)), `${demo.email} has a case`);
    const playbooks = new Set(file.cases.map((entry) => entry.playbook).filter(Boolean));
    for (const row of draft.extensions.skillAccess.rows as Array<{ skillId: string }>) assert.ok(playbooks.has(row.skillId), `${row.skillId} has a case`);
    const teamOf = new Map(library.personas.map((persona) => [persona.id, persona.team]));
    const covered = new Set(file.cases.map((entry) => entry.useCase).filter(Boolean));
    const wanted = library.useCases.filter((useCase) => useCase.priority === 'P0' && ['customer-service', 'sales', 'branch', 'finance'].includes(String(teamOf.get(useCase.personaId))));
    assert.deepEqual(wanted.filter((useCase) => !covered.has(useCase.id)).map((useCase) => useCase.id), [], 'a P0 use case of the first four teams without a case');
    const customerPersonas = new Set(file.cases.map((entry) => entry.useCase).filter((id): id is string => Boolean(id && id.startsWith('C'))).map((id) => id.split('-')[0]));
    assert.deepEqual([...customerPersonas].sort(), ['C04', 'C07', 'C08'], 'the trade account administrator, the site foreman and the delegated buyer');
  });

  await suite.test('what a case claims about the data is not more than the catalogue says: a case on a use case that is not ready says what is missing', () => {
    for (const entry of file.cases.filter((candidate) => candidate.useCase)) {
      const useCase = library.useCases.find((candidate) => candidate.id === entry.useCase)!;
      if (useCase.readiness !== 'fully ready') assert.ok(useCase.missing.length > 0, `${entry.id}: ${entry.useCase} is ${useCase.readiness} and names what is missing`);
    }
    const gaps = file.cases.filter((entry) => /bind|ERP/i.test(entry.note ?? ''));
    assert.ok(gaps.length >= 2, 'the customer cases that need the company binding or the ERP say so in their note');
  });

  await suite.test('the readable page (TEST-CASES.md) is exactly what the cases give now, so the owner reads what the test checks', () => {
    const names = Object.fromEntries((draft.agents as Array<{ agentId: string; name: string }>).map((agent) => [agent.agentId, agent.name]));
    const logins = DEMO_STAFF.map((demo) => ({ key: loginKey(demo.email), email: demo.email, fullName: demo.fullName }));
    const page = casesMarkdown(library, file.cases as unknown as TestCase[], logins, names);
    assert.equal(readFileSync(path.join(dir, 'TEST-CASES.md'), 'utf8'), page, 'run scripts/placemakers/import-personas.ts again');
    assert.doesNotMatch(page, /demo-2026/, 'no password in the page');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
