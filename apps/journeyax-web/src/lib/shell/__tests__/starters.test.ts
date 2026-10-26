/**
 * The questions the empty chat offers a person, taken from what they may use.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/starters.test.ts
 */
import assert from 'node:assert/strict';
import { MAX_STARTERS, startersFor } from '../starters';
import { parseConnectorList } from '../../connectors/connectors';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const tools = (names: Array<[string, 'allow' | 'ask' | 'blocked']>) => names.filter(([, s]) => s !== 'blocked').map(([name, state]) => ({ name, kind: name.startsWith('create') ? 'write' : 'read', state }));
const list = (shape: Record<string, Array<[string, 'allow' | 'ask' | 'blocked']>>) => parseConnectorList({ connectors: Object.entries(shape).map(([connector, t]) => ({ connector, name: connector, tools: tools(t) })) });
const SHOP = [{ label: 'Help me choose', prompt: 'Help me choose.' }, { label: 'A full recommendation', prompt: 'Recommend.' }];

console.log('empty-chat starters');

check('a customer service adviser is offered accounts, orders and cases, one system at a time', () => {
  const got = startersFor(list({
    salesforce: [['find_account', 'allow'], ['list_cases', 'allow'], ['create_case', 'ask'], ['list_opportunities', 'blocked']],
    commercetools: [['order_history', 'allow'], ['get_order', 'allow'], ['stock_by_branch', 'allow']],
  }), SHOP);
  assert.equal(got.length, MAX_STARTERS);
  assert.deepEqual(got.map((s) => s.label), ['Tell me about a trade account', 'See an account’s recent orders', 'Show the open cases', 'Check stock at a branch']);
  assert.ok(!got.some((s) => /deals/i.test(s.label)), 'nothing they would be refused');
});

check('a tool that is blocked is never offered, and one that asks first is', () => {
  const got = startersFor(list({ salesforce: [['find_account', 'allow'], ['create_case', 'ask'], ['list_cases', 'blocked'], ['pipeline_summary', 'blocked']] }), SHOP);
  assert.deepEqual(got.map((s) => s.label), ['Tell me about a trade account', 'Raise a case for a customer']);
});

check('marketing is offered campaigns and web traffic, not cases', () => {
  const got = startersFor(list({ salesforce: [['list_campaigns', 'allow']], 'google-analytics': [['traffic_by_page', 'allow']], 'marketing-cloud': [['list_messages', 'allow']] }), SHOP);
  assert.deepEqual(got.map((s) => s.label).sort(), ['How is the website doing?', 'What campaigns are running?', 'What messages went out?'].sort());
});

check('fewer than two things to offer, or no connected system, leaves the shop\'s own starters', () => {
  assert.deepEqual(startersFor([], SHOP), SHOP);
  assert.deepEqual(startersFor(list({ salesforce: [['find_account', 'allow']] }), SHOP), SHOP);
  assert.deepEqual(startersFor(list({ 'unknown-system': [['do_it', 'allow']] }), SHOP), SHOP);
});

check('every question is a sentence a person could send as it is, and asks for what it needs rather than inventing it', () => {
  const all = startersFor(list({
    salesforce: [['find_account', 'allow'], ['list_cases', 'allow'], ['create_case', 'ask'], ['list_opportunities', 'allow'], ['pipeline_summary', 'allow'], ['list_campaigns', 'allow']],
    commercetools: [['order_history', 'allow'], ['get_order', 'allow'], ['stock_by_branch', 'allow']],
  }), SHOP);
  for (const s of all) { assert.ok(s.prompt.length > 15 && /[.?]$/.test(s.prompt), s.prompt); assert.ok(s.label.length < 40, s.label); }
  assert.ok(all.filter((s) => /Ask me/.test(s.prompt)).length >= 2);
});

console.log(`✅ web: empty-chat starters: ${passed} passed, 0 failed`);
