import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRealConnectors } from '../src/index';
import { suite } from './helpers';

/**
 * The pack and the real servers must agree on what each connector can do. The pack decides who may use which tool and which tools ask
 * first; the server decides what the tool does. If they drift apart, a tool could change data with no ask-first card, or the pack could
 * promise a tool the server does not have. The sample connectors are checked against the same pack by packages/connectors-sample.
 */
const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const registry = new Map<string, any>(draft.extensions.connectors.connectors.map((entry: any) => [entry.connectorId, entry]));
const connectors = createRealConnectors({});

const t = suite('connectors-real: the pack and the real servers agree');

async function main() {
  await t.test('every real connector is in the pack, marked real (not sample), switched on, and signs in with the real connectors\' key', () => {
    for (const connector of connectors) {
      const entry = registry.get(connector.connectorId);
      assert.ok(entry, `${connector.connectorId} is in the pack`);
      assert.equal(entry.sample, false, `${connector.connectorId} is not marked sample`);
      assert.equal(entry.enabled, true, `${connector.connectorId} is switched on`);
      assert.equal(entry.secretRef, 'tenant-secret://placemakers/production/real-connectors-key', `${connector.connectorId} uses the real connectors' key`);
      assert.ok(!/sample/i.test(entry.displayName), `${connector.connectorId} is not named "(sample)"`);
    }
  });

  await t.test('every tool a real server offers is a tool the pack lists, and it changes data only where the pack says it does', () => {
    for (const connector of connectors) {
      const listed = new Map<string, any>(registry.get(connector.connectorId).tools.map((tool: any) => [tool.name, tool]));
      for (const tool of connector.tools) {
        const entry = listed.get(tool.name);
        assert.ok(entry, `${connector.connectorId}.${tool.name} is listed in the pack (otherwise the assistant could never use it)`);
        assert.equal(tool.readOnly, (entry.sideEffect ?? 'read') === 'read', `${connector.connectorId}.${tool.name}: the server and the pack agree on whether it changes data`);
      }
    }
  });

  await t.test('every tool the pack lists for a real connector is offered by its server, so no rule is written for a tool that does not exist', () => {
    for (const connector of connectors) {
      const offered = new Set(connector.tools.map((tool) => tool.name));
      for (const tool of registry.get(connector.connectorId).tools) assert.ok(offered.has(tool.name), `${connector.connectorId}.${tool.name} is offered by the real server`);
    }
  });

  await t.test('tool definitions are well formed: an object schema, required fields that exist, and a plain-words description', () => {
    for (const connector of connectors) {
      for (const tool of connector.tools) {
        assert.equal(tool.inputSchema.type, 'object', tool.name);
        const properties = Object.keys(tool.inputSchema.properties ?? {});
        for (const name of tool.inputSchema.required ?? []) assert.ok(properties.includes(name), `${connector.connectorId}.${tool.name} requires ${name}, which it does not define`);
        assert.ok(tool.description.length > 20 && tool.description.length < 400, `${tool.name} has a short description`);
        for (const [name, spec] of Object.entries<any>(tool.inputSchema.properties ?? {})) assert.ok(spec.type, `${tool.name}.${name} has a type`);
      }
    }
  });

  await t.test('a tool that returns money or product facts names the claim class that lets the reply state them', () => {
    // The claim guard withholds figures nothing backs. A real tool that returns prices, balances or orders must declare it.
    const mustDeclare: Record<string, string[]> = {
      commercetools: ['find_product', 'get_product', 'get_cart', 'get_order', 'order_history'],
      'power-bi': ['get_report_figures', 'report_totals'],
    };
    for (const [connectorId, tools] of Object.entries(mustDeclare)) {
      const listed = new Map<string, any>(registry.get(connectorId).tools.map((tool: any) => [tool.name, tool]));
      for (const name of tools) assert.ok((listed.get(name)?.claimClasses ?? []).includes('catalog_fact'), `${connectorId}.${name} declares catalog_fact`);
    }
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
