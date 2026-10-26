/**
 * The chat's "+" menu as the person sees it: Skills, Connectors and Plugins rows, each opening a list with Manage and Browse.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/components/shell/__tests__/plusMenu.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PlusMenu from '../PlusMenu';
import { parseConnectorList } from '../../../lib/connectors/connectors';
import { plusMenuModel } from '../../../lib/shell/plusMenu';
import { buildOverview } from '../../../lib/customize/overview';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const pack = { packVersion: '1.3.40', agents: draft.agents, extensions: { ...draft.extensions, skills: draft.skills } };
const builder = plusMenuModel(buildOverview('placemakers', pack, { canViewInstructions: true, canEdit: true }));
const everyone = plusMenuModel(buildOverview('placemakers', pack, { canViewInstructions: false, canEdit: false }));
const connectors = parseConnectorList({ connectors: [
  { connector: 'crm', name: 'CRM', description: 'Accounts and cases.', owner: 'Sales', tools: [{ name: 'find_account', kind: 'read', state: 'allow' }] },
  { connector: 'stock', name: 'Stock system (sample)', description: 'Stock.', owner: 'Supply', sample: true, tools: [{ name: 'stock_by_branch', kind: 'read', state: 'allow' }] },
] });
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(PlusMenu as any, {
  model: builder, connectors, off: [], search: '?project=pm', onToggleConnector: () => {}, onPickSkill: () => {}, onClose: () => {}, ...props,
}));

console.log('the + menu lists');

check('nothing is drawn for someone with no connectors who does not manage the assistant', () => {
  assert.equal(render({ model: everyone, connectors: [] }), '');
});

check('a person who manages the assistant sees Skills, Connectors and Plugins, all closed', () => {
  const html = render({});
  for (const label of ['Skills', 'Connectors', 'Plugins']) assert.ok(html.includes(`>${label}<`), label);
  assert.equal((html.match(/aria-haspopup="menu"/g) || []).length, 3);
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 3);
  assert.ok(!html.includes('Manage skills'), 'the lists open on a click');
});

check('everyone else sees only Connectors', () => {
  const html = render({ model: everyone });
  assert.ok(html.includes('>Connectors<'));
  assert.ok(!html.includes('>Skills<') && !html.includes('>Plugins<'));
});

check('a connector switched off in this chat is counted on the row', () => {
  assert.ok(render({ off: ['crm'] }).includes('1 off'));
  assert.ok(!render({ off: [] }).includes(' off<'));
});

console.log('an open list');

check('Skills: every skill by name, the always-on ones only listed (not pickable), Manage and Browse linking to Customize', () => {
  const html = render({ initialOpen: 'skills' });
  for (const skill of builder.skills) assert.ok(html.includes(esc(skill.name)), skill.name);
  assert.ok(html.includes('Always on'));
  const pickable = builder.skills.filter((s) => !s.always).length;
  assert.equal((html.match(/class="ax-menu__item ax-skillitem"[^>]*title/g) || []).length >= pickable, true);
  assert.ok(html.includes('href="/customize?project=pm&amp;tab=skills"') && html.includes('Manage skills'));
  assert.ok(html.includes('href="/customize?project=pm&amp;tab=skills&amp;scope=discover"') && html.includes('Browse skills'));
});

check('Connectors: one switch each, the sample marked, and Manage and Add linking to the Connectors tab', () => {
  const html = render({ initialOpen: 'connectors', off: ['stock'] });
  assert.equal((html.match(/role="menuitemcheckbox"/g) || []).length, 2);
  assert.equal((html.match(/aria-checked="false"/g) || []).length, 1);
  assert.ok(html.includes('Sample data'));
  assert.ok(html.includes('href="/customize?project=pm&amp;tab=connectors"') && html.includes('Manage connectors'));
  assert.ok(html.includes('href="/customize?project=pm&amp;tab=connectors&amp;scope=discover"') && html.includes('Add connector'));
});

check('Plugins: each plugin with what it brings, and Manage and Browse linking to the Plugins tab', () => {
  const html = render({ initialOpen: 'plugins' });
  assert.ok(html.includes('Customer service') && html.includes('Trade desk'));
  assert.ok(html.includes('1 agent'), 'what a plugin brings is said');
  assert.ok(html.includes('href="/customize?project=pm&amp;tab=plugins"') && html.includes('Manage plugins') && html.includes('Browse plugins'));
});

check('a list with nothing in it says so instead of showing an empty box', () => {
  assert.ok(render({ initialOpen: 'connectors', connectors: [] }).includes('No connected systems yet.'));
  assert.ok(render({ initialOpen: 'skills', model: { showLists: true, skills: [], plugins: [] } }).includes('The assistant has no skills yet.'));
  assert.ok(render({ initialOpen: 'plugins', model: { showLists: true, skills: [], plugins: [] } }).includes('The assistant has no plugins yet.'));
});

console.log(`✅ web: + menu: ${passed} passed, 0 failed`);
