import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import { BusinessPackContentSchema, PluginsSchema, pluginGate, resolvePlugins, type PluginsExtension } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Plugins (pack extensions.plugins): one switch for a bundle of agents, skills, forms, connectors and tools');

const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });
const ext: PluginsExtension = PluginsSchema.parse({
  plugins: [
    { pluginId: 'customer-service', name: 'Customer service', description: 'Orders, deliveries and getting in touch.', provides: { agents: ['service-agent'], forms: ['contact-us'], connectors: ['crm'], skills: ['order-help'] } },
    { pluginId: 'pictures', name: 'Pictures of the finished job', description: 'Shows what the finished job could look like.', provides: { skills: ['show-the-job'], tools: ['generate_visual'] } },
    { pluginId: 'insights', name: 'Insights', description: 'Reports for staff.', provides: { connectors: ['power-bi'] } },
  ],
  access: [
    { pluginId: 'customer-service', audience: 'shopper', level: 'available' },
    { pluginId: 'customer-service', audience: 'staff', groups: ['customer-service'], level: 'default' },
    { pluginId: 'insights', audience: 'staff', groups: ['analytics'], level: 'available' },
  ],
});

check('a table parses; anything outside the shape is refused', () => {
  assert.equal(PluginsSchema.safeParse(ext).success, true);
  const bad = (change: (e: any) => void) => { const copy = JSON.parse(JSON.stringify(ext)); change(copy); return PluginsSchema.safeParse(copy).success; };
  assert.equal(bad(() => {}), true);
  assert.equal(bad((e) => { e.plugins[0].pluginId = 'Customer Service'; }), false);
  assert.equal(bad((e) => { e.plugins[0].extra = 1; }), false);
  assert.equal(bad((e) => { e.plugins[0].provides.widgets = ['x']; }), false, 'only the known kinds of thing');
  assert.equal(bad((e) => { e.access[0].level = 'owner'; }), false);
  assert.equal(bad((e) => { e.access[1].groups = ['Customer Service']; }), false);
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.equal(shape.safeParse({ plugins: ext }).success, true);
  assert.equal(shape.safeParse({}).success, true);
});

check('a plugin with no access row is available to everyone; with rows, only to those a row covers', () => {
  const shopper = resolvePlugins(ext, person('customer'));
  assert.deepEqual(shopper.map((v) => `${v.plugin.pluginId}:${v.available}:${v.level}`), ['customer-service:true:available', 'pictures:true:null', 'insights:false:null']);
  const rep = resolvePlugins(ext, person('operator', ['customer-service']));
  assert.deepEqual(rep.map((v) => `${v.plugin.pluginId}:${v.available}:${v.level}`), ['customer-service:true:default', 'pictures:true:null', 'insights:false:null']);
  const analyst = resolvePlugins(ext, person('analyst', ['analytics']));
  assert.deepEqual(analyst.map((v) => `${v.plugin.pluginId}:${v.available}`), ['customer-service:true', 'pictures:true', 'insights:true']);
});

check('a thing no plugin names is never governed; a thing a plugin names is theirs only with that plugin', () => {
  const shopper = pluginGate(ext, person('customer'));
  assert.equal(shopper.allows('agents', 'some-unnamed-agent'), true);
  assert.equal(shopper.allows('connectors', 'crm'), true, 'the customer-service plugin is available to shoppers');
  assert.equal(shopper.allows('connectors', 'power-bi'), false, 'the insights plugin is for the analytics group');
  assert.deepEqual([...shopper.hidden('connectors')], ['power-bi']);
  assert.equal(pluginGate(ext, person('analyst', ['analytics'])).allows('connectors', 'power-bi'), true);
  assert.equal(pluginGate(ext, person('customer', [])).allows('forms', 'contact-us'), true);
});

check('a thing two plugins name is theirs if either plugin is', () => {
  const two = PluginsSchema.parse({
    plugins: [
      { pluginId: 'a', name: 'A', description: 'a', provides: { skills: ['shared'] } },
      { pluginId: 'b', name: 'B', description: 'b', provides: { skills: ['shared'] } },
    ],
    access: [{ pluginId: 'a', audience: 'staff', groups: ['x'], level: 'available' }, { pluginId: 'b', audience: 'staff', groups: ['y'], level: 'available' }],
  });
  assert.equal(pluginGate(two, person('manager', ['x'])).allows('skills', 'shared'), true);
  assert.equal(pluginGate(two, person('manager', ['y'])).allows('skills', 'shared'), true);
  assert.equal(pluginGate(two, person('manager', ['z'])).allows('skills', 'shared'), false);
  assert.equal(pluginGate(two, person('customer')).allows('skills', 'shared'), false);
});

check('default and required install the plugin: its skills are always on and its agent opens; available does not', () => {
  const rep = pluginGate(ext, person('operator', ['customer-service']));
  assert.equal(rep.installs('skills', 'order-help'), true);
  assert.equal(rep.installs('agents', 'service-agent'), true);
  const shopper = pluginGate(ext, person('customer'));
  assert.equal(shopper.installs('skills', 'order-help'), false);
  assert.equal(shopper.installs('agents', 'service-agent'), false);
});

check('a shopper who carries a staff group in their login is still a shopper', () => {
  const claimed = pluginGate(ext, principalFrom({ userId: 'x@y.test', role: 'customer', groups: ['analytics'] }));
  assert.equal(claimed.allows('connectors', 'power-bi'), false);
});

check('with no plugins nothing is governed', () => {
  for (const none of [undefined, { plugins: [], access: [] } as PluginsExtension]) {
    const gate = pluginGate(none, person('customer'));
    assert.equal(gate.active, false);
    assert.equal(gate.allows('agents', 'anything'), true);
    assert.equal(gate.installs('skills', 'anything'), false);
    assert.deepEqual([...gate.hidden('tools')], []);
  }
});

console.log(`✅ plugins: ${passed} passed, 0 failed`);
