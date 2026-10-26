/**
 * The connectors section of the "+" menu as the person sees it.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/shell/__tests__/connectorMenu.test.ts
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectorMenu from '../ConnectorMenu';
import { parseConnectorList } from '../../../lib/connectors/connectors';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const items = parseConnectorList({
  connectors: [
    { connector: 'stock-system', name: 'Stock system', description: 'Stock by branch.', owner: 'Supply chain', sample: true, tools: [{ name: 'stock_by_branch', kind: 'read', state: 'allow' }, { name: 'reserve_stock', kind: 'write', state: 'ask' }] },
    { connector: 'crm', name: 'CRM', description: 'Accounts and cases.', owner: 'Sales', tools: [{ name: 'find_account', kind: 'read', state: 'allow' }] },
  ],
});
const render = (off: string[]) => renderToStaticMarkup(React.createElement(ConnectorMenu as any, { items, off, onToggle: () => {} }));

check('nothing is drawn when the person has no connectors', () => {
  assert.equal(renderToStaticMarkup(React.createElement(ConnectorMenu as any, { items: [], off: [], onToggle: () => {} })), '');
});

check('each connector shows its name and a switch that is on, and nothing else', () => {
  const html = render([]);
  for (const text of ['Connectors', 'Stock system', 'CRM']) assert.ok(html.includes(text), `shows "${text}"`);
  for (const text of ['Sample data', 'Looks things up', 'Switch one off']) assert.ok(!html.includes(text), `does not show "${text}"`);
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 2, 'both start on');
  assert.equal((html.match(/role="menuitemcheckbox"/g) || []).length, 2);
});

check('a system named with (sample) is shown by its name alone', () => {
  const named = parseConnectorList({ connectors: [{ connector: 'mc', name: 'Salesforce Marketing Cloud (sample)', description: 'Campaigns.', owner: 'Marketing', sample: true, tools: [{ name: 'list_campaigns', kind: 'read', state: 'allow' }] }] });
  const html = renderToStaticMarkup(React.createElement(ConnectorMenu as any, { items: named, off: [], onToggle: () => {} }));
  assert.ok(html.includes('Salesforce Marketing Cloud') && !/sample/i.test(html));
});

check('a connector switched off for the chat shows its switch off, the others stay on', () => {
  const html = render(['stock-system']);
  assert.equal((html.match(/aria-checked="false"/g) || []).length, 1);
  assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
  assert.equal((html.match(/data-on="false"/g) || []).length, 1);
});

console.log(`✅ web: connector menu: ${passed} passed, 0 failed`);
