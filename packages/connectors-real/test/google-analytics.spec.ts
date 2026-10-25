import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { googleAnalytics } from '../src/connectors/google-analytics';
import { callTool, leaks, listTools, mockVendor, realDeps, serverFor, suite, type Seen } from './helpers';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const PROPERTY = '412345678';
const REPORT_PATH = `/properties/${PROPERTY}:runReport`;

const metricHeaders = (...names: string[]) => names.map((name) => ({ name, type: 'TYPE_INTEGER' }));
const row = (dimensions: string[], metrics: Array<string | number>) => ({ dimensionValues: dimensions.map((value) => ({ value })), metricValues: metrics.map((value) => ({ value: String(value) })) });

async function setup(report: (request: Seen) => any = () => ({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] }), extraEnv: Record<string, string> = {}) {
  const vendor = await mockVendor((request) => {
    if (request.path === '/token') return { json: { access_token: 'ga-token-1', expires_in: 3599, token_type: 'Bearer' } };
    if (request.path === REPORT_PATH) { const out = report(request); return typeof out?.status === 'number' ? out : { json: out }; }
    return undefined;
  });
  const key = JSON.stringify({ type: 'service_account', client_email: 'reader@placemakers-demo.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${vendor.url}/token` });
  const env = { GA4_PROPERTY_ID: PROPERTY, GA4_SERVICE_ACCOUNT_JSON: key, GA4_API_URL: vendor.url, ...extraEnv };
  const server = serverFor(googleAnalytics(env, realDeps()));
  return { vendor, server, call: (name: string, args: any = {}) => callTool(server, 'google-analytics', name, args) };
}
const reports = (vendor: { seen: Seen[] }) => vendor.seen.filter((request) => request.path === REPORT_PATH);

const t = suite('connectors-real: Google Analytics');

async function main() {
  await t.test('it needs a property id and a service account key (a file or the JSON itself); without them it is not connected', async () => {
    assert.deepEqual(googleAnalytics({}, realDeps()).missing(), ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_FILE']);
    assert.deepEqual(googleAnalytics({ GA4_PROPERTY_ID: '1', GA4_SERVICE_ACCOUNT_JSON: '{}' }, realDeps()).missing(), []);
    const server = serverFor(googleAnalytics({}, realDeps()));
    assert.deepEqual(await listTools(server, 'google-analytics'), []);
    assert.equal(((await callTool(server, 'google-analytics', 'daily_traffic', {})) as any).payload.error.code, 'not_connected');
  });

  await t.test('it offers the same four tools as the sample, all read only', async () => {
    const { server, vendor } = await setup();
    const tools = await listTools(server, 'google-analytics');
    assert.deepEqual(tools.map((tool) => tool.name), ['traffic_by_page', 'top_searches', 'daily_traffic', 'conversion_summary']);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
    await vendor.close();
  });

  await t.test('it signs in with a correctly signed service account assertion (RS256, read-only scope), once, and reuses the token', async () => {
    const { vendor, call } = await setup();
    await call('daily_traffic', {});
    await call('conversion_summary', {});
    const logins = vendor.seen.filter((request) => request.path === '/token');
    assert.equal(logins.length, 1);
    assert.equal(logins[0].body.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = String(logins[0].body.assertion).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(body.iss, 'reader@placemakers-demo.iam.gserviceaccount.com');
    assert.equal(body.scope, 'https://www.googleapis.com/auth/analytics.readonly');
    assert.equal(body.aud, `${vendor.url}/token`);
    assert.equal(body.exp - body.iat, 3600);
    assert.equal(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')), true, 'the signature checks out against the public key');
    assert.ok(reports(vendor).every((request) => request.headers.authorization === 'Bearer ga-token-1'));
    await vendor.close();
  });

  await t.test('the key can also be read from a file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ga4-'));
    const file = path.join(dir, 'key.json');
    const vendor = await mockVendor((request) => (request.path === '/token' ? { json: { access_token: 't', expires_in: 3599 } } : { json: { rows: [], rowCount: 0 } }));
    writeFileSync(file, JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${vendor.url}/token` }));
    const server = serverFor(googleAnalytics({ GA4_PROPERTY_ID: PROPERTY, GA4_SERVICE_ACCOUNT_FILE: file, GA4_API_URL: vendor.url }, realDeps()));
    assert.equal(((await callTool(server, 'google-analytics', 'daily_traffic', {})) as any).payload.ok, true);
    await vendor.close();
  });

  await t.test('traffic_by_page asks for views and visitors by page path, busiest first, with an optional case-insensitive path filter', async () => {
    const { vendor, call } = await setup(() => ({ dimensionHeaders: [{ name: 'pagePath' }], metricHeaders: metricHeaders('screenPageViews', 'activeUsers'), rowCount: 41, rows: [row(['/online/pergolas'], [1200, 800]), row(['/online/decking'], [900, 610])] }));
    const { payload } = (await call('traffic_by_page', { pathContains: 'online', limit: 2 })) as any;
    assert.deepEqual(reports(vendor)[0].body, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: '2',
      dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: 'online', caseSensitive: false } } },
    });
    assert.equal(payload.total, 41);
    assert.equal(payload.returned, 2);
    assert.deepEqual(payload.period, { from: '28daysAgo', to: 'today' });
    assert.deepEqual(payload.records[0], { pagePath: '/online/pergolas', views: 1200, visitors: 800 });
    await vendor.close();
  });

  await t.test('top_searches leaves out "(not set)" and names the search term, searches and visitors', async () => {
    const { vendor, call } = await setup(() => ({ dimensionHeaders: [{ name: 'searchTerm' }], metricHeaders: metricHeaders('eventCount', 'activeUsers'), rowCount: 1, rows: [row(['gib board'], [77, 50])] }));
    const { payload } = (await call('top_searches', {})) as any;
    assert.deepEqual(reports(vendor)[0].body.dimensionFilter, { notExpression: { filter: { fieldName: 'searchTerm', stringFilter: { matchType: 'EXACT', value: '(not set)' } } } });
    assert.deepEqual(payload.records, [{ searchTerm: 'gib board', searches: 77, visitors: 50 }]);
    await vendor.close();
  });

  await t.test('daily_traffic returns days newest first with readable dates, and takes a period', async () => {
    const { vendor, call } = await setup(() => ({ dimensionHeaders: [{ name: 'date' }], metricHeaders: metricHeaders('sessions', 'activeUsers', 'keyEvents'), rowCount: 2, rows: [row(['20261024'], [310, 250, 12]), row(['20261023'], [290, 240, 9])] }));
    const { payload } = (await call('daily_traffic', { from: '2026-10-01', to: 'yesterday', limit: 2 })) as any;
    const body = reports(vendor)[0].body;
    assert.deepEqual(body.dateRanges, [{ startDate: '2026-10-01', endDate: 'yesterday' }]);
    assert.deepEqual(body.metrics, [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }]);
    assert.deepEqual(body.orderBys, [{ dimension: { dimensionName: 'date', orderType: 'ALPHANUMERIC' }, desc: true }]);
    assert.deepEqual(payload.records[0], { date: '2026-10-24', sessions: 310, visitors: 250, conversions: 12 });
    await vendor.close();
  });

  await t.test('conversion_summary groups by the way people arrived', async () => {
    const { vendor, call } = await setup(() => ({ dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }], metricHeaders: metricHeaders('sessions', 'keyEvents'), rowCount: 2, rows: [row(['Organic Search'], [900, 30]), row(['Direct'], [400, 18])] }));
    const { payload } = (await call('conversion_summary', {})) as any;
    assert.deepEqual(payload.records, [{ channel: 'Organic Search', sessions: 900, conversions: 30 }, { channel: 'Direct', sessions: 400, conversions: 18 }]);
    assert.equal(payload.property, PROPERTY);
    await vendor.close();
  });

  await t.test('a period written any other way is refused before anything is sent', async () => {
    const { vendor, call } = await setup();
    for (const from of ['last week', '2026-13-01x', "today'; drop", '99999daysAgo']) {
      assert.equal(((await call('daily_traffic', { from })) as any).payload.error.code, 'invalid_arguments', from);
    }
    assert.equal(reports(vendor).length, 0);
    await vendor.close();
  });

  await t.test('failures are named: no access to the property, the daily quota, a bad key, an unreadable key file; the key never appears', async () => {
    const denied = await setup(() => ({ status: 403, json: { error: { code: 403, message: 'User does not have sufficient permissions for this property.', status: 'PERMISSION_DENIED' } } }));
    const refused: any = await denied.call('daily_traffic', {});
    assert.equal(refused.payload.error.code, 'not_authorised');
    assert.ok(refused.payload.error.message.includes('sufficient permissions'));
    await denied.vendor.close();

    const quota = await setup(() => ({ status: 429, json: { error: { message: 'Exhausted property tokens for a project per hour', status: 'RESOURCE_EXHAUSTED' } } }));
    assert.equal(((await quota.call('top_searches', {})) as any).payload.error.code, 'rate_limited');
    await quota.vendor.close();

    const badKey = await mockVendor((request) => (request.path === '/token' ? { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } : undefined));
    const server = serverFor(googleAnalytics({ GA4_PROPERTY_ID: PROPERTY, GA4_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.c', private_key: privateKey, token_uri: `${badKey.url}/token` }), GA4_API_URL: badKey.url }, realDeps()));
    const signIn: any = await callTool(server, 'google-analytics', 'daily_traffic', {});
    assert.equal(signIn.payload.error.code, 'not_authorised');
    assert.equal(leaks(signIn.payload, 'BEGIN PRIVATE KEY'), false);
    await badKey.close();

    const nofile = serverFor(googleAnalytics({ GA4_PROPERTY_ID: PROPERTY, GA4_SERVICE_ACCOUNT_FILE: '/nonexistent/key.json' }, realDeps()));
    const missing: any = await callTool(nofile, 'google-analytics', 'daily_traffic', {});
    assert.equal(missing.payload.error.code, 'not_connected');
    assert.ok(!missing.payload.error.message.includes('/nonexistent'), 'the file path is not repeated to the model');
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
