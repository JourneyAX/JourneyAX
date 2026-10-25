/**
 * "View as": the question Customize asks and how it reads the answer.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/accessPreview.test.ts
 */
import assert from 'node:assert/strict';
import { describePreviewAgent, previewNote, previewQuery, readAccessPreview, describePreviewSkill } from '../accessPreview';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check('the question names the audience, and groups only for staff, trimmed', () => {
  assert.equal(previewQuery('shopper', 'customer-service'), 'audience=shopper');
  assert.equal(previewQuery('staff', ' customer-service , sales ,, '), 'audience=staff&groups=customer-service%2Csales');
  assert.equal(previewQuery('staff', ''), 'audience=staff');
});

check('the answer is read defensively: what is not recognisable is left out, and a wrong shape is refused', () => {
  const preview = readAccessPreview({
    audience: 'staff', groups: ['customer-service', 7], hasTable: true, unknownGroups: ['saels'], knownGroups: ['sales'],
    agents: [
      { agentId: 'order-help', name: 'Order help', level: 'default', via: 'row', opensFirst: true },
      { agentId: '', level: 'available' },
      { agentId: 'bad-level', level: 'owner' },
      null,
      { agentId: 'shopping-consultant', level: 'available', via: 'open' },
    ],
  });
  assert.ok(preview);
  assert.deepEqual(preview!.groups, ['customer-service']);
  assert.deepEqual(preview!.agents.map((a) => a.agentId), ['order-help', 'shopping-consultant']);
  assert.equal(preview!.agents[1].name, 'shopping-consultant', 'a missing name falls back to the id');
  assert.equal(readAccessPreview(null), undefined);
  assert.equal(readAccessPreview({ audience: 'customer', agents: [] }), undefined);
  assert.equal(readAccessPreview({ audience: 'staff' }), undefined);
});

check('each agent is described in plain words', () => {
  const base = { agentId: 'a', name: 'A', via: 'row' as const, opensFirst: false };
  assert.equal(describePreviewAgent({ ...base, level: 'required' }), 'Locked to this agent');
  assert.equal(describePreviewAgent({ ...base, level: 'default', opensFirst: true }), 'Opens first');
  assert.equal(describePreviewAgent({ ...base, level: 'default' }), 'Default for this group');
  assert.equal(describePreviewAgent({ ...base, level: 'available' }), 'Available');
  assert.equal(describePreviewAgent({ ...base, level: 'available', via: 'open' }), 'Open to everyone');
});

check('the note under the list says what the preview does and does not tell', () => {
  const base = { audience: 'staff' as const, groups: [], agents: [{ agentId: 'a', name: 'A', level: 'available' as const, via: 'open' as const, opensFirst: true }], unknownGroups: [], knownGroups: [], skills: [], hiddenSkills: [], hasSkillTable: false };
  assert.match(previewNote({ ...base, hasTable: false }), /every agent is open to everyone/);
  assert.match(previewNote({ ...base, hasTable: true }), /goes live only when you publish/);
  assert.match(previewNote({ ...base, hasTable: true, agents: [] }), /would have no agent/);
});

check('the preview reads the skills a person would have and the ones they would not', () => {
  const preview = readAccessPreview({
    audience: 'staff', groups: ['customer-service'], agents: [], unknownGroups: [], knownGroups: [], hasTable: true,
    skills: [
      { skillId: 'voice', name: 'Voice', description: 'How we sound', tier: 'always', level: null, via: 'own' },
      { skillId: 'orders', name: 'Orders', description: 'Order questions', tier: 'on_demand', level: 'available', via: 'row' },
      { skillId: '', name: 'No id' },
      { name: 'Also no id' },
    ],
    hiddenSkills: [{ skillId: 'quotes', name: 'Quotes' }, { name: 'no id' }],
    hasSkillTable: true,
  });
  assert.deepEqual(preview!.skills.map((k) => `${k.skillId}:${k.tier}:${k.level}`), ['voice:always:null', 'orders:on_demand:available']);
  assert.deepEqual(preview!.hiddenSkills, [{ skillId: 'quotes', name: 'Quotes' }]);
  assert.equal(preview!.hasSkillTable, true);
  assert.deepEqual(readAccessPreview({ audience: 'shopper', agents: [] })!.skills, [], 'an answer without skills is read as none');
});

check('each skill is described in plain words', () => {
  const base = { skillId: 's', name: 'S', description: 'd', via: 'row' as const };
  assert.equal(describePreviewSkill({ ...base, tier: 'always', level: 'required' }), 'Always on, cannot be turned off');
  assert.equal(describePreviewSkill({ ...base, tier: 'always', level: 'default' }), 'Installed for this group');
  assert.equal(describePreviewSkill({ ...base, tier: 'on_demand', level: 'available' }), 'Opened when a request fits');
  assert.equal(describePreviewSkill({ ...base, via: 'own', tier: 'always', level: null }), 'Always on');
  assert.equal(describePreviewSkill({ ...base, via: 'own', tier: 'on_demand', level: null }), 'Opened when a request fits');
});

console.log(`✅ web: view as: ${passed} passed, 0 failed`);
