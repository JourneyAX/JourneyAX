/**
 * Saving the rules of a connected system through a pretend project service, and reading the connector servers' health.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/customize/__tests__/connectorPublish.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConnectorsExtension } from '@journeyax/business-pack';
import { buildConnectorRules, connectorFingerprint } from '../connectorRules';
import { changeRules, readRulesOp } from '../connectorPublish';
import { readConnectorStatuses, statusUrlsFromEnv } from '../connectorStatus';

let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const draft = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../docs/agent-instructions/placemakers-draft.json'), 'utf8'));
const TEAMS = ['Customer Service', 'Sales', 'Branch', 'Finance'].map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name }));

function service(opts: { publish?: 'ok' | 'refuse' | 'down'; patch?: 'ok' | 'refuse' } = {}) {
  const doc: any = { projectId: 'placemakers', extensions: { connectors: JSON.parse(JSON.stringify(draft.extensions.connectors)), skills: [] } };
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const json = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload }) as any;
    if (method === 'GET') return json(200, JSON.parse(JSON.stringify(doc)));
    if (method === 'PATCH') {
      if (opts.patch === 'refuse') return json(400, { message: 'Invalid connectors: nope' });
      for (const [k, v] of Object.entries(body.extensions ?? {})) doc.extensions[k] = v;
      return json(200, { success: true });
    }
    if (opts.publish === 'down') throw new Error('socket hang up');
    return opts.publish === 'refuse' ? json(404, { message: 'Connector policy is inconsistent' }) : json(200, { success: true, version: '1.3.50' });
  }) as unknown as typeof fetch;
  return { doc, calls, deps: { base: 'http://project/api/v1/projects/placemakers', headers: { Authorization: 'Bearer t' }, fetchImpl } };
}
const baseOf = (s: ReturnType<typeof service>, id: string) => connectorFingerprint(s.doc.extensions.connectors as ConnectorsExtension, id)!;
const gridOf = (s: ReturnType<typeof service>, id: string) => buildConnectorRules(s.doc.extensions.connectors, TEAMS).find((v) => v.connectorId === id)!;

async function main() {
  console.log('saving the rules of a system');

  await check('a change is written as the connectors table alone, published with a note, and the page is told what it did', async () => {
    const s = service();
    const v = gridOf(s, 'salesforce');
    const out = await changeRules(s.deps, { connectorId: 'salesforce', base: baseOf(s, 'salesforce'), cells: { list_cases: { ...v.grid.list_cases, finance: 'blocked' } } });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, connectorId: 'salesforce', changes: { tools: ['list_cases'], cells: 1 }, warnings: [], version: '1.3.50' });
    const [read, patch, publish] = s.calls;
    assert.equal(read.method, 'GET');
    assert.deepEqual(Object.keys(patch.body), ['extensions']);
    assert.deepEqual(Object.keys(patch.body.extensions), ['connectors']);
    assert.match(publish.body.note, /^Salesforce: rules changed for 1 tool, from the Customize page$/);
    assert.equal(gridOf(s, 'salesforce').grid.list_cases.finance, 'blocked');
    assert.equal(s.calls.length, 3);
  });

  await check('switching a system on is a change of its own and says so in the note', async () => {
    const s = service();
    const out = await changeRules(s.deps, { connectorId: 'zendesk', base: baseOf(s, 'zendesk'), enabled: true });
    assert.equal(out.status, 200);
    assert.match(s.calls[2].body.note, /^Zendesk: switched on, from the Customize page$/);
    assert.equal(s.doc.extensions.connectors.connectors.find((c: any) => c.connectorId === 'zendesk').enabled, true);
  });

  await check('a system changed elsewhere since the page read it is not overwritten: 409, nothing written', async () => {
    const s = service();
    const out = await changeRules(s.deps, { connectorId: 'salesforce', base: 'stale-1', enabled: false });
    assert.equal(out.status, 409);
    assert.equal(out.body.conflict, true);
    assert.deepEqual(s.calls.map((c) => c.method), ['GET']);
  });

  await check('when the gate refuses the publish, the connectors table is put back exactly as it was', async () => {
    const s = service({ publish: 'refuse' });
    const before = JSON.parse(JSON.stringify(s.doc));
    const out = await changeRules(s.deps, { connectorId: 'commercetools', base: baseOf(s, 'commercetools'), enabled: false });
    assert.equal(out.status, 422);
    assert.match(out.body.error, /not published: Connector policy is inconsistent/);
    assert.deepEqual(s.doc, before);
    assert.deepEqual(s.calls.map((c) => c.method), ['GET', 'PATCH', 'POST', 'PATCH']);
  });

  await check('a publish that gets no answer is also undone, and a save the project refuses stops before publishing', async () => {
    const down = service({ publish: 'down' });
    const before = JSON.parse(JSON.stringify(down.doc));
    assert.equal((await changeRules(down.deps, { connectorId: 'commercetools', base: baseOf(down, 'commercetools'), enabled: false })).status, 502);
    assert.deepEqual(down.doc, before);
    const refused = service({ patch: 'refuse' });
    const out = await changeRules(refused.deps, { connectorId: 'commercetools', base: baseOf(refused, 'commercetools'), enabled: false });
    assert.equal(out.status, 422);
    assert.match(out.body.error, /rules could not be saved/);
    assert.ok(!refused.calls.some((c) => c.url.endsWith('/publish')));
  });

  await check('a change that does nothing, or that asks for a change-data tool to be allowed, is a 400 with the reason, and nothing is written', async () => {
    const s = service();
    const v = gridOf(s, 'salesforce');
    const none = await changeRules(s.deps, { connectorId: 'salesforce', base: baseOf(s, 'salesforce'), cells: { list_cases: v.grid.list_cases } });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Nothing was changed/);
    const write = await changeRules(s.deps, { connectorId: 'salesforce', base: baseOf(s, 'salesforce'), cells: { create_case: { ...v.grid.create_case, sales: 'allow' } } });
    assert.equal(write.status, 400);
    assert.match(write.body.error, /Ask first or Blocked/);
    assert.ok(s.calls.every((c) => c.method === 'GET'));
  });

  console.log('reading the request');

  await check('a body becomes an operation with its shapes checked, or says what is missing', () => {
    assert.deepEqual(readRulesOp({ connectorId: 'salesforce', base: 'f', enabled: true, cells: { list_cases: { sales: 'ask' } } }), { connectorId: 'salesforce', base: 'f', enabled: true, cells: { list_cases: { sales: 'ask' } } });
    for (const bad of [null, {}, { connectorId: 'x' }, { connectorId: 'x', base: 'f', cells: 'no' }, { connectorId: 'x', base: 'f', cells: { t: 'no' } }]) assert.ok('error' in (readRulesOp(bad) as object), JSON.stringify(bad));
    assert.equal((readRulesOp({ connectorId: 'x', base: 'f', enabled: 'yes' }) as any).enabled, undefined, 'only a real boolean switches a system');
  });

  console.log('reading the connector servers\' health');

  await check('each system is reported connected or not with the names (never values) of what it still needs; unreachable servers and odd names are ignored', async () => {
    const answers: Record<string, any> = {
      'http://real:4020/health': { ok: true, connectors: [{ id: 'salesforce', connected: true }, { id: 'google-analytics', connected: false, missing: ['GA4_PROPERTY_ID', 'ga4 secret value', 'GA4_SERVICE_ACCOUNT_JSON'] }] },
      'http://sample:4010/health': { ok: true, connectors: [{ id: 'salesforce', connected: false }, { id: 'marketing-cloud', connected: true }] },
    };
    const fetchImpl = (async (url: string) => {
      if (url in answers) return { ok: true, json: async () => answers[url] } as any;
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const out = await readConnectorStatuses(['http://real:4020/', 'http://sample:4010', 'http://gone:1'], fetchImpl);
    assert.deepEqual(out.salesforce, { checked: true, connected: true, missing: [] }, 'the first server to name a system decides');
    assert.deepEqual(out['google-analytics'], { checked: true, connected: false, missing: ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_JSON'] });
    assert.equal(out['marketing-cloud'].connected, true);
    assert.equal(Object.keys(out).length, 3);
    assert.deepEqual(await readConnectorStatuses([], fetchImpl), {});
    assert.deepEqual(statusUrlsFromEnv(' http://a:1 ,ftp://b, ,https://c '), ['http://a:1', 'https://c']);
  });

  console.log(`${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
