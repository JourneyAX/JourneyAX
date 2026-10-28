/**
 * The brand overlay: the shop's name taken out of every piece of text, the brand's own name, logo and button colours put in, and nothing
 * changed when the overlay is off.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/brand/__tests__/overlay.test.ts
 */
import assert from 'node:assert/strict';
import { AI_STRATEGY, applyBrandOverlay, overlayFromEnv, readableId, rebrandText, removeNames, removeNamesDeep, setRebrand } from '../overlay';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const NAMES = ['PlaceMakers', 'Placemakers', 'PLACEMAKERS'];

console.log('brand overlay');

check('the shop name goes, and the sentence still reads well', () => {
  assert.equal(removeNames('Build it right with PlaceMakers.', NAMES), 'Build it right.');
  assert.equal(removeNames('Welcome to PlaceMakers', NAMES), 'Welcome');
  assert.equal(removeNames('The PlaceMakers team will call you.', NAMES), 'The team will call you.');
  assert.equal(removeNames("PlaceMakers's trade desk is open.", NAMES), 'trade desk is open.');
  assert.equal(removeNames('Placemakers PLACEMAKERS PlaceMakers', NAMES), '', 'the ways the name is written');
  assert.equal(removeNames('csr@placemakers.demo and placemakers_product_advisor', NAMES), 'csr@placemakers.demo and placemakers_product_advisor', 'an address or an id is not a name');
  assert.equal(removeNames('Nothing to remove here.', NAMES), 'Nothing to remove here.');
});

check('line breaks and list indentation are never touched', () => {
  const text = 'PlaceMakers deals:\n  - first item\n  - second item';
  assert.equal(removeNames(text, NAMES), 'deals:\n  - first item\n  - second item');
});

check('every string in a config goes through it, keys are left alone', () => {
  const config = { companyName: 'PlaceMakers', intro: { heroHeadline: 'Build it right with PlaceMakers.', starters: [{ label: 'PlaceMakers stock', prompt: 'Check PlaceMakers stock' }] }, PlaceMakers: 1, n: 3 };
  assert.deepEqual(removeNamesDeep(config, NAMES), { companyName: '', intro: { heroHeadline: 'Build it right.', starters: [{ label: 'stock', prompt: 'Check stock' }] }, PlaceMakers: 1, n: 3 });
});

check('under the overlay the brand is the brand’s: names, colours, no picture, and the shop name nowhere', () => {
  const shop = { companyName: 'PlaceMakers', systemName: 'PlaceMakers Digital Trade Consultant', greeting: 'Kia ora from PlaceMakers!', theme: { logoUrl: '/brands/placemakers.png', primaryColor: '#A52E80', sidebarStyle: 'dark' as const }, uiTheme: { tokens: { colors: { brand: '#A52E80', bg: '#FAF8F4' } } }, labels: { headerTitle: 'AI Configurator', items: 'Products' } };
  const shown: any = applyBrandOverlay(shop, AI_STRATEGY);
  assert.equal(shown.companyName, 'AI strategy & enablement');
  assert.equal(shown.systemName, 'The assistant');
  assert.equal(shown.theme.logoUrl, undefined);
  assert.equal(shown.theme.sidebarStyle, 'dark', 'the rest of the theme stays');
  assert.equal(shown.uiTheme.tokens.colors.brand, '#4545F5');
  assert.equal(shown.uiTheme.tokens.colors.action, '#4545F5');
  assert.equal(shown.uiTheme.tokens.colors.bg, '#FAF8F4', 'backgrounds are left alone');
  assert.equal(shown.greeting, 'Kia ora!');
  const { brandOverlay: _list, ...whatIsShown } = shown; // the list of names to take out is the one place the name is kept: it is never drawn
  assert.ok(!/placemakers/i.test(JSON.stringify(whatIsShown)), 'the shop name is nowhere in what the page can show');
  assert.ok(shown.brandOverlay.remove.includes('PlaceMakers'));
  assert.equal(removeNamesDeep({ projectId: 'placemakers', agentId: 'placemakers_product_advisor' }, AI_STRATEGY.remove).projectId, 'placemakers', 'the project id is never changed');
});

check('the overlay is off unless it is named, and an unknown name is off too', () => {
  assert.equal(overlayFromEnv(undefined), undefined);
  assert.equal(overlayFromEnv(''), undefined);
  assert.equal(overlayFromEnv('nonsense'), undefined);
  assert.equal(overlayFromEnv(' AI-Strategy ')?.id, 'ai-strategy');
});

check('in the browser the assistant’s words are cleaned only while the overlay is on', () => {
  setRebrand(undefined);
  assert.equal(rebrandText('Ask PlaceMakers anything.'), 'Ask PlaceMakers anything.');
  setRebrand(AI_STRATEGY.remove);
  assert.equal(rebrandText('Ask PlaceMakers anything.'), 'Ask anything.');
  setRebrand(undefined);
});

check('an internal id shown to a person loses the shop\u2019s name only under the overlay', () => {
  setRebrand(undefined);
  assert.equal(readableId('placemakers_customer_service'), 'placemakers_customer_service');
  setRebrand(AI_STRATEGY.remove);
  assert.equal(readableId('placemakers_customer_service'), 'customer service');
  assert.equal(readableId('other_agent'), 'other_agent');
  setRebrand(undefined);
});

console.log(`\n${passed} passed`);
