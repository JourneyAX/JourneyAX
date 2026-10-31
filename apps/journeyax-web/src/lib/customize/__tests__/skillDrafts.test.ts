/**
 * Skill drafts kept in the browser, and the agreement between the page's view of a skill and the server's (the fingerprint).
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/skillDrafts.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildOverview } from '../overview';
import { fingerprintInState } from '../skillEdit';
import { EMPTY_SKILL, draftFromSkill, draftToInput, fingerprintOfOverviewSkill, loadSkillDrafts, removeSkillDraft, skillDraftsKey, upsertSkillDraft } from '../skillDrafts';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draftPack = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draftPack.agents, extensions: { ...draftPack.extensions, skills: draftPack.skills } };
const overview = buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true });

console.log('skill drafts');

check('a draft is added newest first, replaced by its id, and removed', () => {
  const a = upsertSkillDraft([], { ...EMPTY_SKILL, name: ' First ', description: 'd', instructions: ' i ', tools: ['x', 'x'], agents: ['a', 'a'] }, undefined, 1000);
  assert.equal(a.draft.name, 'First');
  assert.equal(a.draft.instructions, 'i');
  assert.deepEqual(a.draft.tools, ['x']);
  assert.deepEqual(a.draft.agents, ['a']);
  const b = upsertSkillDraft(a.list, { ...EMPTY_SKILL, name: 'Second' }, undefined, 2000);
  assert.deepEqual(b.list.map((d) => d.name), ['Second', 'First']);
  const edited = upsertSkillDraft(b.list, { ...EMPTY_SKILL, name: 'First again' }, a.draft.draftId, 3000);
  assert.deepEqual(edited.list.map((d) => d.name), ['First again', 'Second']);
  assert.equal(edited.draft.createdAt, 1000, 'editing keeps when it was started');
  assert.deepEqual(removeSkillDraft(edited.list, a.draft.draftId).map((d) => d.name), ['Second']);
  assert.equal(skillDraftsKey('placemakers'), 'ax:skill-drafts:placemakers');
  assert.deepEqual(loadSkillDrafts('placemakers'), [], 'no storage (a test, a blocked browser) is no drafts, not an error');
});

check('a draft that changes a live skill starts from that skill, remembers which one and how it was, and goes to the server as that skill\'s id', () => {
  const live = overview.skills.find((s) => s.skillId === 'order-enquiry')!;
  const seed = draftFromSkill(live, overview.agents);
  assert.equal(seed.replaces, 'order-enquiry');
  assert.equal(seed.name, live.name);
  assert.deepEqual(seed.agents, ['placemakers_customer_service', 'placemakers_sales_quote']);
  assert.ok(!seed.access.some((row) => row.groups.includes('administrators')), 'the admin group is hidden from the form');
  const { draft } = upsertSkillDraft([], seed);
  const input = draftToInput(draft);
  assert.equal(input.skillId, 'order-enquiry');
  assert.equal((input as unknown as Record<string, unknown>).replaces, undefined);
  assert.equal(draftToInput(upsertSkillDraft([], EMPTY_SKILL).draft).skillId, undefined, 'a new skill has no id yet');
});

check('for every skill of the real draft pack, what the page computes is exactly what the server computes from the project settings', () => {
  const state = { skills: pack.extensions.skills, agents: pack.agents, accessRows: pack.extensions.skillAccess.rows };
  assert.equal(overview.skills.length, draftPack.skills.length);
  for (const skill of overview.skills) assert.equal(fingerprintOfOverviewSkill(skill, overview.agents), fingerprintInState(state, skill.skillId), skill.skillId);
});

console.log(`${passed} passed`);
