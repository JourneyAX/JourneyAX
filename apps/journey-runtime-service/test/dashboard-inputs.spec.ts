import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRealConnectors } from '../../../packages/connectors-real/src/index';

/**
 * The connector servers refuse an input a tool does not declare. The pack's boards and cards call connector tools with inputs written in the
 * pack, so a board that passes an input its tool does not have would show "could not be read". This ties the two together: every call the draft
 * pack's dashboard makes uses only inputs the real or sample tool declares. (The live pack is checked the same way before it is published.)
 */
const ROOT = path.resolve(__dirname, '../../..');
const draft = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/agent-instructions/placemakers-draft.json'), 'utf8'));

function declaredInputs(): Map<string, Set<string>> {
  const schemas = new Map<string, Set<string>>();
  for (const connector of createRealConnectors({} as any)) for (const tool of connector.tools) schemas.set(`${connector.connectorId}.${tool.name}`, new Set(Object.keys((tool.inputSchema as any)?.properties ?? {})));
  const dir = path.join(ROOT, 'packages/connectors-sample/connectors');
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'connector.json');
    if (!fs.existsSync(file)) continue;
    const connector = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const tool of connector.tools ?? []) schemas.set(`${connector.connectorId}.${tool.name}`, new Set(Object.keys(tool.inputSchema?.properties ?? {})));
  }
  return schemas;
}

describe('The pack\'s dashboard calls use only inputs the tools declare', () => {
  test('every metric and section source in the draft pack', () => {
    const schemas = declaredInputs();
    const problems: string[] = [];
    let checked = 0;
    for (const entry of draft.extensions?.dashboard?.entries ?? []) {
      const sources = [...(entry.metrics ?? []).map((m: any) => m.source), ...(entry.sections ?? []).map((s: any) => s.source)].filter((s: any) => s?.connector);
      for (const source of sources) {
        const declared = schemas.get(`${source.connector}.${source.tool}`);
        if (!declared) continue; // an internal tool (customer-account) or a vendor not listed here
        checked++;
        for (const arg of Object.keys(source.args ?? {})) if (!declared.has(arg)) problems.push(`${source.connector}.${source.tool} is given ${arg}, which it does not declare`);
      }
    }
    assert.ok(checked > 40, `only ${checked} calls were checked: the draft's dashboard or the schemas moved`);
    assert.deepEqual(problems, []);
  });
});
