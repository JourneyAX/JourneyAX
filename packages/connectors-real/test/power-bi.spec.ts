import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { powerBi } from '../src/connectors/power-bi';
import { callTool, leaks, listTools, mockVendor, realDeps, serverFor, suite, type Seen } from './helpers';

const SECRET = 'pbi-client-secret-very-private-789';
const WORKSPACE = '11111111-2222-3333-4444-555555555555';
const DATASET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REPORT_GUID = '99999999-8888-7777-6666-555555555555';
const EXECUTE = `/v1.0/myorg/groups/${WORKSPACE}/datasets/${DATASET}/executeQueries`;
const REPORTS = `/v1.0/myorg/groups/${WORKSPACE}/reports`;

const FIGURES = [
  { id: 'sales-by-branch', name: 'Sales by branch', description: 'Sales and orders for each branch', datasetId: DATASET, reportId: REPORT_GUID, query: 'EVALUATE SUMMARIZECOLUMNS(Branch[Name], "Sales", [Total Sales], "Orders", [Order Count])' },
  { id: 'cases-by-priority', name: 'Cases by priority', datasetId: DATASET, query: 'EVALUATE ROW("High", 4, "Normal", 9)', totalsQuery: 'EVALUATE ROW("Total", 13)' },
];

const rowsOf = (rows: any[]) => ({ results: [{ tables: [{ rows }] }] });

async function setup(handler: (request: Seen) => any = () => rowsOf([]), extra: Record<string, string> = {}, figures: unknown = FIGURES) {
  const vendor = await mockVendor((request) => {
    if (request.path === '/token') return { json: { access_token: 'pbi-token-1', expires_in: 3599, token_type: 'Bearer' } };
    const out = handler(request);
    return out && typeof out.status === 'number' ? out : out ? { json: out } : undefined;
  });
  const env = {
    POWERBI_TENANT_ID: 'contoso.onmicrosoft.com', POWERBI_CLIENT_ID: 'app-1', POWERBI_CLIENT_SECRET: SECRET, POWERBI_WORKSPACE_ID: WORKSPACE,
    POWERBI_API_URL: `${vendor.url}/v1.0/myorg`, POWERBI_TOKEN_URL: `${vendor.url}/token`, POWERBI_REPORTS_JSON: JSON.stringify(figures), ...extra,
  };
  const server = serverFor(powerBi(env, realDeps()));
  return { vendor, server, call: (name: string, args: any = {}) => callTool(server, 'power-bi', name, args) };
}
const queries = (vendor: { seen: Seen[] }) => vendor.seen.filter((request) => request.path === EXECUTE);

const t = suite('connectors-real: Power BI');

