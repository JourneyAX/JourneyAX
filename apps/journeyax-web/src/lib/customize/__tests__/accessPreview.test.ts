/**
 * "View as": the question Customize asks and how it reads the answer.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/accessPreview.test.ts
 */
import assert from 'node:assert/strict';
import { describePreviewAgent, previewNote, previewQuery, readAccessPreview } from '../accessPreview';

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
  const base = { audience: 'staff' as const, groups: [], agents: [{ agentId: 'a', name: 'A', level: 'available' as const, via: 'open' as const, opensFirst: true }], unknownGroups: [], knownGroups: [] };
  assert.match(previewNote({ ...base, hasTable: false }), /every agent is open to everyone/);
  assert.match(previewNote({ ...base, hasTable: true }), /goes live only when you publish/);
  assert.match(previewNote({ ...base, hasTable: true, agents: [] }), /would have no agent/);
});

console.log(`✅ web: view as: ${passed} passed, 0 failed`);
