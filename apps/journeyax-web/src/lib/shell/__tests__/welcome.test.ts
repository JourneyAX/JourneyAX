/**
 * What the empty chat says to a team, as the pack words it.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/welcome.test.ts
 */
import assert from 'node:assert/strict';
import { fillGreeting, parseWelcome, welcomeOffer, welcomeStarters } from '../welcome';
import { parseConnectorList } from '../../connectors/connectors';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const morning = new Date('2026-10-26T09:00:00');
const list = (shape: Record<string, string[]>) => parseConnectorList({ connectors: Object.entries(shape).map(([connector, names]) => ({ connector, name: connector, tools: names.map((name) => ({ name, kind: 'read', state: 'allow' })) })) });

console.log('team welcome');

check('the greeting is filled in with the time of day and the first name, and reads well without a name', () => {
  assert.equal(fillGreeting('{hello}, {name}. Who are we helping today?', 'Finn Paterson', morning), 'Good morning, Finn. Who are we helping today?');
  assert.equal(fillGreeting('{hello}, {name}. Who are we helping today?', '', morning), 'Good morning. Who are we helping today?');
  assert.equal(fillGreeting('What needs sorting?', 'Finn', morning), 'What needs sorting?');
  assert.equal(fillGreeting(undefined, 'Finn', morning), undefined);
});

check('only well-formed parts of the welcome are kept', () => {
  const welcome = parseWelcome({ welcome: { headline: ' Hello ', subtitle: 5, starters: [{ label: 'a', prompt: 'b', needs: ['salesforce.find_account', 'bad'] }, { label: '', prompt: 'x' }, null] } });
  assert.deepEqual(welcome, { headline: 'Hello', subtitle: undefined, starters: [{ label: 'a', prompt: 'b', needs: ['salesforce.find_account'] }] });
  assert.equal(parseWelcome({}), undefined);
  assert.equal(parseWelcome({ welcome: 'x' }), undefined);
  assert.equal(parseWelcome({ welcome: {} }), undefined);
});

check('the message-box wording is kept when it is words, and a welcome with only that is still a welcome', () => {
  assert.equal(parseWelcome({ welcome: { headline: 'Hi', placeholder: ' Ask about a ticket… ' } })?.placeholder, 'Ask about a ticket…');
  assert.equal('placeholder' in (parseWelcome({ welcome: { headline: 'Hi', placeholder: 7 } }) ?? {}), false);
  assert.deepEqual(parseWelcome({ welcome: { placeholder: 'Ask about stock…' } }), { headline: undefined, subtitle: undefined, placeholder: 'Ask about stock…' });
  assert.equal(parseWelcome({ welcome: { placeholder: 'x'.repeat(300) } })?.placeholder?.length, 100);
});

check('a starter is offered only when the person may use every tool it needs', () => {
  const welcome = parseWelcome({ welcome: { starters: [
    { label: 'Call', prompt: 'p1', needs: ['salesforce.find_account'] },
    { label: 'Deals', prompt: 'p2', needs: ['salesforce.list_opportunities'] },
    { label: 'Both', prompt: 'p3', needs: ['salesforce.find_account', 'commercetools.get_order'] },
    { label: 'Anything', prompt: 'p4' },
  ] } });
  const got = welcomeStarters(welcome, list({ salesforce: ['find_account'] }));
  assert.deepEqual(got?.map((s) => s.label), ['Call', 'Anything']);
  assert.deepEqual(got?.[0], { label: 'Call', prompt: 'p1' }, 'the page keeps only the words');
});

check('no starters to offer means the page falls back to its own', () => {
  assert.equal(welcomeStarters(undefined, list({ salesforce: ['find_account'] })), undefined);
  assert.equal(welcomeStarters(parseWelcome({ welcome: { starters: [{ label: 'Deals', prompt: 'p', needs: ['salesforce.list_opportunities'] }] } }), list({ salesforce: ['find_account'] })), undefined);
});

check('a team with starters of its own is never shown the shop’s: nothing usable means nothing offered', () => {
  const team = parseWelcome({ welcome: { headline: 'What would you like to measure?', starters: [
    { label: 'Website', prompt: 'p1', needs: ['google-analytics.traffic_by_page'] },
    { label: 'Report', prompt: 'p2', needs: ['power-bi.list_reports'] },
  ] } });
  assert.deepEqual(welcomeOffer(team, list({})), [], 'no system connected yet: no buttons, not the shopper ones');
  assert.deepEqual(welcomeOffer(team, list({ 'google-analytics': ['traffic_by_page'] }))?.map((s) => s.label), ['Website'], 'the usable one is still offered');
});

check('the page still falls back to its own when the pack has no starters for the person', () => {
  assert.equal(welcomeOffer(undefined, list({ salesforce: ['find_account'] })), undefined, 'a shopper has no entry');
  assert.equal(welcomeOffer(parseWelcome({ welcome: { headline: 'How can we help?' } }), list({})), undefined, 'an entry with words but no starters');
});

console.log(`\n${passed} passed`);
