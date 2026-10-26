/**
 * A test scenario for every use case: who to sign in as, what to type, what should be possible and what should be said.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/scenarios.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildOverview } from '../overview';
import { buildToolOptions } from '../toolOptions';
import { buildConnectorRules } from '../connectorRules';
import { checkScenarios, parsePersonaLibraryAnswer, type PersonaLibraryView } from '../personas';
import { buildScenarios, wordQuestion } from '../scenarios';
import { setPrefill, takePrefill } from '../../shell/prefill';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const docs = path.resolve(__dirname, '../../../../../../docs/agent-instructions');
const draft = JSON.parse(readFileSync(path.join(docs, 'placemakers-draft.json'), 'utf8'));
const library = JSON.parse(readFileSync(path.join(docs, 'personas/placemakers-personas.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Sales Managers', 'Branch', 'Finance', 'Marketing', 'Insights', 'Leadership'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const status = { salesforce: { checked: true as const, connected: true, missing: [] }, commercetools: { checked: true as const, connected: true, missing: [] } };
const overview = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(pack, TEAMS), connectorRules: buildConnectorRules((pack.extensions as any).connectors, TEAMS, status) });
const view = (scenarioTools: Record<string, string[]> = {}, scenarioPrompts: Record<string, string> = {}) => parsePersonaLibraryAnswer({ present: true, revision: 4, updatedAt: '', updatedBy: '', library, scenarioTools, scenarioPrompts }) as PersonaLibraryView;
const scenarios = (v = view()) => buildScenarios(v, checkScenarios(v, overview));
const byId = (list: ReturnType<typeof scenarios>, id: string) => list.find((s) => s.useCaseId === id)!;

console.log('wording a question');

check('"I want to ..." from the story becomes "I need to ..."; a story that does not follow that shape falls back to the title', () => {
  assert.equal(wordQuestion('As a trade support advisor, I want to see previous orders, so that I can help.', 'Handle'), 'I need to see previous orders.');
  assert.equal(wordQuestion('As a diy shopper, I want to choose my store and check stock before checkout, so that I avoid a wasted visit.', 'Find'), 'I need to choose my store and check stock before checkout.');
  assert.equal(wordQuestion('I want a quote I can trust.', 'Quote'), 'I need a quote I can trust.');
  assert.equal(wordQuestion('Something unrelated.', 'Find in-stock materials.'), 'Help me with this: Find in-stock materials.');
  assert.equal(wordQuestion('', 'Title'), 'Help me with this: Title.');
});

console.log('a scenario for every use case');

check('every one of the 86 use cases has a scenario with a question and a sign-in line', () => {
  const list = scenarios();
  assert.equal(list.length, 86);
  for (const s of list) {
    assert.ok(s.question.text.length > 8, s.useCaseId);
    assert.ok(s.signIn.kind === 'login' || s.signIn.note.length > 10, s.useCaseId);
  }
  assert.equal(new Set(list.map((s) => s.useCaseId)).size, 86);
});

check('a persona with a demo login says which; a team with none, and a visitor, say why', () => {
  const list = scenarios();
  assert.deepEqual(byId(list, 'B02-UC01').signIn, { kind: 'login', email: 'csr@placemakers.demo' });
  assert.deepEqual(byId(list, 'B01-UC02').signIn, { kind: 'login', email: 'sales@placemakers.demo' });
  assert.equal(byId(list, 'C01-UC01').signIn.kind, 'login');
  const none = byId(list, 'B06-UC01').signIn;
  assert.ok(none.kind === 'none' && /no demo login yet/.test(none.note));
  const carrier = byId(list, library.useCases.find((u: any) => u.personaId === 'C19').id).signIn;
  assert.ok(carrier.kind === 'none' && /No sign-in needed/.test(carrier.note));
});

check('the question is the person\'s own if they set one, else the test set\'s, else worded from the use case', () => {
  assert.equal(byId(scenarios(), 'B01-UC02').question.source, 'test set');
  assert.match(byId(scenarios(), 'B01-UC02').question.text, /Pass a special order to Trade Support/);
  assert.equal(byId(scenarios(), 'B06-UC01').question.source, 'worded from the use case');
  assert.match(byId(scenarios(), 'B06-UC01').question.text, /^I need to /);
  const mine = scenarios(view({}, { 'B01-UC02': 'Hand this order to Trade Support please', 'B06-UC01': 'Estimate the frame for 3 houses' }));
  assert.deepEqual([byId(mine, 'B01-UC02').question.source, byId(mine, 'B01-UC02').question.text], ['yours', 'Hand this order to Trade Support please']);
  assert.equal(byId(mine, 'B06-UC01').question.text, 'Estimate the frame for 3 houses');
});

check('what should be possible comes from the tools check, and what should and should not be said from the test set', () => {
  const s = byId(scenarios(), 'B01-UC02');
  assert.ok(s.doors.works.length >= 2 && s.doors.asks.includes('Create case'), 'Sales may now raise a case, asked first');
  assert.deepEqual(s.doors.stopped, []);
  assert.ok(s.shouldSay.some((line) => /Yes\/No card/.test(line)));
  assert.ok(s.shouldNot.length > 0);
  const gap = byId(scenarios(), 'B02-UC01');
  assert.ok(gap.doors.stopped.some((line) => /List opportunities \(Blocked for Customer Service\)/.test(line)));
  assert.equal(gap.verdict, 'gaps');
  const empty = byId(scenarios(), 'B06-UC01');
  assert.deepEqual([empty.doors.works, empty.doors.asks, empty.doors.stopped], [[], [], []]);
  assert.deepEqual([empty.shouldSay, empty.shouldNot], [[], []]);
});

check('the team a scenario is judged under is named, and a customer\'s is "shoppers"', () => {
  assert.equal(byId(scenarios(), 'B02-UC01').audienceName, 'Customer Service');
  assert.equal(byId(scenarios(), 'C01-UC01').audienceName, 'shoppers');
});

console.log('a question waiting for the next chat');

const fakeStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m }; };

check('"Try in chat" leaves the question once, tidied, for this project only', () => {
  const store = fakeStore();
  assert.equal(setPrefill('placemakers', '  Show me   the open cases.  ', store), true);
  assert.equal(takePrefill('someone-else', store), '');
  assert.equal(takePrefill('placemakers', store), 'Show me the open cases.');
  assert.equal(takePrefill('placemakers', store), '', 'used once');
});

check('nothing is left for an empty question, a very long one is cut, and a browser with no storage never throws', () => {
  const store = fakeStore();
  assert.equal(setPrefill('p', '   ', store), false);
  assert.equal(store.m.size, 0);
  setPrefill('p', 'x'.repeat(2000), store);
  assert.equal(takePrefill('p', store).length, 600);
  assert.equal(setPrefill('p', 'hello', undefined), false);
  assert.equal(takePrefill('p', undefined), '');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(setPrefill('p', 'hello', broken), false);
  assert.equal(takePrefill('p', broken), '');
});

console.log(`✅ web: test scenarios: ${passed} passed, 0 failed`);
