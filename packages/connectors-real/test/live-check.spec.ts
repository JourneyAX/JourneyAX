import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mockVendor, suite } from './helpers';

const SCRIPT = path.resolve(__dirname, '../scripts/live-check.ts');
const SECRET = 'live-check-secret-abcdef-999';

/** Runs the live check as its own process (as a person would), with the given settings, and returns what it printed and how it ended. */
function runCheck(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const t = suite('connectors-real: the live check');

async function main() {
  await t.test('with nothing set up it says what each connector still needs, changes nothing, and does not fail', async () => {
    const { code, out } = await runCheck([], {});
    assert.equal(code, 0);
    assert.match(out, /commercetools\n\s+not set up: still needs COMMERCETOOLS_PROJECT_KEY/);
    assert.match(out, /salesforce\n\s+not set up: still needs SALESFORCE_INSTANCE_URL/);
    assert.match(out, /Nothing was changed in any system\./);
  });

  await t.test('against a working commercetools it reads, reports plainly, skips what needs an id, and refuses to change anything without --writes', async () => {
    const vendor = await mockVendor((request) => {
      if (request.path === '/oauth/token') return { json: { access_token: 't', expires_in: 3600 } };
      if (request.path.endsWith('/product-projections/search')) return { json: { total: 2, count: 1, results: [{ id: 'p1', name: { en: 'Hose reel' }, masterVariant: { sku: 'A-1', prices: [{ value: { currencyCode: 'NZD', centAmount: 4900, fractionDigits: 2 } }] }, variants: [] }] } };
      return undefined;
    });
    const env = { COMMERCETOOLS_PROJECT_KEY: 'p', COMMERCETOOLS_CLIENT_ID: 'c', COMMERCETOOLS_CLIENT_SECRET: SECRET, COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: vendor.url, COMMERCETOOLS_AUTH_URL: vendor.url };
    const { code, out } = await runCheck(['commercetools'], env);
    assert.equal(code, 0, out);
    assert.match(out, /ok\s+find_product: 1 of 2 returned/);
    assert.match(out, /ok\s+get_product: Hose reel \(49 NZD\)/);
    assert.match(out, /skipped\s+get_cart: set CHECK_COMMERCETOOLS_CART_ID/);
    assert.match(out, /skipped\s+add_to_cart: a change; run with --writes/);
    assert.ok(!out.includes(SECRET), 'the secret is never printed');
    assert.equal(vendor.seen.filter((request) => request.method === 'POST' && request.path !== '/oauth/token').length, 0, 'nothing was sent that could change anything');
    await vendor.close();
  });

  await t.test('a refused connection is reported as a failure, in plain words, with a failing exit code', async () => {
    const vendor = await mockVendor((request) => (request.path === '/oauth/token' ? { status: 401, json: { error: 'invalid_client', error_description: `bad secret ${SECRET}` } } : undefined));
    const env = { COMMERCETOOLS_PROJECT_KEY: 'p', COMMERCETOOLS_CLIENT_ID: 'c', COMMERCETOOLS_CLIENT_SECRET: SECRET, COMMERCETOOLS_REGION: 'r', COMMERCETOOLS_API_URL: vendor.url, COMMERCETOOLS_AUTH_URL: vendor.url };
    const { code, out } = await runCheck(['commercetools'], env);
    assert.equal(code, 1);
    assert.match(out, /FAILED\s+find_product: not_authorised/);
    assert.ok(!out.includes(SECRET));
    await vendor.close();
  });

  await t.test('an unknown connector name is refused', async () => {
    const { code, out } = await runCheck(['nonsense'], {});
    assert.equal(code, 1);
    assert.match(out, /Unknown connector "nonsense"/);
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
