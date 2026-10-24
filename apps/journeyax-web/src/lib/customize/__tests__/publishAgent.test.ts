/**
 * Making a draft agent live: what is allowed in, and what the new agent looks like.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/publishAgent.test.ts
 */
import assert from 'node:assert/strict';
import { buildPublishableAgent, type PublishContext } from '../publishAgent';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const context: PublishContext = {
  existingAgents: [{ agentId: 'advisor', name: 'Advisor', isDefault: true, modelPolicyRef: 'complex_reasoning' }, { agentId: 'quote_helper', name: 'Quote helper' }],
  knownTools: ['search_products', 'present_card', 'get_cart'],
  knownSkills: ['finish-the-job'],
  modelPolicyRef: 'complex_reasoning',
};
const draft = { name: 'Quote helper', purpose: 'Turns a materials list into a quote', instructions: 'Ask for the list, then build the quote.', skills: ['finish-the-job'], tools: ['search_products', 'get_cart'], knowledgeNote: '' };

console.log('publishing an agent draft');

check('a good draft becomes a new agent appended after the existing ones, with an id nobody has', () => {
  const built = buildPublishableAgent(draft, context);
  assert.equal(built.ok, true);
  const good = built as Extract<typeof built, { ok: true }>;
  assert.equal(good.agent.agentId, 'quote_helper_2', 'the id is made new');
  assert.equal(good.agent.systemPromptTemplate, 'Ask for the list, then build the quote.');
  assert.deepEqual(good.agent.allowedTools, ['search_products', 'get_cart']);
  assert.deepEqual(good.agent.skills, ['finish-the-job']);
  assert.equal(good.agent.modelPolicyRef, 'complex_reasoning');
  assert.equal(good.agent.isDefault, undefined, 'a new agent is never the default');
  assert.deepEqual(good.agents.slice(0, 2), context.existingAgents, 'existing agents are untouched');
  assert.equal(good.agents.length, 3);
});

check('an unknown tool or skill, or an empty field, is refused with what is wrong', () => {
  const bad = buildPublishableAgent({ ...draft, tools: ['delete_everything'], skills: ['made-up'], instructions: ' ' }, context);
  assert.equal(bad.ok, false);
  const errors: string[] = (bad as { errors?: string[] }).errors || [];
  assert.ok(errors.some((e) => /delete_everything/.test(e)));
  assert.ok(errors.some((e) => /made-up/.test(e)));
  assert.ok(errors.some((e) => /instructions/i.test(e)));
});

check('limits hold, and a pack with no model policy or no agents cannot take a new one', () => {
  assert.ok(!buildPublishableAgent({ ...draft, instructions: 'x'.repeat(8001) }, context).ok);
  assert.ok(!buildPublishableAgent({ ...draft, name: 'n'.repeat(61) }, context).ok);
  assert.ok(!buildPublishableAgent(draft, { ...context, modelPolicyRef: undefined }).ok);
  assert.ok(!buildPublishableAgent(draft, { ...context, existingAgents: [] }).ok);
});

console.log(`✅ web: publishing an agent draft: ${passed} passed, 0 failed`);
