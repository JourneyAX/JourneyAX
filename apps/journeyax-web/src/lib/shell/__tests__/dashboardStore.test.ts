/**
 * The one copy of the dashboard the tile and the canvas share.
 *   npx tsx --tsconfig apps/journeyax-web/tsconfig.json apps/journeyax-web/src/lib/shell/__tests__/dashboardStore.test.ts
 */
import assert from 'node:assert/strict';

(globalThis as any).window = {};
(globalThis as any).document = { visibilityState: 'visible' };

let passed = 0;
const calls: Array<{ url: string; tenant?: string }> = [];
let respond: () => { ok: boolean; json: () => Promise<unknown> } = () => ({ ok: true, json: async () => ({}) });
(globalThis as any).fetch = async (url: string, init: any) => { calls.push({ url, tenant: init?.headers?.['X-Tenant-ID'] }); return respond(); };

const good = (title: string, value: string) => ({ ok: true, json: async () => ({ dashboard: { title, tile: [{ id: 'a', label: 'Open deals', value }], metrics: [], sections: [] } }) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function main() {
  const { trackDashboard, getDashboardState, loadDashboard } = await import('../dashboardStore');
  const check = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

  console.log('dashboardStore');

  await check('a signed-in person’s dashboard is fetched once for their project and kept', async () => {
    respond = () => good('My day', '22');
    trackDashboard('sales@placemakers.demo', 'placemakers');
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { url: '/api/dashboard', tenant: 'placemakers' });
    assert.equal(getDashboardState().status, 'ready');
    assert.equal(getDashboardState().data?.tile[0].value, '22');
    trackDashboard('SALES@placemakers.demo', 'placemakers');
    await settle();
    assert.equal(calls.length, 1, 'the same person again does not start another request');
  });

  await check('the next person to sign in never sees the last person’s figures', async () => {
    respond = () => good('Today', '3');
    trackDashboard('finance@placemakers.demo', 'placemakers');
    assert.equal(getDashboardState().data, undefined, 'cleared the moment the person changes');
    await settle();
    assert.equal(getDashboardState().data?.title, 'Today');
    trackDashboard(null, 'placemakers');
    assert.equal(getDashboardState().status, 'idle');
    assert.equal(getDashboardState().data, undefined);
  });

  await check('a person with no dashboard gets none, and a refresh that fails keeps the figures already there', async () => {
    respond = () => ({ ok: true, json: async () => ({}) });
    trackDashboard('shopper@placemakers.demo', 'placemakers');
    await settle();
    assert.equal(getDashboardState().status, 'none');

    respond = () => good('My day', '22');
    trackDashboard('sales@placemakers.demo', 'placemakers');
    await settle();
    respond = () => ({ ok: false, json: async () => ({}) });
    await loadDashboard();
    assert.equal(getDashboardState().status, 'ready');
    assert.equal(getDashboardState().data?.tile[0].value, '22', 'the last good figures stay');
    assert.equal(getDashboardState().refreshing, false);
    trackDashboard(null, undefined);
  });

  await check('an answer for a person who has since signed out is thrown away', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    respond = () => ({ ok: true, json: async () => { await gate; return { dashboard: { title: 'Late', tile: [{ id: 'a', label: 'L', value: '9' }] } }; } });
    trackDashboard('slow@placemakers.demo', 'placemakers');
    trackDashboard(null, 'placemakers');
    release();
    await settle();
    assert.equal(getDashboardState().data, undefined);
    assert.equal(getDashboardState().status, 'idle');
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
