/**
 * The Connectors and Skills pages as a person sees them: a table of connectors, a page for one connector with its tool permissions, skills
 * as rows, and a page for one skill.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/customize/__tests__/panes.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectorsPane from '../ConnectorsPane';
import SkillsPane from '../SkillsPane';
import { buildOverview } from '@/lib/customize/overview';
import { buildToolOptions } from '@/lib/customize/toolOptions';
import { buildConnectorRules } from '@/lib/customize/connectorRules';
import { connectorRows } from '@/lib/customize/connectorPage';
import { draftFromSkill } from '@/lib/customize/skillDrafts';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Branch'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const status = { salesforce: { checked: true as const, connected: true, missing: [] }, commercetools: { checked: true as const, connected: false, missing: ['CT_CLIENT_ID'] } };
const rules = buildConnectorRules((pack.extensions as any).connectors, TEAMS, status);
const editor = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(pack, TEAMS), connectorRules: rules });
const reader = buildOverview('placemakers', pack, { canViewInstructions: false, canEdit: false });
const noop = () => {};
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const connectors = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(ConnectorsPane as any, {
  scope: 'yours', query: '', overview: editor, open: null, busy: false, onOpen: noop, onSave: noop, onFullTable: noop, onAddToAgent: noop, ...props,
}));
const skills = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SkillsPane as any, {
  scope: 'yours', query: '', overview: editor, drafts: [], busy: '', open: null, onOpen: noop, onNew: noop, onChange: noop, onEditDraft: noop, onMakeLive: noop,
  onDeleteDraft: noop, onRebase: noop, onDelete: noop, onTry: noop, ...props,
}));

console.log('the connectors table');

check('a table with Connector, Type and Status; systems first; the words are Connector, Data, Built in, Connected, Not connected', () => {
  const html = connectors({});
  for (const head of ['Connector', 'Type', 'Status']) assert.ok(html.includes(`>${head}<`), head);
  assert.ok(html.indexOf('Salesforce') < html.indexOf('Browse the range'), 'systems come first');
  assert.ok(html.includes('<td>Connector</td>') && html.includes('<td>Data</td>') && html.includes('Connected') && html.includes('Not connected'));
  assert.ok(html.includes('>Salesforce Marketing Cloud<') && html.includes('>SAP ERP<'), 'the name and nothing else');
  assert.ok(!/sample/i.test(html) && !html.includes('Real data') && !html.includes('Needs setup') && !html.includes('Need another system?'), 'no explanations');
  assert.ok(html.includes('Zendesk'), 'the ticket desk is switched on');
  assert.ok(!html.includes('MuleSoft'), 'a switched-off system is under Discover');
});

check('Discover lists what is switched off as Off, and an empty search says so', () => {
  const html = connectors({ scope: 'discover' });
  assert.ok(html.includes('MuleSoft') && html.includes('>Off<') && !html.includes('Switched off'));
  assert.ok(connectors({ query: 'zzzz-nothing' }).includes('No connectors match your search'));
});

check('someone who cannot change the rules sees the same list', () => {
  const html = connectors({ overview: reader });
  assert.ok(html.includes('Salesforce') && html.includes('Connected'));
  assert.ok(!html.includes('Not connected'));
});

console.log('one connector');

check('a connected system\'s page: tool permissions in two groups, three buttons per tool, one team at a time, an on/off switch', () => {
  const html = connectors({ open: 'salesforce' });
  assert.ok(html.includes('Your connectors'), 'a way back');
  for (const text of ['Tool permissions', 'Interactive tools', 'Read-only tools', 'Create case', 'Find account']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('role="switch"') && html.includes('aria-checked="true"'));
  assert.ok(html.includes('Customer Service') && html.includes('Branch'), 'the team picker');
    const tools = editor.connectorRules.find((r) => r.connectorId === 'salesforce')!.tools.length;
  assert.equal((html.match(/aria-label="Allow"/g) || []).length, tools);
  assert.equal((html.match(/aria-label="Ask first"/g) || []).length, tools);
  assert.equal((html.match(/aria-label="Blocked"/g) || []).length, tools);
  assert.ok(html.includes('All teams'), 'the full table is one button away');
  assert.ok(!html.includes('Make live'), 'nothing to publish until something is changed');
});

check('a tool that changes data cannot be simply allowed: its Allow button is off', () => {
  const html = connectors({ open: 'salesforce' });
  const write = editor.connectorRules.find((r) => r.connectorId === 'salesforce')!.tools.filter((t) => t.sideEffect === 'write').length;
  assert.equal((html.match(/title="A tool that changes data always asks first" disabled=""/g) || []).length, write);
});

check('a system that is not connected says so on its page, and one that is switched off shows the switch off', () => {
  assert.ok(connectors({ open: 'commercetools' }).includes('Not connected'));
  const off = connectors({ open: 'mulesoft', scope: 'discover' });
  assert.ok(off.includes('aria-checked="false"') && !off.includes('While it is off'));
});

check('without permission to publish the page only names the system and its status', () => {
  const html = connectors({ overview: reader, open: 'salesforce' });
  assert.ok(html.includes('Connector') && html.includes('Connected'));
  assert.ok(!html.includes('role="switch"') && !html.includes('Tool permissions'));
});

check('a built-in tool\'s page says who may call it and offers to add it to a new agent', () => {
  const builtin = connectorRows(editor).yours.find((r) => r.kind === 'builtin')!;
  const html = connectors({ open: builtin.id });
  assert.ok(html.includes('Built in') && html.includes('Add to a new agent'));
});

console.log('the skills list');

check('skills as rows in two groups, with who uses each; searching narrows them', () => {
  const html = skills({});
  assert.ok(html.includes('Always on') && html.includes('Opened when a request fits'));
  for (const skill of editor.skills.slice(0, 5)) assert.ok(html.includes(esc(skill.name)), skill.name);
  assert.ok(html.includes('Used by'));
  const one = editor.skills.find((s) => s.tier !== 'always')!;
  const narrowed = skills({ query: one.name });
  assert.ok(narrowed.includes(esc(one.name)));
  assert.ok(!narrowed.includes('Always on') || editor.skills.some((s) => s.tier === 'always' && s.name.toLowerCase().includes(one.name.toLowerCase())));
  assert.ok(skills({ query: 'zzzz-nothing' }).includes('No skills match your search'));
});

check('drafts sit on top, marked not live, with Edit, Make live and Delete', () => {
  const live = editor.skills[0];
  const seed = draftFromSkill(live, editor.agents);
  const html = skills({ drafts: [{ ...seed, draftId: 'd1', createdAt: 1, updatedAt: 1, name: 'My new playbook' }] });
  assert.ok(html.indexOf('Your drafts') < html.indexOf('Always on'));
  for (const text of ['My new playbook', 'Draft', 'Edit', 'Make live', 'Delete draft My new playbook']) assert.ok(html.includes(text), text);
});

check('Discover has nothing yet and says how to add a skill', () => {
  assert.ok(skills({ scope: 'discover' }).includes('No skills to discover yet'));
});

console.log('one skill');

check('a skill\'s page: back link, Try in chat, Change and Delete for editors, Overview and Contents, who has it, tools by system', () => {
  const skill = editor.skills.find((s) => s.tools.length > 0 && s.instructions)!;
  const html = skills({ open: skill.skillId });
  for (const text of ['Your skills', 'Try in chat', 'Change', 'Overview', 'Contents', 'Who has it', 'Which assistants carry it', 'Connectors &amp; tools']) assert.ok(html.includes(text), text);
  assert.ok(html.includes(`Delete skill ${esc(skill.name)}`));
  assert.ok(html.includes('role="tablist"'));
});

check('someone who cannot change skills sees the page without Change or Delete', () => {
  const skill = reader.skills[0];
  const html = skills({ overview: reader, open: skill.skillId });
  assert.ok(html.includes('Try in chat'));
  assert.ok(!html.includes('>Change<') && !html.includes('Delete skill'));
});

check('a skill no assistant carries cannot be tried in chat', () => {
  const orphan = { ...editor, agents: editor.agents.map((a) => ({ ...a, skills: [] })) };
  const html = skills({ overview: orphan, open: orphan.skills[0].skillId });
  assert.ok(/disabled=""[^>]*>Try in chat/.test(html) || /<button[^>]*disabled[^>]*>Try in chat/.test(html));
  assert.ok(html.includes('no assistant uses it yet'));
});

console.log(`✅ web: Connectors and Skills pages: ${passed} passed, 0 failed`);
