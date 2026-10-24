import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { compileAgent, overlayDraft } from '../../../scripts/dev/pack-overlay';

const suite = createSuite('dev: a draft pack laid over the live one');

const live = () => ({
  manifest: { version: '1.3.24' },
  profile: { companyName: 'Shop', brandTone: 'old tone' },
  agents: [
    { agentId: 'advisor', isDefault: true, modelPolicyRef: 'complex_reasoning', allowedTools: ['search_products'], journeyPlaybook: { stages: [{ name: 'a' }] } },
    { agentId: 'service', modelPolicyRef: 'fast_intent', allowedTools: [] },
  ],
  extensions: { agentMode: { enabled: true }, customerEvents: { autoTurnEvents: ['addToCart'] } },
  conversationPolicy: { turnDeadlineMs: 45000 },
});
const draft = {
  profile: { brandTone: 'warm' },
  persona: { voice: 'friendly' },
  skills: [{ skillId: 's1', name: 'S', description: 'd', instructions: 'i', tier: 'always', tools: [] }],
  extensions: { quantityHelper: { allowancePercent: 10 }, visualiser: { enabled: true } },
  agents: [{ agentId: 'advisor', name: 'Advisor', purpose: 'p', systemPromptTemplate: 'You advise.', allowedTools: ['search_products', 'explore_options'], skills: ['s1'], isDefault: true, toolFirst: true }],
};

async function main() {
  await suite.test('the draft\'s agents, skills and settings replace the live ones, and the rest of the live pack stays', () => {
    const before = live();
    const pack = overlayDraft(before, draft);
    assert.deepEqual(pack.agents.map((a: any) => a.agentId), ['advisor']);
    assert.deepEqual(pack.agents[0].allowedTools, ['search_products', 'explore_options']);
    assert.deepEqual(pack.agents[0].skills, ['s1']);
    assert.equal(pack.agents[0].modelPolicyRef, 'complex_reasoning', 'a policy the draft does not name is the live default\'s');
    assert.deepEqual(pack.agents[0].journeyPlaybook, { stages: [{ name: 'a' }] }, 'the live agent\'s playbook is kept');
    assert.equal(pack.extensions.agentMode.enabled, true, 'live extensions stay');
    assert.deepEqual(pack.extensions.skills, draft.skills);
    assert.equal(pack.extensions.quantityHelper.allowancePercent, 10);
    assert.equal(pack.profile.brandTone, 'warm');
    assert.equal(pack.profile.companyName, 'Shop', 'profile fields the draft does not set stay');
    assert.equal(pack.conversationPolicy.turnDeadlineMs, 45000);
    assert.deepEqual(before, live(), 'the live pack passed in is not changed');
  });

  await suite.test('an agent is compiled with the fields a published agent has', () => {
    const agent = compileAgent({ agentId: 'x', name: 'X', purpose: 'p', systemPromptTemplate: ' text ', allowedTools: ['a'] }, live(), {});
    assert.equal(agent.systemPromptTemplate, 'text');
    assert.equal(agent.maxTurns, 5);
    assert.deepEqual(agent.handoffConditions, []);
    assert.equal(agent.modelPolicyRef, 'complex_reasoning');
  });

  await suite.test('a draft with no agents leaves the live agents alone', () => {
    assert.deepEqual(overlayDraft(live(), { skills: [] }).agents.map((a: any) => a.agentId), ['advisor', 'service']);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
