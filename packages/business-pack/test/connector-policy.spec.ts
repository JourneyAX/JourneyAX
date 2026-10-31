import assert from 'node:assert/strict';
import { principalFrom } from '@journeyax/shared-types';
import {
  BusinessPackContentSchema,
  ConnectorsSchema,
  connectorToolState,
  resolveConnectorPolicy,
  usableConnectors,
  validateBusinessPack,
  type ConnectorsExtension,
} from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Connector registry (pack extensions.connectors) and resolveConnectorPolicy');

const registry = ConnectorsSchema.parse({
  connectors: [
    {
      connectorId: 'stock-system',
      displayName: 'Stock system',
      description: 'Stock by branch and delivery status.',
      owner: 'Supply chain',
      secretRef: 'tenant-secret://acme/dev/stock-key',
      sample: true,
      tools: [{ name: 'stock_by_branch' }, { name: 'delivery_status' }, { name: 'reserve_stock', sideEffect: 'write' }],
    },
    {
      connectorId: 'crm',
      displayName: 'CRM',
      description: 'Accounts and cases.',
      owner: 'Sales ops',
      tools: [{ name: 'find_account' }, { name: 'create_case', sideEffect: 'write' }],
    },
    {
      connectorId: 'switched-off',
      displayName: 'Switched off',
      description: 'Not in use.',
      owner: 'Nobody',
      enabled: false,
      tools: [{ name: 'anything' }],
    },
  ],
  policy: [
    { connectorId: 'stock-system', tool: '*', audience: 'shopper', state: 'allow' },
    { connectorId: 'stock-system', tool: 'delivery_status', audience: 'shopper', state: 'blocked' },
    { connectorId: 'stock-system', tool: 'reserve_stock', audience: 'staff', groups: ['sales'], state: 'ask' },
    { connectorId: 'crm', tool: '*', audience: 'staff', groups: [], state: 'allow' },
    { connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: ['customer-service'], state: 'ask' },
    { connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: ['sales'], state: 'blocked' },
    { connectorId: 'switched-off', tool: '*', audience: 'shopper', state: 'allow' },
  ],
});
const person = (role: string, groups: string[] = []) => principalFrom({ userId: `${role}@x.test`, role, groups });
const states = (extension: ConnectorsExtension, who: ReturnType<typeof person>, connectorId: string) =>
  Object.fromEntries(resolveConnectorPolicy(extension, who).find((c) => c.connectorId === connectorId)!.tools.map((t) => [t.name, t.state]));

check('the table parses; omitted fields take their documented defaults', () => {
  const stock = registry.connectors[0];
  assert.equal(stock.connectionScope, 'shop');
  assert.equal(stock.enabled, true);
  assert.equal(stock.tools[0].sideEffect, 'read');
  assert.deepEqual(registry.policy[0].groups, []);
});

