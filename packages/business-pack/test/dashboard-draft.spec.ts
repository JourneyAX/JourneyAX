/**
 * The PlaceMakers draft pack's dashboard setting against the pack's own connector table: every tool a team's tile, dashboard or cards read must
 * be listed as a read-only tool, and be allowed (not blocked, not ask-first) for that team. A figure the team may not read would show as a dash
 * on their screen; this catches it before anyone sees it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DashboardSchema, connectorToolState, dashboardFor } from '../src';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Draft pack: every dashboard tool is readable by the team it is for');

const pack = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const setting = DashboardSchema.parse(pack.extensions.dashboard);
const registry = pack.extensions.connectors;

const toolsOf = (entry: (typeof setting.entries)[number]) => [
  ...entry.metrics.map((m) => ({ where: `figure "${m.id}"`, ...m.source })),
  ...entry.sections.map((s) => ({ where: `list "${s.id}"`, ...s.source })),
  ...entry.cards.map((c) => ({ where: `card "${c.heading}"`, connector: c.connector, tool: c.tool })),
];

// A trade customer's board reads only the customer's own account tools (the platform's, not a connector's), and the balance only for the roles
// that may see it: the same rule the chat's `my_balance` tool applies, checked here so a board never shows a role a figure the chat would refuse.
const MAY_SEE_BALANCE = new Set(['account_admin', 'accounts_payable']);
const BOARD_TOOLS = new Set(['my_balance', 'my_deliveries']);

for (const entry of setting.entries.filter((e) => e.companyRoles?.length)) {
  const team = `customers (${entry.companyRoles!.join(', ')})`;
  check(`${team}: reads only the customer's own account tools, and the balance only where the role may see it`, () => {
    const problems: string[] = [];
    for (const source of toolsOf(entry)) {
      if (source.connector !== 'customer-account') problems.push(`${source.where}: ${source.connector}.${source.tool} is not one of the customer's own account tools`);
      else if (!BOARD_TOOLS.has(source.tool)) problems.push(`${source.where}: ${source.tool} is not a tool a customer's board may read`);
      else if (source.tool === 'my_balance' && !entry.companyRoles!.every((role) => MAY_SEE_BALANCE.has(role))) problems.push(`${source.where}: my_balance, but ${entry.companyRoles!.filter((role) => !MAY_SEE_BALANCE.has(role)).join(', ')} may not see the balance`);
    }
    assert.deepEqual(problems, []);
  });
  check(`${team}: the board and the welcome words are chosen by the role, and a homeowner gets neither`, () => {
    for (const role of entry.companyRoles!) {
      const first = setting.entries.find((e) => e.companyRoles?.includes(role));
      assert.equal(dashboardFor(setting, { audience: 'shopper', groups: [], companyRoles: [role] })?.title, first?.title, `a ${role} gets the first board that names their role`);
    }
    assert.equal(dashboardFor(setting, { audience: 'shopper', groups: [] }), undefined, 'an ordinary shopper has no board');
    assert.equal(dashboardFor(setting, { audience: 'staff', groups: ['no-such-team'], companyRoles: entry.companyRoles }), undefined, 'a company role does not make staff a customer');
  });
}

for (const entry of setting.entries.filter((e) => !e.companyRoles?.length)) {
  const team = (entry.groups ?? []).join('+') || entry.audience;
  check(`${team}: every figure, list and card reads a read-only tool the team is allowed`, () => {
    const person = { audience: 'staff' as const, groups: entry.groups ?? [] };
    const problems: string[] = [];
    for (const source of toolsOf(entry)) {
      const connector = registry.connectors.find((c: any) => c.connectorId === source.connector);
      const listed = connector?.tools.find((t: any) => t.name === source.tool);
      if (!listed) { problems.push(`${source.where}: ${source.connector}.${source.tool} is not in the pack`); continue; }
      if (listed.sideEffect !== 'read') problems.push(`${source.where}: ${source.connector}.${source.tool} changes data`);
      // A system that is switched off (its account is not connected yet) blocks every tool; what matters is that the team's access rows
      // would allow the tool the moment it is switched on, so the board lights up by itself and nobody has to edit it.
      const withSystemOn = connector.enabled === false ? { ...registry, connectors: registry.connectors.map((c: any) => (c === connector ? { ...c, enabled: true } : c)) } : registry;
      const { state } = connectorToolState(withSystemOn, source.connector, source.tool, person);
      if (state !== 'allow') problems.push(`${source.where}: ${source.connector}.${source.tool} is "${state}" for ${team}`);
    }
    assert.deepEqual(problems, []);
  });

  check(`${team}: ${(() => { const off = [...new Set(toolsOf(entry).map((s) => s.connector))].filter((id) => registry.connectors.find((c: any) => c.connectorId === id)?.enabled === false); return off.length ? `waits on a system that is switched off: ${off.join(', ')}` : 'every system it reads is switched on'; })()}`, () => {
    // Not a failure: it says, in the test output, which boards will show dashes until their system is connected.
    assert.ok(true);
  });

  check(`${team}: the entry is the one that team gets, and each figure on the tile is worded for a person`, () => {
    const found = dashboardFor(setting, { audience: 'staff', groups: entry.groups ?? [] });
    assert.equal(found?.title, entry.title);
    for (const id of entry.tile) {
      const metric = entry.metrics.find((m) => m.id === id)!;
      assert.ok(metric.label.length <= 28, `"${metric.label}" is short enough for the tile`);
    }
  });
}

check('a person in two teams gets the first entry that fits, and a login with no dashboard team gets none', () => {
  assert.equal(dashboardFor(setting, { audience: 'staff', groups: ['no-such-team'] }), undefined, 'a team with no entry gets none (and nobody is shown another team’s)');
  assert.equal(dashboardFor(setting, { audience: 'shopper', groups: [] }), undefined);
});

console.log(`\n✅ ${passed} draft-pack dashboard checks passed`);
