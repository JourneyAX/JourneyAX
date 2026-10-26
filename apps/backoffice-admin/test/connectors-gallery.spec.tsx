import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Connectors } from '../src/components/Connectors';
import { describeAssistantSystem, readAssistantSystems } from '../src/lib/assistantSystems';

/**
 * The back office's Connectors gallery no longer claims what is not true: the platform's own adapters keep their honest badges, and the
 * systems the assistant itself reaches are read from the project, with their switch.
 *   npx tsx --tsconfig apps/backoffice-admin/test/tsconfig.render.json apps/backoffice-admin/test/connectors-gallery.spec.tsx
 */
let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${passed}. ${name}`); }

const root = path.resolve(__dirname, '../../..');
const draft = JSON.parse(readFileSync(path.join(root, 'docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const project = { extensions: draft.extensions } as any;
const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(Connectors as any, props));

console.log('🧪 backoffice: connectors gallery');

check('the project\'s connected systems are read as they are saved: name, switch, sample or real, tools, and how many change data', () => {
  const systems = readAssistantSystems(project);
  assert.equal(systems.length, draft.extensions.connectors.connectors.length);
  const salesforce = systems.find((s) => s.id === 'salesforce')!;
  assert.deepEqual({ name: salesforce.name, enabled: salesforce.enabled, sample: salesforce.sample, tools: salesforce.tools, writes: salesforce.writes }, { name: 'Salesforce', enabled: true, sample: false, tools: 11, writes: 1 });
  assert.equal(systems.find((s) => s.id === 'zendesk')!.enabled, true);
  assert.equal(systems.find((s) => s.id === 'marketing-cloud')!.sample, true);
  assert.deepEqual(readAssistantSystems(null), []);
  assert.deepEqual(readAssistantSystems({ extensions: { connectors: { connectors: [null, { connectorId: '' }, { connectorId: 'a' }, { connectorId: 'a' }] } } }), [{ id: 'a', name: 'a', enabled: true, sample: false, tools: 0, writes: 0 }]);
  assert.match(describeAssistantSystem(salesforce), /reaches this system directly \(real data, 11 tools, 1 that changes data and ask first\)/);
  assert.match(describeAssistantSystem({ ...salesforce, enabled: false }), /switched off/);
  assert.match(describeAssistantSystem(undefined), /does not reach/);
});

check('Salesforce, which the platform has no working adapter for, is live for the assistant when the project has it switched on, and says why', () => {
  const html = render({ project });
  assert.ok(html.includes('Live for the assistant'));
  assert.ok(html.includes('The assistant reaches this system directly (real data, 11 tools'));
  assert.ok(html.includes('The platform&#x27;s own CRM adapter is scaffolded') || html.includes("The platform's own CRM adapter is scaffolded"));
});

check('with the system switched off the card goes back to its honest adapter badge, and without a project nothing about the assistant is claimed', () => {
  const off = JSON.parse(JSON.stringify(draft.extensions)); off.connectors.connectors.find((c: any) => c.connectorId === 'salesforce').enabled = false;
  const html = render({ project: { extensions: off } });
  assert.ok(!html.includes('Live for the assistant'));
  assert.ok(html.includes('Coming soon'));
  assert.ok(html.includes('switched off'));
  const bare = render({});
  assert.ok(!bare.includes('Live for the assistant'));
  assert.ok(!bare.includes('The assistant reaches this system directly') && !bare.includes('The assistant does not reach'));
  assert.ok(bare.includes('lists no connected systems'));
});

check('every connected system is listed under the grid with its switch, and the page points to where the rules are changed', () => {
  const html = render({ project });
  assert.ok(html.includes('Systems your assistant reaches'));
  for (const system of readAssistantSystems(project)) assert.ok(html.includes(system.name.replace(/&/g, '&amp;')), system.name);
  assert.ok(html.includes('Switched off') && html.includes('Sample data') && html.includes('Real data'));
  assert.ok(html.includes('Customize page, under Connectors'));
  assert.ok(render({ project: { extensions: {} } }).includes('lists no connected systems'));
});

check('the platform adapters that really are not built still say so', () => {
  const html = render({ project });
  assert.ok(html.includes('Not yet built'));
  assert.ok(html.includes('Adapter scaffolded, methods not yet implemented.'), 'Shopify is still a stub');
});

console.log(`\n${passed} passed`);
