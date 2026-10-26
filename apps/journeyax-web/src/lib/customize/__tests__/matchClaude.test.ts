/**
 * The helpers behind the Claude-style "+" menu, Connectors page and Skills page: links into Customize, what the menu lists, the
 * connector table and the per-team tool settings, and reading a skill from a file.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/matchClaude.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { customizeHref, readDeepLink } from '../deepLink';
import { plusMenuModel, skillPrompt } from '../../shell/plusMenu';
import { connectorRows, defaultColumn, describeEdit, filterRows, groupSetting, pickableColumns, setGroupState, setToolState, splitTools, stateOf, summarizeTools } from '../connectorPage';
import { parseSkillFile, MAX_SKILL_FILE_BYTES } from '../skillFile';
import { groupSkillTools, groupSkills, matchesSkill } from '../skillPage';
import { buildOverview } from '../overview';
import { buildToolOptions } from '../toolOptions';
import { buildConnectorRules } from '../connectorRules';
import { countChanges, rulesToSend, type RuleEdit } from '../ruleGrid';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Branch'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const status = { salesforce: { checked: true as const, connected: true, missing: [] }, commercetools: { checked: true as const, connected: false, missing: ['CT_CLIENT_ID'] } };
const rules = buildConnectorRules((pack.extensions as any).connectors, TEAMS, status);
const editor = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(pack, TEAMS), connectorRules: rules });
const reader = buildOverview('placemakers', pack, { canViewInstructions: false, canEdit: false });

console.log('links into Customize');

check('a link keeps the storefront query, adds the tab, Discover and what to open, and drops everything else', () => {
  assert.equal(customizeHref('?project=pm&embed=1&utm=x', { tab: 'skills' }), '/customize?project=pm&embed=1&tab=skills');
  assert.equal(customizeHref('?project=pm', { tab: 'connectors', scope: 'discover' }), '/customize?project=pm&tab=connectors&scope=discover');
  assert.equal(customizeHref('', { tab: 'connectors', open: 'salesforce' }), '/customize?tab=connectors&open=salesforce');
  assert.equal(customizeHref(undefined), '/customize');
  assert.equal(customizeHref('?project=pm', { tab: 'skills', scope: 'yours' }), '/customize?project=pm&tab=skills', 'Yours is the default and is not written');
});

check('reading an address: a known tab, Discover and what to open; anything else is ignored', () => {
  assert.deepEqual(readDeepLink('?project=pm&tab=connectors&scope=discover&open=zendesk'), { tab: 'connectors', scope: 'discover', open: 'zendesk' });
  assert.deepEqual(readDeepLink('?tab=nonsense&scope=other'), {});
  assert.deepEqual(readDeepLink(''), {});
  assert.equal(readDeepLink(`?open=${'x'.repeat(300)}`).open?.length, 96);
});

console.log('what the + menu lists');

check('people who manage the assistant see its skills and plugins; everyone else sees neither', () => {
  const full = plusMenuModel(editor);
  assert.equal(full.showLists, true);
  assert.equal(full.skills.length, editor.skills.length);
  assert.equal(full.plugins.length, editor.plugins.length);
  assert.deepEqual(plusMenuModel(reader), { showLists: false, skills: [], plugins: [] });
  assert.deepEqual(plusMenuModel(undefined), { showLists: false, skills: [], plugins: [] });
  assert.equal(plusMenuModel({ ...reader, canViewInstructions: true } as any).showLists, true, 'seeing the instructions is enough');
});

check('skills are in name order and say which are always on; a plugin says what it brings', () => {
  const { skills } = plusMenuModel(editor);
  assert.deepEqual(skills.map((s) => s.name), [...skills.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
  assert.ok(skills.some((s) => s.always) && skills.some((s) => !s.always), 'both kinds exist in the PlaceMakers pack');
  const withPlugin = { ...editor, plugins: [{ pluginId: 'p', name: 'Trade pack', description: '', provides: { agents: ['a'], skills: ['s1', 's2'], forms: [], connectors: ['crm'], tools: [] }, access: [] }] };
  assert.deepEqual(plusMenuModel(withPlugin as any).plugins, [{ pluginId: 'p', name: 'Trade pack', summary: '1 agent · 2 skills · 1 system' }]);
});

check('picking a skill puts the request first and keeps what was typed; picking it twice changes nothing', () => {
  assert.equal(skillPrompt('Account 360', ''), 'Use the “Account 360” skill: ');
  assert.equal(skillPrompt('Account 360', 'for Acme Build'), 'Use the “Account 360” skill: for Acme Build');
  const once = skillPrompt('Account 360', 'for Acme Build');
  assert.equal(skillPrompt('Account 360', once), once);
  assert.equal(skillPrompt('Account 360', '   hello'), 'Use the “Account 360” skill: hello');
});

console.log('the connectors table');

check('an editor sees every system: the ones on under Yours with their status, the ones off under Discover; built-in tools by use', () => {
  const rows = connectorRows(editor);
  const sf = rows.yours.find((r) => r.key === 'system:salesforce');
  assert.ok(sf, 'Salesforce is on');
  assert.deepEqual([sf!.type, sf!.status.tone, sf!.status.label], ['Real data', 'good', 'Connected']);
  const ct = rows.yours.find((r) => r.key === 'system:commercetools');
  assert.deepEqual([ct!.status.tone, ct!.status.label, ct!.status.detail], ['warn', 'Needs setup', 'needs CT_CLIENT_ID']);
  const zd = rows.discover.find((r) => r.key === 'system:zendesk');
  assert.deepEqual([zd!.status.tone, zd!.status.label], ['off', 'Switched off'], 'Zendesk is switched off in the draft pack');
  assert.ok(rows.yours.some((r) => r.kind === 'builtin' && r.type === 'Built in'));
  const kinds = rows.yours.map((r) => r.kind);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === b ? 0 : a === 'system' ? -1 : 1)), 'connected systems come before the built-in tools');
  const systems = rows.yours.filter((r) => r.kind === 'system').map((r) => r.name);
  assert.deepEqual(systems, [...systems].sort((a, b) => a.localeCompare(b)));
});

check('someone who cannot change the rules sees the systems in use, marked In use, without a connection check', () => {
  const rows = connectorRows(reader);
  const sf = rows.yours.find((r) => r.key === 'system:salesforce');
  assert.deepEqual([sf!.status.label, sf!.status.tone], ['In use', 'good']);
  assert.ok(!rows.discover.some((r) => r.kind === 'system'), 'they are not shown what is switched off');
});

check('search looks at the name, what it does, its id and its type', () => {
  const rows = connectorRows(editor).yours;
  assert.ok(filterRows(rows, 'sales').some((r) => r.id === 'salesforce'));
  assert.ok(filterRows(rows, 'real data').every((r) => r.type === 'Real data'));
  assert.equal(filterRows(rows, '  ').length, rows.length);
  assert.equal(filterRows(rows, 'zzzz-nothing').length, 0);
});

console.log('the tools of one system');

const system = rules.find((r) => r.connectorId === 'salesforce')!;
const fresh = (): RuleEdit => ({ enabled: system.enabled, grid: JSON.parse(JSON.stringify(system.grid)) });

check('tools are split into interactive (change data) and read-only, and the summary says how many of each', () => {
  const { interactive, readOnly } = splitTools(system);
  assert.equal(interactive.length + readOnly.length, system.tools.length);
  assert.ok(interactive.length > 0 && interactive.every((t) => t.sideEffect === 'write'));
  assert.ok(readOnly.every((t) => t.sideEffect !== 'write'));
  assert.match(summarizeTools(system), /read-only tool/);
  assert.match(summarizeTools(system), /interactive tool/);
});

check('the team picker offers real teams and the administrators, and starts on the first real team', () => {
  const ids = pickableColumns(system).map((c) => c.id);
  assert.ok(ids.includes('administrators'));
  assert.ok(pickableColumns(system).every((c) => !c.note || c.id === 'administrators'));
  assert.ok(!pickableColumns({ ...system, columns: [...system.columns, { id: 'ghost', name: 'ghost', note: 'Named by a rule, but not a team of this project.' }] }).some((c) => c.id === 'ghost'), 'a group no team has is only in the full table');
  assert.notEqual(defaultColumn(system), 'administrators');
  assert.equal(defaultColumn({ ...system, columns: [] }), '');
});

check('one tool: set for one team; a tool that changes data asks first when Allow is chosen; nothing else moves', () => {
  const { interactive, readOnly } = splitTools(system);
  const team = defaultColumn(system);
  const other = pickableColumns(system).find((c) => c.id !== team)!.id;
  const read = readOnly[0];
  const change = interactive[0];
  const a = setToolState(fresh(), read, team, 'blocked');
  assert.equal(stateOf(a, read.name, team), 'blocked');
  assert.equal(stateOf(a, read.name, other), stateOf(fresh(), read.name, other), 'another team is untouched');
  const b = setToolState(fresh(), change, team, 'allow');
  assert.equal(stateOf(b, change.name, team), 'ask', 'a tool that changes data is never simply allowed');
  assert.equal(stateOf(fresh(), read.name, team), system.grid[read.name][team], 'the edit it started from is not modified');
});

check('a whole group: set for a team, read back as that state, or Custom when the tools differ', () => {
  const { interactive, readOnly } = splitTools(system);
  const team = defaultColumn(system);
  const all = setGroupState(fresh(), readOnly, team, 'allow');
  assert.equal(groupSetting(all, readOnly, team), 'allow');
  const none = setGroupState(all, readOnly, team, 'blocked');
  assert.equal(groupSetting(none, readOnly, team), 'blocked');
  const mixed = setToolState(none, readOnly[0], team, 'allow');
  assert.equal(groupSetting(mixed, readOnly, team), readOnly.length === 1 ? 'allow' : 'custom');
  const ask = setGroupState(fresh(), interactive, team, 'allow');
  assert.equal(groupSetting(ask, interactive, team), 'ask', 'allowing a group that changes data means ask first');
  assert.equal(groupSetting(fresh(), [], team), 'custom');
});

check('what is sent after edits on this page is the whole row of each changed tool, and the confirmation counts the changes', () => {
  const { readOnly } = splitTools(system);
  const team = pickableColumns(system).find((c) => c.id !== 'administrators')!.id;
  const edit = setToolState(fresh(), readOnly[0], team, system.grid[readOnly[0].name][team] === 'allow' ? 'blocked' : 'allow');
  assert.equal(countChanges(system, edit), 1);
  const sent = rulesToSend(system, edit).cells;
  assert.deepEqual(Object.keys(sent), [readOnly[0].name]);
  assert.deepEqual(Object.keys(sent[readOnly[0].name]).sort(), system.columns.map((c) => c.id).sort(), 'every team is sent, so the others keep what they had');
  assert.equal(describeEdit(system, edit), 'change 1 setting');
  assert.equal(describeEdit(system, { ...edit, enabled: !system.enabled }), `switch ${system.name} ${system.enabled ? 'OFF' : 'ON'} and change 1 setting`);
  assert.equal(describeEdit(system, fresh()), '');
});

console.log('a skill from a file');

check('a SKILL.md with a header becomes a draft with its name, description and instructions, and nothing is live', () => {
  const result = parseSkillFile('---\nname: Quote follow-up\ndescription: "Use when a quote has gone quiet."\n---\n# Steps\n\n1. Look up the quote.\n2. Draft a nudge.\n', 'SKILL.md');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.seed.name, 'Quote follow-up');
  assert.equal(result.seed.description, 'Use when a quote has gone quiet.');
  assert.match(result.seed.instructions, /^# Steps/);
  assert.deepEqual([result.seed.tier, result.seed.tools, result.seed.access, result.seed.agents], ['on_demand', [], [], []], 'nobody has it and no assistant carries it until the person chooses');
  assert.equal(result.note, '');
});

check('a header value written over several lines is joined', () => {
  const result = parseSkillFile('---\nname: Long one\ndescription: >\n  First part\n  second part.\n---\nDo it.', 'x.md');
  assert.ok(result.ok && result.seed.description === 'First part second part.');
});

check('plain markdown works: the first heading names it and the first sentence describes it, with a note to check', () => {
  const result = parseSkillFile('# Warranty claims\n\nCheck the order date first. Then the product.\n\n- one\n- two', 'notes.md');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.seed.name, 'Warranty claims');
  assert.equal(result.seed.description, 'Check the order date first.');
  assert.match(result.note, /no description/);
});

check('with no name anywhere the file name is used, except a bare SKILL.md which says it needs a name', () => {
  const named = parseSkillFile('Do the thing carefully.', 'branch-handover.md');
  assert.ok(named.ok && named.seed.name === 'branch handover');
  const bare = parseSkillFile('Do the thing carefully.', 'SKILL.md');
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.match(bare.error, /what the skill is called/);
});

check('files that are not skills are refused with a reason: empty, binary, too long, a name that is too long, a header with nothing under it', () => {
  const reasons = (text: string, file = 'a.md') => { const r = parseSkillFile(text, file); return r.ok === false ? r.error : ''; };
  assert.match(reasons('   '), /empty/);
  assert.match(reasons('abc\u0000def'), /text file/);
  assert.match(reasons('x'.repeat(MAX_SKILL_FILE_BYTES + 1)), /too long/);
  assert.match(reasons(`---\nname: ${'n'.repeat(81)}\n---\nbody`), /name is longer/);
  assert.match(reasons('---\nname: Empty one\n---\n'), /no instructions/);
});

console.log('the skills list and a skill\'s tools');

check('skills fall in two groups, each in name order; search looks at the name, the description and the id', () => {
  const groups = groupSkills(editor.skills);
  assert.equal(groups.always.length + groups.onDemand.length, editor.skills.length);
  assert.ok(groups.always.every((s) => s.tier === 'always') && groups.onDemand.every((s) => s.tier !== 'always'));
  assert.deepEqual(groups.onDemand.map((s) => s.name), [...groups.onDemand.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
  const one = editor.skills[0];
  assert.ok(matchesSkill(one, one.name.toUpperCase()) && matchesSkill(one, one.skillId) && matchesSkill(one, ''));
  assert.equal(matchesSkill(one, 'zzzz-nothing-like-this'), false);
});

check('a skill\'s tools are listed under their system, built-in first; an editor sees names, anyone else sees the ids', () => {
  const ids = ['present_card', 'salesforce.list_cases', 'salesforce.create_case', 'zendesk.find_tickets'];
  const rich = groupSkillTools(ids, editor.toolOptions);
  assert.equal(rich[0].system, 'Built-in tools');
  const sf = rich.find((g) => g.system === 'Salesforce');
  assert.ok(sf && sf.tools.length === 2 && sf.tools.some((t) => t.changesData), 'Salesforce has a tool that changes data');
  const zd = rich.find((g) => g.system === 'Zendesk');
  assert.ok(zd && zd.tools[0].switchedOff, 'a tool of a switched-off system says so');
  const plain = groupSkillTools(ids, []);
  assert.deepEqual(plain.map((g) => g.system), ['Built-in tools', 'salesforce', 'zendesk']);
  assert.equal(plain[1].tools[0].label, 'list_cases');
  assert.deepEqual(groupSkillTools([], editor.toolOptions), []);
});

console.log(`✅ web: match-claude helpers: ${passed} passed, 0 failed`);