async function main() {
  await t.test('it needs the app registration and a workspace; without them it is served but not connected', async () => {
    assert.deepEqual(powerBi({}, realDeps()).missing(), ['POWERBI_TENANT_ID', 'POWERBI_CLIENT_ID', 'POWERBI_CLIENT_SECRET', 'POWERBI_WORKSPACE_ID']);
    const server = serverFor(powerBi({}, realDeps()));
    assert.deepEqual(await listTools(server, 'power-bi'), []);
    assert.equal(((await callTool(server, 'power-bi', 'list_reports', {})) as any).payload.error.code, 'not_connected');
  });

  await t.test('it offers the same three tools as the sample, all read only, and none takes a query', async () => {
    const { server, vendor } = await setup();
    const tools = await listTools(server, 'power-bi');
    assert.deepEqual(tools.map((tool) => tool.name), ['list_reports', 'get_report_figures', 'report_totals']);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
    assert.ok(tools.every((tool) => !('query' in (tool.inputSchema.properties ?? {}))), 'the model has no way to send a query of its own');
    await vendor.close();
  });

  await t.test('it signs in as the app (client credentials, the Power BI scope) once and reuses the token', async () => {
    const { vendor, call } = await setup((request) => (request.path === REPORTS ? { value: [] } : request.path === EXECUTE ? rowsOf([]) : undefined));
    await call('list_reports', {});
    await call('get_report_figures', { reportId: 'sales-by-branch' });
    const logins = vendor.seen.filter((request) => request.path === '/token');
    assert.equal(logins.length, 1);
    assert.deepEqual(logins[0].body, { grant_type: 'client_credentials', client_id: 'app-1', client_secret: SECRET, scope: 'https://analysis.windows.net/powerbi/api/.default' });
    assert.ok(vendor.seen.filter((request) => request.path !== '/token').every((request) => request.headers.authorization === 'Bearer pbi-token-1'));
    await vendor.close();
  });

  await t.test('list_reports shows the reports that have figures first, then the workspace\'s other reports marked as without figures', async () => {
    const { vendor, call } = await setup((request) => (request.path === REPORTS ? { value: [{ id: REPORT_GUID, name: 'Sales by branch (report)', datasetId: DATASET }, { id: '12121212-3434-5656-7878-909090909090', name: 'Stock ageing', datasetId: DATASET }] } : undefined));
    const { payload } = (await call('list_reports', {})) as any;
    assert.deepEqual(payload.records, [
      { reportId: 'sales-by-branch', name: 'Sales by branch', description: 'Sales and orders for each branch', hasFigures: true },
      { reportId: 'cases-by-priority', name: 'Cases by priority', hasFigures: true },
      { reportId: '12121212-3434-5656-7878-909090909090', name: 'Stock ageing', hasFigures: false },
    ]);
    await vendor.close();
  });

  await t.test('list_reports still shows the reports that have figures when the workspace list cannot be read, and says so', async () => {
    const { vendor, call } = await setup((request) => (request.path === REPORTS ? { status: 403, json: { error: { code: 'Forbidden' } } } : undefined));
    const { payload } = (await call('list_reports', {})) as any;
    assert.equal(payload.returned, 2);
    assert.ok(payload.note.includes('could not be read'));
    await vendor.close();
  });

  await t.test('get_report_figures sends only the administrator\'s query, and tidies the column names', async () => {
    const { vendor, call } = await setup((request) => (request.path === EXECUTE ? rowsOf([{ 'Branch[Name]': 'Hamilton', '[Sales]': 1520.5, '[Orders]': 12 }, { 'Branch[Name]': 'Tauranga', '[Sales]': 980, '[Orders]': 7 }]) : undefined));
    const { payload } = (await call('get_report_figures', { reportId: 'Sales By Branch', limit: 1, query: 'EVALUATE ROW("hack", 1)' })) as any;
    assert.deepEqual(queries(vendor)[0].body, { queries: [{ query: FIGURES[0].query }], serializerSettings: { includeNulls: true } });
    assert.equal(payload.total, 2);
    assert.equal(payload.returned, 1);
    assert.equal(payload.truncated, true);
    assert.deepEqual(payload.records, [{ Name: 'Hamilton', Sales: 1520.5, Orders: 12 }]);
    assert.deepEqual(payload.report, { reportId: 'sales-by-branch', name: 'Sales by branch' });
    await vendor.close();
  });

  await t.test('a report can be asked for by its id, its name, or its Power BI report guid', async () => {
    const { vendor, call } = await setup((request) => (request.path === EXECUTE ? rowsOf([{ '[A]': 1 }]) : undefined));
    for (const given of ['sales-by-branch', 'Sales by branch', REPORT_GUID]) assert.equal(((await call('get_report_figures', { reportId: given })) as any).payload.report.reportId, 'sales-by-branch', given);
    await vendor.close();
  });

  await t.test('a report that exists but has no figures set up is told apart from one that does not exist', async () => {
    const { vendor, call } = await setup();
    assert.equal(((await call('get_report_figures', { reportId: '12121212-3434-5656-7878-909090909090' })) as any).payload.error.code, 'not_set_up');
    assert.equal(((await call('get_report_figures', { reportId: 'nothing-like-this' })) as any).payload.error.code, 'not_found');
    assert.equal(queries(vendor).length, 0);
    await vendor.close();
  });

  await t.test('report_totals uses the report\'s own totals query, or adds up the numeric columns of its figures', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.path !== EXECUTE) return undefined;
      return request.body.queries[0].query.includes('"Total"') ? rowsOf([{ '[Total]': 13 }]) : rowsOf([{ 'Branch[Name]': 'Hamilton', '[Sales]': 1520.55, '[Orders]': 12 }, { 'Branch[Name]': 'Tauranga', '[Sales]': 980.1, '[Orders]': 7 }]);
    });
    const own = (await call('report_totals', { reportId: 'cases-by-priority' })) as any;
    assert.deepEqual(own.payload.record, { Total: 13 });
    assert.equal(own.payload.computedFrom, undefined);
    const added = (await call('report_totals', { reportId: 'sales-by-branch' })) as any;
    assert.deepEqual(added.payload.record, { Sales: 2500.65, Orders: 19 }, 'text columns are left out, sums are rounded to cents');
    assert.equal(added.payload.rowsCounted, 2);
    assert.equal(added.payload.computedFrom, 'the report figures');
    await vendor.close();
  });

  await t.test('a query Power BI refuses is explained in its own words, whether it says so with a 400 or inside a 200', async () => {
    const failing = await setup((request) => (request.path === EXECUTE ? { status: 400, json: { error: { code: 'DatasetExecuteQueriesError', message: 'Failed to execute the DAX query.', 'pbi.error': { code: 'DatasetExecuteQueriesError', details: [{ code: 'DetailsMessage', detail: { type: 1, value: "Query (1, 10) The column 'Branch[Nme]' does not exist." } }] } } } } : undefined));
    const refused: any = await failing.call('get_report_figures', { reportId: 'sales-by-branch' });
    assert.equal(refused.payload.error.code, 'rejected');
    assert.ok(refused.payload.error.message.includes("does not exist"));
    await failing.vendor.close();

    const inside = await setup((request) => (request.path === EXECUTE ? { results: [{ error: { code: 'TooManyRows', message: 'More than 100000 rows in a query result' }, tables: [] }] } : undefined));
    const tooMany: any = await inside.call('get_report_figures', { reportId: 'sales-by-branch' });
    assert.equal(tooMany.payload.error.code, 'rejected');
    assert.ok(tooMany.payload.error.message.includes('More than 100000 rows'));
    await inside.vendor.close();
  });

  await t.test('access problems are named: the app is not allowed to use the API, or its secret is wrong; the secret never appears', async () => {
    const denied = await setup((request) => (request.path === EXECUTE ? { status: 403, json: { error: { code: 'PowerBINotAuthorizedException', message: 'Dataset Execute Queries REST API is disabled by the tenant admin.' } } } : undefined));
    const noAccess: any = await denied.call('get_report_figures', { reportId: 'sales-by-branch' });
    assert.equal(noAccess.payload.error.code, 'not_authorised');
    assert.ok(noAccess.payload.error.message.includes('disabled by the tenant admin'));
    await denied.vendor.close();

    const vendor = await mockVendor(() => ({ status: 401, json: { error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret provided ${SECRET}` } }));
    const server = serverFor(powerBi({ POWERBI_TENANT_ID: 'contoso.onmicrosoft.com', POWERBI_CLIENT_ID: 'a', POWERBI_CLIENT_SECRET: SECRET, POWERBI_WORKSPACE_ID: WORKSPACE, POWERBI_API_URL: `${vendor.url}/v1.0/myorg`, POWERBI_TOKEN_URL: `${vendor.url}/token` }, realDeps()));
    const signIn: any = await callTool(server, 'power-bi', 'list_reports', {});
    assert.equal(signIn.payload.error.code, 'not_authorised');
    assert.equal(leaks(signIn.payload, SECRET), false);
    await vendor.close();
  });

  await t.test('a damaged list of figures is reported as a setup problem, never run: bad query, bad dataset, not a list, a file that is not there', async () => {
    for (const bad of [[{ id: 'x', datasetId: DATASET, query: 'DROP TABLE x' }], [{ id: 'x', datasetId: 'not-a-guid', query: 'EVALUATE ROW("a",1)' }], [{ id: 'bad id!', datasetId: DATASET, query: 'EVALUATE ROW("a",1)' }], { id: 'x' }]) {
      const { vendor, call } = await setup(() => rowsOf([]), {}, bad);
      const result: any = await call('get_report_figures', { reportId: 'x' });
      assert.equal(result.payload.error.code, 'not_connected', JSON.stringify(bad));
      assert.equal(queries(vendor).length, 0);
      await vendor.close();
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'pbi-'));
    const file = path.join(dir, 'figures.json');
    writeFileSync(file, JSON.stringify(FIGURES));
    const fromFile = await setup(() => rowsOf([{ '[A]': 1 }]), { POWERBI_REPORTS_FILE: file, POWERBI_REPORTS_JSON: '' });
    assert.equal(((await fromFile.call('get_report_figures', { reportId: 'sales-by-branch' })) as any).payload.ok, true);
    await fromFile.vendor.close();
    const missingFile = await setup(() => rowsOf([]), { POWERBI_REPORTS_FILE: '/nonexistent/figures.json', POWERBI_REPORTS_JSON: '' });
    const unreadable: any = await missingFile.call('get_report_figures', { reportId: 'x' });
    assert.equal(unreadable.payload.error.code, 'not_connected');
    assert.ok(!unreadable.payload.error.message.includes('/nonexistent'));
    await missingFile.vendor.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
