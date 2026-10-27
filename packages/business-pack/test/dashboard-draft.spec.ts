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

for (const entry of setting.entries) {
  const team = (entry.groups ?? []).join('+') || entry.audience;
  check(`${team}: every figure, list and card reads a read-only tool the team is allowed`, () => {
    const person = { audience: 'staff' as const, groups: entry.groups ?? [] };
    const problems: string[] = [];
    for (const source of toolsOf(entry)) {
      const connector = registry.connectors.find((c: any) => c.connectorId === source.connector);
      const listed = connector?.tools.find((t: any) => t.name === source.tool);
      if (!listed) { problems.push(`${source.where}: ${source.connector}.${source.tool} is not in the pack`); continue; }
      if (listed.sideEffect !== 'read') problems.push(`${source.where}: ${source.connector}.${source.tool} changes data`);
      const { state } = connectorToolState(registry, source.connector, source.tool, person);
      if (state !== 'allow') problems.push(`${source.where}: ${source.connector}.${source.tool} is "${state}" for ${team}`);
    }
    assert.deepEqual(problems, []);
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
  assert.equal(dashboardFor(setting, { audience: 'staff', groups: ['finance'] }), undefined);
  assert.equal(dashboardFor(setting, { audience: 'shopper', groups: [] }), undefined);
});

console.log(`\n✅ ${passed} draft-pack dashboard checks passed`);
