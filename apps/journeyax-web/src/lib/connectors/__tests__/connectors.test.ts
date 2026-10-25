/**
 * What the "+" menu shows about connectors, and what a conversation sends back.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/connectors/__tests__/connectors.test.ts
 */
import assert from 'node:assert/strict';
import { connectorCapability, connectorsOffKey, parseConnectorList, readOff, toggled, writeOff, type ConnectorItem } from '../connectors';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// a tiny stand-in for the browser's storage
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const server = {
  connectors: [
    { connector: 'stock-system', name: 'Stock system', description: 'Stock by branch.', owner: 'Supply chain', sample: true, tools: [{ name: 'stock_by_branch', kind: 'read', state: 'allow' }, { name: 'reserve_stock', kind: 'write', state: 'ask', summary: 'Set stock aside' }] },
    { connector: 'crm', name: 'CRM', description: 'Accounts and cases.', owner: 'Sales', tools: [{ name: 'find_account', kind: 'read', state: 'allow' }] },
    { name: 'no id' },
    null,
  ],
};

check('only well-formed connectors are kept, and missing fields get safe values', () => {
  const items = parseConnectorList(server);
  assert.deepEqual(items.map((item) => item.connector), ['stock-system', 'crm']);
  assert.equal(items[0].sample, true);
  assert.equal(items[1].sample, false);
  assert.equal(items[0].tools[1].summary, 'Set stock aside');
  assert.deepEqual(parseConnectorList(undefined), []);
  assert.deepEqual(parseConnectorList({ connectors: 'nope' }), []);
});

check('the capability line says what the connector does in plain words', () => {
  const [stock, crm] = parseConnectorList(server);
  assert.equal(connectorCapability(stock), 'Looks things up; asks you first before changing anything');
  assert.equal(connectorCapability(crm), 'Looks things up');
  assert.equal(connectorCapability({ ...crm, tools: [] }), 'No tools');
});

check('switching off is per conversation, remembered, and limited to connectors the person is shown', () => {
  const shown = parseConnectorList(server);
  assert.deepEqual(readOff('placemakers', 'c1', shown), []);
  writeOff('placemakers', 'c1', toggled(toggled([], 'stock-system'), 'crm'));
  assert.deepEqual(readOff('placemakers', 'c1', shown), ['stock-system', 'crm']);
  assert.deepEqual(readOff('placemakers', 'c2', shown), [], 'another conversation is unaffected');
  assert.deepEqual(readOff('placemakers', 'c1', shown.slice(1)), ['crm'], 'a connector the person is no longer shown is forgotten');
  writeOff('placemakers', 'c1', toggled(['stock-system', 'crm'], 'stock-system'));
  assert.deepEqual(readOff('placemakers', 'c1', shown), ['crm']);
  writeOff('placemakers', 'c1', []);
  assert.equal(store.has(connectorsOffKey('placemakers', 'c1')), false, 'nothing is kept when nothing is off');
});

check('a damaged stored value gives an empty list, not an error', () => {
  store.set(connectorsOffKey('placemakers', 'c3'), '{not json');
  assert.deepEqual(readOff('placemakers', 'c3', parseConnectorList(server)), []);
  store.set(connectorsOffKey('placemakers', 'c3'), '[1,"stock-system",null]');
  assert.deepEqual(readOff('placemakers', 'c3', parseConnectorList(server)), ['stock-system']);
});

console.log(`✅ web: connectors: ${passed} passed, 0 failed`);
