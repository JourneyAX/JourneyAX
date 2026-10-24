/**
 * Customize overview: what a published pack turns into, and how agent drafts are kept.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/overview.test.ts
 */
import assert from 'node:assert/strict';
import { buildConnectors, buildOverview, readAgents, readKnowledge, readSkills } from '../overview';
import { describeTool, humaniseToolId } from '../tool-catalog';
import { draftToPackAgentJson, removeDraft, slugify, upsertDraft, validateDraft, loadDrafts, draftsKey } from '../drafts';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const PACK = {
  packVersion: '1.3.24',
  agents: [
    { agentId: 'advisor', name: 'Advisor', purpose: 'Helps choose', isDefault: true, allowedTools: ['search_products', 'check_stock'], modelPolicyRef: 'complex', handoffConditions: ['Asks for a person'], systemPromptTemplate: 'SECRET PROMPT' },
    { agentId: 'service', purpose: 'Answers service questions', allowedTools: ['check_stock', 'hand_off_to_human'], skills: ['greet', ' '], modelPolicyRef: 'fast' },
  ],
  extensions: {
    skills: [
      { skillId: 'greet', name: 'Greeting', description: 'How to open', instructions: 'Say hello first.', tier: 'on_demand', tools: ['search_products'] },
      { skillId: 'greet', name: 'Duplicate', description: 'x', instructions: 'y' },
      { name: 'No id', description: 'x', instructions: 'y' },
    ],
  },
  knowledgeModel: { releaseId: 'okf-1.8.0', version: '1.8.0', required: true, checksum: 'abc' },
  knowledgeSource: { sources: [{ id: 'catalog', type: 'csv-feed', role: 'product', label: 'Product catalogue', enabled: true, url: 'http://secret.example/feed.csv' }, { id: 'web', type: 'web', enabled: false }] },
};

console.log('customize overview');

check('agents are read as the pack states them, without their prompts, and the default is marked', () => {
  const agents = readAgents(PACK);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0], { agentId: 'advisor', name: 'Advisor', purpose: 'Helps choose', isDefault: true, allowedTools: ['search_products', 'check_stock'], skills: [], modelPolicyRef: 'complex', handoffConditions: ['Asks for a person'] });
  assert.equal(agents[1].name, 'service', 'a missing name falls back to the id');
  assert.deepEqual(agents[1].skills, ['greet'], 'blank skill ids are dropped');
  assert.equal(JSON.stringify(agents).includes('SECRET PROMPT'), false, 'the system prompt never leaves the server');
});

check('the default agent follows defaultAgentId, or the only agent when there is one', () => {
  const byId = readAgents({ defaultAgentId: 'b', agents: [{ agentId: 'a', purpose: '' }, { agentId: 'b', purpose: '' }] });
  assert.deepEqual(byId.map((a) => a.isDefault), [false, true]);
  assert.equal(readAgents({ agents: [{ agentId: 'solo', purpose: '' }] })[0].isDefault, true);
  assert.deepEqual(readAgents({ agents: [{ agentId: 'a' }, { agentId: 'b' }] }).map((a) => a.isDefault), [false, false]);
  assert.deepEqual(readAgents({}), []);
  assert.deepEqual(readAgents({ agents: 'nope' }), []);
});

check('skills come from the pack when it has them and only then; instructions only for people who can edit', () => {
  const withText = readSkills(PACK, true);
  assert.equal(withText.length, 1, 'duplicates and entries without an id are skipped');
  assert.deepEqual(withText[0], { skillId: 'greet', name: 'Greeting', description: 'How to open', tier: 'on_demand', tools: ['search_products'], instructions: 'Say hello first.' });
  assert.equal('instructions' in readSkills(PACK, false)[0], false);
  assert.deepEqual(readSkills({ agents: [] }, true), [], 'no skills in the pack means none are shown');
  assert.equal(readSkills({ skills: [{ skillId: 'top', name: 'Top', description: 'd', instructions: 'i' }] }, false)[0].tier, 'always');
});

check('knowledge shows the bound release and the sources, never their addresses', () => {
  const knowledge = readKnowledge(PACK);
  assert.equal(knowledge.releaseId, 'okf-1.8.0');
  assert.equal(knowledge.version, '1.8.0');
  assert.equal(knowledge.required, true);
  assert.equal(knowledge.conceptCount, undefined, 'a count nobody supplied is not made up');
  assert.deepEqual(knowledge.sources.map((s) => [s.id, s.label, s.kind, s.enabled]), [['catalog', 'Product catalogue', 'csv-feed', true], ['web', 'web', 'web', false]]);
  assert.equal(JSON.stringify(knowledge).includes('secret.example'), false);
  assert.deepEqual(readKnowledge({}), { sources: [] });
});