check('anything outside the shape is refused: raw keys, unknown fields and states, odd ids, shopper rows are fine but other audiences are not', () => {
  const base = registry.connectors[1];
  const bad = (connector: Record<string, unknown>) => ConnectorsSchema.safeParse({ connectors: [{ ...base, ...connector }], policy: [] }).success;
  assert.equal(bad({}), true);
  assert.equal(bad({ secretRef: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' }), false, 'a raw key is not a reference');
  assert.equal(bad({ secretRef: 'https://example.test/key' }), false);
  assert.equal(bad({ secretRef: 'tenant-secret://acme/dev/key' }), true);
  assert.equal(bad({ extra: 1 }), false);
  assert.equal(bad({ connectorId: 'Has Spaces' }), false);
  assert.equal(bad({ tools: [] }), false, 'a connector with no tools is refused');
  assert.equal(bad({ tools: [{ name: 'bad name' }] }), false);
  assert.equal(bad({ connectionScope: 'everyone' }), false);
  const row = (extra: Record<string, unknown>) => ConnectorsSchema.safeParse({ connectors: [base], policy: [{ connectorId: 'crm', tool: '*', audience: 'staff', state: 'allow', ...extra }] }).success;
  assert.equal(row({}), true);
  assert.equal(row({ state: 'maybe' }), false);
  assert.equal(row({ audience: 'customer' }), false);
  assert.equal(row({ groups: ['Customer Service'] }), false);
  assert.equal(row({ tool: 'bad tool' }), false);
  assert.equal(ConnectorsSchema.safeParse({ connectors: [], policy: [], extra: true }).success, false);
});

check('the pack accepts the registry under extensions and still accepts a pack without it', () => {
  const shape = (BusinessPackContentSchema as any).shape?.extensions;
  assert.ok(shape);
  assert.equal(shape.safeParse({ connectors: registry }).success, true);
  assert.equal(shape.safeParse({}).success, true);
  assert.equal(shape.safeParse({ connectors: { connectors: [{ connectorId: 'x' }] } }).success, false);
});

check('a pack without the table has no connectors for anyone', () => {
  assert.deepEqual(resolveConnectorPolicy(undefined, person('customer')), []);
  assert.deepEqual(usableConnectors(undefined, person('manager', ['sales'])), []);
  assert.equal(connectorToolState(undefined, 'crm', 'find_account', person('manager')).state, 'blocked');
});

check('a shopper gets the shopper rows, the connector default covers tools without their own row, and a named row beats the default', () => {
  const shopper = person('customer');
  assert.deepEqual(states(registry, shopper, 'stock-system'), { stock_by_branch: 'allow', delivery_status: 'blocked', reserve_stock: 'allow' });
});

check('new tools start blocked: a tool the pack does not list, an unknown connector, and a person no row reaches', () => {
  const shopper = person('customer');
  assert.deepEqual(connectorToolState(registry, 'stock-system', 'brand_new_tool', shopper), { state: 'blocked', known: false, via: 'none' });
  assert.equal(connectorToolState(registry, 'no-such-connector', 'x', shopper).state, 'blocked');
  assert.deepEqual(states(registry, shopper, 'crm'), { find_account: 'blocked', create_case: 'blocked' }, 'staff-only rows do not reach a shopper');
  assert.equal(connectorToolState(registry, 'crm', 'find_account', person('manager', ['sales'])).state, 'allow');
});

check('staff rows apply to the groups they name; none named means all staff', () => {
  assert.equal(states(registry, person('manager', ['sales']), 'stock-system').reserve_stock, 'ask', 'the sales row says ask, the shopper default says allow: the named staff row wins for staff in sales');
  assert.equal(states(registry, person('manager', ['finance']), 'stock-system').reserve_stock, 'allow', 'a group no row names gets the shopper default');
  assert.equal(states(registry, person('operator'), 'crm').find_account, 'allow');
});

check('strictest wins when several rows apply to one person', () => {
  const both = person('operator', ['customer-service', 'sales']);
  assert.equal(states(registry, both, 'crm').create_case, 'blocked', 'ask (customer-service) and blocked (sales) give blocked');
  assert.equal(states(registry, person('operator', ['customer-service']), 'crm').create_case, 'ask');
  assert.equal(states(registry, person('operator', ['sales']), 'crm').create_case, 'blocked');
  const sameLevel: ConnectorsExtension = ConnectorsSchema.parse({
    connectors: [registry.connectors[1]],
    policy: [
      { connectorId: 'crm', tool: '*', audience: 'staff', groups: ['a'], state: 'allow' },
      { connectorId: 'crm', tool: '*', audience: 'staff', groups: ['b'], state: 'ask' },
    ],
  });
  assert.equal(connectorToolState(sameLevel, 'crm', 'find_account', person('operator', ['a', 'b'])).state, 'ask');
  assert.equal(connectorToolState(sameLevel, 'crm', 'find_account', person('operator', ['a'])).state, 'allow');
});

check('a disabled connector is blocked for everyone, and only connectors with a tool that is allow or ask are usable', () => {
  assert.deepEqual(states(registry, person('customer'), 'switched-off'), { anything: 'blocked' });
  assert.deepEqual(usableConnectors(registry, person('customer')).map((c) => c.connectorId), ['stock-system']);
  assert.deepEqual(usableConnectors(registry, person('operator', ['sales'])).map((c) => c.connectorId), ['stock-system', 'crm']);
  assert.equal(resolveConnectorPolicy(registry, person('customer')).find((c) => c.connectorId === 'crm')!.usable, false);
});

check('the answer carries what the model and the admin need: server name, sample flag, side effect', () => {
  const stock = resolveConnectorPolicy(registry, person('customer')).find((c) => c.connectorId === 'stock-system')!;
  assert.equal(stock.mcpServerName, 'stock-system');
  assert.equal(stock.sample, true);
  assert.equal(stock.tools.find((t) => t.name === 'reserve_stock')!.sideEffect, 'write');
});

check('a stored table that has not been through the schema works: a missing enabled means enabled, missing groups means all, missing sideEffect means read', () => {
  const stored = {
    connectors: [{ connectorId: 'crm', displayName: 'CRM', description: 'Accounts.', owner: 'x', tools: [{ name: 'find_account' }, { name: 'create_case', sideEffect: 'write' }] }],
    policy: [{ connectorId: 'crm', tool: '*', audience: 'staff', state: 'allow' }],
  } as unknown as ConnectorsExtension;
  const crm = resolveConnectorPolicy(stored, person('operator', ['sales']))[0];
  assert.equal(crm.usable, true);
  assert.deepEqual(crm.tools.map((t) => [t.name, t.sideEffect, t.state]), [['find_account', 'read', 'allow'], ['create_case', 'write', 'allow']]);
  assert.equal(crm.sample, false);
  assert.equal(resolveConnectorPolicy(stored, person('customer'))[0].usable, false);
});

// The publication gate (validateBusinessPack, section 4f)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function issuesFor(extension: unknown, manifest: Record<string, unknown> = {}) {
  const pack: any = clone(rawLegacyFixture);
  pack.manifest = { ...pack.manifest, tenantId: 'acme', environmentId: 'dev', ...manifest };
  pack.extensions = { ...(pack.extensions || {}), connectors: extension };
  return validateBusinessPack(pack).issues.filter((issue) => issue.path.startsWith('extensions.connectors'));
}

check('the publication gate is quiet for a sound registry', () => {
  assert.deepEqual(issuesFor(clone(registry)).filter((i) => i.severity === 'error'), []);
});

check('the gate refuses a row that names a connector or a tool the pack does not list, a shopper row with groups, a doubled connector and a doubled tool', () => {
  const broken = clone(registry);
  broken.policy.push({ connectorId: 'ghost', tool: '*', audience: 'staff', groups: [], state: 'allow' });
  broken.policy.push({ connectorId: 'crm', tool: 'not_a_tool', audience: 'staff', groups: [], state: 'allow' });
  broken.policy.push({ connectorId: 'crm', tool: '*', audience: 'shopper', groups: ['sales'], state: 'ask' });
  broken.connectors.push(clone(broken.connectors[1]));
  broken.connectors[1].tools.push({ name: 'find_account', sideEffect: 'read' });
  const errors = issuesFor(broken).filter((i) => i.severity === 'error').map((i) => i.message);
  assert.ok(errors.some((m) => m.includes("connector 'ghost'")), errors.join(' | '));
  assert.ok(errors.some((m) => m.includes("tool 'not_a_tool'")));
  assert.ok(errors.some((m) => m.includes('names groups')));
  assert.ok(errors.some((m) => m.includes('declared twice')));
  assert.ok(errors.some((m) => m.includes('same tool twice')));
});

check("the gate refuses a secret reference that names another tenant or environment", () => {
  const other = clone(registry);
  other.connectors[0].secretRef = 'tenant-secret://someone-else/dev/stock-key';
  assert.ok(issuesFor(other).some((i) => i.severity === 'error' && /Cross-tenant/.test(i.message)));
  const wrongEnv = clone(registry);
  wrongEnv.connectors[0].secretRef = 'tenant-secret://acme/production/stock-key';
  assert.ok(issuesFor(wrongEnv).some((i) => i.severity === 'error' && /Cross-environment/.test(i.message)));
});

check('the gate warns, without refusing, about a write tool set to allow, a connector nobody can use and sample data in a production pack', () => {
  const loose = clone(registry);
  loose.policy.push({ connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: ['finance'], state: 'allow' });
  loose.connectors.push({ connectorId: 'orphan', displayName: 'Orphan', description: 'No rows.', owner: 'x', connectionScope: 'shop', sample: false, enabled: true, tools: [{ name: 'a', sideEffect: 'read' }] } as any);
  const issues = issuesFor(loose, { environmentId: 'production', tenantId: 'acme' });
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  assert.ok(warnings.some((m) => m.includes('create_case') && m.includes('without asking first')), warnings.join(' | '));
  assert.ok(warnings.some((m) => m.includes("'orphan'") && m.includes('new tools start blocked')));
  assert.ok(warnings.some((m) => m.includes('sample data but this pack is for production')));
});

check('a default row set to allow does not warn about a write tool that has its own row', () => {
  const covered = clone(registry);
  covered.policy = [
    { connectorId: 'crm', tool: '*', audience: 'staff', groups: [], state: 'allow' },
    { connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: [], state: 'ask' },
  ];
  covered.connectors = [covered.connectors[1]];
  assert.deepEqual(issuesFor(covered).filter((i) => i.message.includes('without asking first')), []);
  covered.policy.pop();
  assert.equal(issuesFor(covered).filter((i) => i.message.includes('create_case') && i.message.includes('without asking first')).length, 1, 'with no row of its own the default row does cover it');
});

check('a pack without the registry is not touched by the gate', () => {
  const pack: any = clone(rawLegacyFixture);
  assert.deepEqual(validateBusinessPack(pack).issues.filter((i) => i.path.startsWith('extensions.connectors')), []);
});

console.log(`✅ connector registry: ${passed} passed, 0 failed`);
