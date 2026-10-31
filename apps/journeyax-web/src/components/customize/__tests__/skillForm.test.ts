/**
 * The skill form as a person sees it: who has the skill, which assistants carry it, the tools of each connected system, and the heads-up
 * about what would not work for the people who get it.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/customize/__tests__/skillForm.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SkillForm from '../SkillForm';
import { buildOverview } from '@/lib/customize/overview';
import { buildToolOptions } from '@/lib/customize/toolOptions';
import { draftFromSkill, EMPTY_SKILL } from '@/lib/customize/skillDrafts';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const TEAMS = ['Customer Service', 'Sales', 'Branch'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));
const overview = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true, teams: TEAMS, toolOptions: buildToolOptions(pack, TEAMS) });
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SkillForm as any, { overview, onSave: () => {}, onClose: () => {}, seed: EMPTY_SKILL, ...props }));

console.log('the skill form');

check('a new skill asks for a name, when to use it and the instructions, and says it is a draft that is not live', () => {
  const html = render({});
  assert.ok(html.includes('New skill'));
  for (const label of ['Name', 'When should the assistant use it?', 'Instructions', 'Who has it', 'Which assistants carry it', 'Tools it relies on']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('It is not live'));
  assert.ok(html.includes('Save draft'));
  assert.ok(!html.includes('The skill gets its id'), 'no id hint until there is a name');
});

check('with no rows the form says plainly that everyone, shoppers included, would have the skill', () => {
  const html = render({});
  assert.ok(html.includes('everyone, shoppers included,'));
  assert.ok(html.includes('Selected teams, opened when a request fits') && html.includes('Selected teams, always on') && html.includes('Everyone, as the skill'));
});

check('every assistant is offered, and every team a row can name', () => {
  const html = render({ seed: { ...EMPTY_SKILL, access: [{ audience: 'staff', groups: ['branch'], level: 'available' }] } });
  for (const agent of overview.agents) assert.ok(html.includes(agent.name.replace(/&/g, '&amp;')), agent.name);
  for (const team of TEAMS) assert.ok(html.includes(team.name), team.name);
  assert.ok(html.includes('Staff in branch opens it when a request fits'));
});

check('the tools are grouped by system: the built-in tools and each connected system, with what changes data marked', () => {
  const html = render({ seed: { ...EMPTY_SKILL, tools: ['salesforce.create_case'] } });
  assert.ok(html.includes('Built-in tools'));
  for (const system of ['Salesforce', 'commercetools', 'Marketing Cloud']) assert.ok(html.includes(system), system);
  assert.ok(html.includes('changes data'));
  assert.ok(html.includes('Zendesk') && html.includes('switched off'), 'a system that is switched off is shown as such');
});

check('a chosen tool that a chosen team may not use is called out before anything is made live, in the team\'s name', () => {
  const html = render({ seed: { ...EMPTY_SKILL, tools: ['salesforce.list_opportunities', 'commercetools.get_order'], access: [{ audience: 'staff', groups: ['customer-service', 'sales'], level: 'available' }] } });
  assert.ok(html.includes('Worth a look before you make it live'));
  assert.ok(html.includes('Customer Service cannot use &quot;List opportunities&quot;'));
  assert.ok(!html.includes('Sales cannot use'), 'sales may read deals');
  assert.ok(html.includes('Customer Service may use it'), 'the tool shows what each ticked team may do with it');
});

check('changing a live skill starts from how it is now and says which skill it replaces', () => {
  const live = overview.skills.find((s) => s.skillId === 'account-360')!;
  const html = render({ seed: draftFromSkill(live, overview.agents) });
  assert.ok(html.includes('Change skill'));
  assert.ok(html.includes('It will replace the live skill “account-360”'));
  assert.ok(html.includes('Account 360 before a call or visit'));
  assert.ok(html.includes('Look it up') === false);
  assert.ok(html.includes('salesforce') || html.includes('Salesforce'));
});

console.log(`${passed} passed`);