check('connectors list the tools agents may call first, with who can call them, then the rest of the platform tools', () => {
  const agents = readAgents(PACK);
  const connectors = buildConnectors(agents);
  assert.deepEqual(connectors.slice(0, 3).map((c) => c.id), ['search_products', 'check_stock', 'hand_off_to_human']);
  assert.deepEqual(connectors[1].usedBy, ['advisor', 'service']);
  assert.equal(connectors[0].kind, 'platform_tool');
  assert.ok(connectors[0].description.length > 10);
  assert.ok(connectors.find((c) => c.id === 'browse_range' && c.usedBy.length === 0), 'a platform tool nobody uses is still listed');
  assert.equal(new Set(connectors.map((c) => c.id)).size, connectors.length, 'no tool is listed twice');
  assert.equal(buildConnectors(readAgents({ agents: [{ agentId: 'w', allowedTools: ['*', 'custom_tool'] }] })).some((c) => c.id === '*'), false, 'a wildcard is not a tool');
  assert.equal(describeTool('custom_tool').name, 'Custom tool');
  assert.equal(humaniseToolId('getThingNow'), 'Get thing now');
});

check('the whole overview carries the pack version, and works for a pack with nothing in it', () => {
  const full = buildOverview('acme', PACK, { canViewInstructions: false });
  assert.equal(full.packVersion, '1.3.24');
  assert.equal(full.tenantId, 'acme');
  assert.equal(full.canViewInstructions, false);
  const empty = buildOverview('acme', {}, { canViewInstructions: true });
  assert.deepEqual([empty.agents, empty.skills, empty.knowledge.sources], [[], [], []]);
  assert.ok(empty.connectors.length > 0, 'the platform tools are still listed');
  assert.equal(empty.packVersion, undefined);
});

check('drafts: validated, saved per tenant, edited in place, removed, and turned into pack-shaped JSON', () => {
  const input = { name: ' Quote helper ', purpose: 'Builds quotes', instructions: 'Ask for sizes.', skills: ['greet', 'greet'], tools: ['create_quote'], knowledgeNote: 'Use the install guides.' };
  assert.equal(validateDraft(input).ok, true);
  assert.deepEqual(Object.keys(validateDraft({ ...input, name: ' ', purpose: '', instructions: '' }).errors), ['name', 'purpose', 'instructions']);

  const first = upsertDraft([], input, undefined, 1000);
  assert.equal(first.draft.name, 'Quote helper');
  assert.deepEqual(first.draft.skills, ['greet'], 'duplicate picks collapse');
  assert.equal(first.list.length, 1);
  const edited = upsertDraft(first.list, { ...input, purpose: 'Builds trade quotes' }, first.draft.draftId, 2000);
  assert.equal(edited.list.length, 1, 'editing replaces, it does not add');
  assert.equal(edited.draft.createdAt, 1000);
  assert.equal(edited.draft.updatedAt, 2000);
  const other = upsertDraft(edited.list, { ...input, name: 'Second' }, undefined, 3000);
  assert.deepEqual(other.list.map((d) => d.name), ['Second', 'Quote helper'], 'newest first');
  assert.deepEqual(removeDraft(other.list, other.draft.draftId).map((d) => d.name), ['Quote helper']);

  const json = JSON.parse(draftToPackAgentJson(edited.draft, { modelPolicyRef: 'complex', takenIds: ['quote_helper'] }));
  assert.equal(json.agentId, 'quote_helper_2', 'the id avoids ids already in the pack');
  assert.equal(json.systemPromptTemplate, 'Ask for sizes.');
  assert.deepEqual(json.allowedTools, ['create_quote']);
  assert.equal(json.modelPolicyRef, 'complex');
  assert.equal(json.knowledgeNote, 'Use the install guides.');
  assert.equal(JSON.parse(draftToPackAgentJson(edited.draft)).modelPolicyRef, undefined, 'no model policy is invented');
  assert.equal(slugify('  !! '), 'agent');
  assert.equal(draftsKey('acme'), 'ax:agent-drafts:acme');
  assert.deepEqual(loadDrafts('acme'), [], 'no storage means no drafts, not an error');
});

console.log(`✅ web: customize overview: ${passed} passed, 0 failed`);
