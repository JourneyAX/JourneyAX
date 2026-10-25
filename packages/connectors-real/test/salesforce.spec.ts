import assert from 'node:assert/strict';
import { salesforce } from '../src/connectors/salesforce';
import { callTool, leaks, listTools, mockVendor, realDeps, serverFor, suite, type Seen } from './helpers';

const SECRET = 'sf-client-secret-very-private-456';
const ACCOUNT = '0015g00000AbCdEfGh';
const CASE_ID = '5005g00000XyZaBcDe';

const accountRow = { Id: ACCOUNT, Name: 'Hamilton Builders Ltd', Type: 'Customer', Industry: 'Construction', Phone: '07 555 0100', BillingCity: 'Hamilton', Owner: { Name: 'Sam Seller' }, Customer_Tier__c: 'Gold', Home_Branch__c: 'HAM01' };
const caseRow = { Id: CASE_ID, CaseNumber: '00001026', Subject: 'Delivery arrived damaged', Description: 'Two sheets cracked', Status: 'Working', Priority: 'High', Origin: 'Phone', AccountId: ACCOUNT, Account: { Name: 'Hamilton Builders Ltd' }, Owner: { Name: 'Casey Support' }, Contact: { Name: 'Alex Trade' }, CreatedDate: '2026-10-20T01:00:00.000+0000', ClosedDate: null };

/** A pretend Salesforce: signs in, answers SOQL by what it asks for, and records everything. */
async function setup(extraEnv: Record<string, string> = {}, override?: (request: Seen, count: number) => any) {
  const vendor = await mockVendor((request, count) => {
    const custom = override?.(request, count);
    if (custom) return custom;
    if (request.path === '/services/oauth2/token') return { json: { access_token: 'sf-token-1', instance_url: 'x', token_type: 'Bearer' } };
    const soql = request.query.get('q') ?? '';
    if (request.path === '/services/data/v62.0/query') {
      if (/FROM Account WHERE Id =/.test(soql)) return { json: { totalSize: 1, done: true, records: [accountRow] } };
      if (/FROM Account/.test(soql)) return { json: { totalSize: 1, done: true, records: [accountRow] } };
      if (/FROM Contact/.test(soql)) return { json: { totalSize: 1, done: true, records: [{ Name: 'Alex Trade', Title: 'Buyer', Phone: '021 555 0101', Email: 'alex@hamilton.example' }] } };
      if (/FROM Case WHERE Id =/.test(soql) && /Description/.test(soql)) return { json: { totalSize: 1, records: [caseRow] } };
      if (/FROM Case WHERE CaseNumber =/.test(soql)) return { json: { totalSize: 1, records: [caseRow] } };
      if (/FROM Case/.test(soql)) return { json: { totalSize: 1, records: [caseRow] } };
    }
    if (request.path === '/services/data/v62.0/sobjects/Case' && request.method === 'POST') return { status: 201, json: { id: CASE_ID, success: true, errors: [] } };
    return undefined;
  });
  const env = { SALESFORCE_INSTANCE_URL: vendor.url, SALESFORCE_CLIENT_ID: 'sf-client-1', SALESFORCE_CLIENT_SECRET: SECRET, ...extraEnv };
  const server = serverFor(salesforce(env, realDeps()));
  return { vendor, server, call: (name: string, args: any = {}) => callTool(server, 'salesforce', name, args) };
}
const soqlSeen = (vendor: { seen: Seen[] }) => vendor.seen.filter((request) => request.path.endsWith('/query')).map((request) => request.query.get('q'));

const t = suite('connectors-real: Salesforce');

async function main() {
  await t.test('settings: the address is needed, and either a client id and secret or a token; nothing else is', async () => {
    assert.deepEqual(salesforce({}, realDeps()).missing(), ['SALESFORCE_INSTANCE_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET']);
    assert.deepEqual(salesforce({ SALESFORCE_INSTANCE_URL: 'https://x.my.salesforce.com' }, realDeps()).missing(), ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET']);
    assert.deepEqual(salesforce({ SALESFORCE_INSTANCE_URL: 'https://x.my.salesforce.com', SALESFORCE_ACCESS_TOKEN: 'abc' }, realDeps()).missing(), []);
    const server = serverFor(salesforce({}, realDeps()));
    assert.deepEqual(await listTools(server, 'salesforce'), []);
    assert.equal(((await callTool(server, 'salesforce', 'find_account', {})) as any).payload.error.code, 'not_connected');
  });

  await t.test('it offers the sample tools that make sense in a real org (not order_review_status), and only create_case changes anything', async () => {
    const { server, vendor } = await setup();
    const tools = await listTools(server, 'salesforce');
    assert.deepEqual(tools.map((tool) => tool.name), ['find_account', 'get_account', 'list_cases', 'get_case', 'create_case']);
    assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name), ['create_case']);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['query', 'limit'], 'no tier or branch filter until those fields are set');
    await vendor.close();
    const withFields = await setup({ SALESFORCE_TIER_FIELD: 'Customer_Tier__c', SALESFORCE_BRANCH_FIELD: 'Home_Branch__c' });
    assert.deepEqual(Object.keys((await listTools(withFields.server, 'salesforce'))[0].inputSchema.properties), ['query', 'tier', 'branchCode', 'limit']);
    await withFields.vendor.close();
  });

  await t.test('it signs in with the client credentials flow, once, and sends the token as a bearer', async () => {
    const { vendor, call } = await setup();
    await call('find_account', { query: 'ham' });
    await call('list_cases', {});
    const logins = vendor.seen.filter((request) => request.path === '/services/oauth2/token');
    assert.equal(logins.length, 1);
    assert.equal(logins[0].method, 'POST');
    assert.deepEqual(logins[0].body, { grant_type: 'client_credentials', client_id: 'sf-client-1', client_secret: SECRET });
    assert.ok(vendor.seen.filter((request) => request.path.startsWith('/services/data')).every((request) => request.headers.authorization === 'Bearer sf-token-1'));
    await vendor.close();
  });

  await t.test('a token given directly is used as it is, with no sign-in call', async () => {
    const vendor = await mockVendor((request) => (request.path.endsWith('/query') ? { json: { totalSize: 0, records: [] } } : undefined));
    const server = serverFor(salesforce({ SALESFORCE_INSTANCE_URL: vendor.url, SALESFORCE_ACCESS_TOKEN: 'direct-token-789' }, realDeps()));
    await callTool(server, 'salesforce', 'find_account', {});
    assert.equal(vendor.seen.length, 1);
    assert.equal(vendor.seen[0].headers.authorization, 'Bearer direct-token-789');
    await vendor.close();
  });

  await t.test('find_account builds a safe SOQL query: names are escaped so a quote or % cannot change the query', async () => {
    const { vendor, call } = await setup();
    const { payload } = (await call('find_account', { query: "O'Brien & 50%_off" })) as any;
    assert.equal(soqlSeen(vendor)[0], "SELECT Id, Name, Type, Industry, Phone, BillingCity, Owner.Name, Description FROM Account WHERE Name LIKE '%O\\'Brien & 50\\%\\_off%' ORDER BY Name ASC LIMIT 10");
    assert.deepEqual(payload.records[0], { accountId: ACCOUNT, name: 'Hamilton Builders Ltd', type: 'Customer', industry: 'Construction', phone: '07 555 0100', city: 'Hamilton', owner: 'Sam Seller' });
    await call('find_account', { query: "x\\' OR Name != '" });
    assert.ok(soqlSeen(vendor)[1]!.includes("'%x\\\\\\' OR Name != \\'%'"), 'a backslash and a quote are both escaped');
    await vendor.close();
  });

  await t.test('find_account can filter on a tier and a home branch when those custom fields are named, and they come back in the record', async () => {
    const { vendor, call } = await setup({ SALESFORCE_TIER_FIELD: 'Customer_Tier__c', SALESFORCE_BRANCH_FIELD: 'Home_Branch__c' });
    const { payload } = (await call('find_account', { tier: 'Gold', branchCode: 'HAM01', limit: 3 })) as any;
    assert.equal(soqlSeen(vendor)[0], "SELECT Id, Name, Type, Industry, Phone, BillingCity, Owner.Name, Description, Customer_Tier__c, Home_Branch__c FROM Account WHERE Customer_Tier__c = 'Gold' AND Home_Branch__c = 'HAM01' ORDER BY Name ASC LIMIT 3");
    assert.equal(payload.records[0].tier, 'Gold');
    assert.equal(payload.records[0].homeBranchCode, 'HAM01');
    await vendor.close();
    const bad = await setup({ SALESFORCE_TIER_FIELD: 'Name FROM User--' });
    await bad.call('find_account', { tier: 'Gold' });
    assert.ok(!soqlSeen(bad.vendor)[0]!.includes('WHERE'), 'a field name that is not a plain field name is ignored, never put in the query');
    await bad.vendor.close();
  });

  await t.test('get_account returns the account with its latest cases and main contacts, and says not found for an unknown id', async () => {
    const { vendor, call } = await setup();
    const { payload } = (await call('get_account', { accountId: ACCOUNT })) as any;
    assert.equal(payload.record.name, 'Hamilton Builders Ltd');
    assert.equal(payload.record.cases[0].caseNumber, '00001026');
    assert.deepEqual(payload.record.contacts[0], { name: 'Alex Trade', title: 'Buyer', phone: '021 555 0101', email: 'alex@hamilton.example' });
    assert.equal(soqlSeen(vendor).length, 3);
    await vendor.close();
    const empty = await setup({}, (request) => (request.path.endsWith('/query') ? { json: { totalSize: 0, records: [] } } : undefined));
    assert.equal(((await empty.call('get_account', { accountId: ACCOUNT })) as any).payload.error.code, 'not_found');
    await empty.vendor.close();
  });

  await t.test('list_cases filters by account, status and priority (normal means medium) and returns the newest first', async () => {
    const { vendor, call } = await setup();
    const { payload } = (await call('list_cases', { accountId: ACCOUNT, status: 'Working', priority: 'normal', limit: 5 })) as any;
    assert.equal(soqlSeen(vendor)[0], `SELECT Id, CaseNumber, Subject, Status, Priority, AccountId, Account.Name, CreatedDate FROM Case WHERE AccountId = '${ACCOUNT}' AND Status = 'Working' AND Priority = 'Medium' ORDER BY CreatedDate DESC LIMIT 5`);
    assert.deepEqual(payload.records[0], { caseId: CASE_ID, caseNumber: '00001026', subject: 'Delivery arrived damaged', status: 'Working', priority: 'High', accountId: ACCOUNT, account: 'Hamilton Builders Ltd', created: '2026-10-20T01:00:00.000+0000' });
    await vendor.close();
  });

  await t.test('an account whose description carries the sample account number and the commercetools unit returns both, so the two systems can be followed from one to the other', async () => {
    const linked = { ...accountRow, Description: 'Trade type: concreter. Tier: silver. Account number ACC-0001. commercetools unit acc-0001. Sample data.' };
    const { vendor, call } = await setup({}, (request) => (request.path.endsWith('/query') && /FROM Account/.test(request.query.get('q') ?? '') ? { json: { totalSize: 1, records: [linked] } } : undefined));
    const found = ((await call('find_account', { query: 'Hamilton' })) as any).payload.records[0];
    assert.equal(found.accountNumber, 'ACC-0001');
    assert.equal(found.commercetoolsUnit, 'acc-0001');
    assert.equal(found.description, undefined, 'the whole description is not passed on');
    const plain = await setup();
    assert.equal(((await plain.call('find_account', { query: 'Hamilton' })) as any).payload.records[0].accountNumber, undefined, 'an account with no such note simply has no number');
    await vendor.close(); await plain.vendor.close();
  });

  await t.test('list_cases understands "open" and "closed" as every status that is not closed, or closed, so the assistant need not ask which statuses count', async () => {
    const { vendor, call } = await setup();
    await call('list_cases', { accountId: ACCOUNT, status: 'open' });
    await call('list_cases', { status: 'Closed' });
    assert.equal(soqlSeen(vendor)[0], `SELECT Id, CaseNumber, Subject, Status, Priority, AccountId, Account.Name, CreatedDate FROM Case WHERE AccountId = '${ACCOUNT}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 10`);
    assert.ok(soqlSeen(vendor)[1]!.includes('WHERE IsClosed = true ORDER BY'), 'closed is the closed flag too');
    await vendor.close();
  });

  await t.test('ids and statuses that could break out of the query are refused before anything is sent', async () => {
    const { vendor, call } = await setup();
    for (const [tool, args] of [['get_account', { accountId: "x' OR Name != '" }], ['list_cases', { accountId: "a' OR '1'='1" }], ['list_cases', { status: "New' OR Subject != '" }], ['get_case', { caseId: "1' OR '1'='1" }], ['create_case', { accountId: 'bad id', subject: 'x' }]] as const) {
      const result: any = await call(tool, args);
      assert.equal(result.payload.error.code, 'invalid_arguments', `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(vendor.seen.filter((request) => request.path.startsWith('/services/data')).length, 0);
    await vendor.close();
  });

  await t.test('get_case takes an id or a case number (padded the way Salesforce writes it) and not found is reported', async () => {
    const { vendor, call } = await setup();
    const byNumber = (await call('get_case', { caseId: '1026' })) as any;
    assert.ok(soqlSeen(vendor)[0]!.includes("WHERE CaseNumber = '00001026' LIMIT 1"));
    assert.equal(byNumber.payload.record.description, 'Two sheets cracked');
    assert.equal(byNumber.payload.record.owner, 'Casey Support');
    assert.equal(byNumber.payload.record.contact, 'Alex Trade');
    await call('get_case', { caseId: CASE_ID });
    assert.ok(soqlSeen(vendor)[1]!.includes(`WHERE Id = '${CASE_ID}' LIMIT 1`));
    await vendor.close();
    const none = await setup({}, (request) => (request.path.endsWith('/query') ? { json: { totalSize: 0, records: [] } } : undefined));
    assert.equal(((await none.call('get_case', { caseId: '99999' })) as any).payload.error.code, 'not_found');
    await none.vendor.close();
  });

  await t.test('create_case opens a case with the right fields, reads back its number, and reports a refusal in plain words', async () => {
    const { vendor, call } = await setup({ SALESFORCE_CASE_ORIGIN: 'Web' });
    const { payload } = (await call('create_case', { accountId: ACCOUNT, subject: 'Damaged delivery', description: 'Two sheets cracked', priority: 'high' })) as any;
    const post = vendor.seen.find((request) => request.method === 'POST' && request.path.endsWith('/sobjects/Case'))!;
    assert.deepEqual(post.body, { AccountId: ACCOUNT, Subject: 'Damaged delivery', Description: 'Two sheets cracked', Priority: 'High', Origin: 'Web' });
    assert.equal(payload.created, true);
    assert.equal(payload.record.caseNumber, '00001026');
    await vendor.close();

    const refusing = await setup({}, (request) => (request.method === 'POST' && request.path.endsWith('/sobjects/Case') ? { status: 400, json: [{ message: 'Account ID: id value of incorrect type', errorCode: 'MALFORMED_ID' }] } : undefined));
    const refused: any = await refusing.call('create_case', { accountId: ACCOUNT, subject: 'x' });
    assert.equal(refused.isError, true);
    assert.equal(refused.payload.error.code, 'rejected');
    assert.ok(refused.payload.error.message.includes('incorrect type'));
    await refusing.vendor.close();
  });

  await t.test('an expired session is renewed once; a used-up daily limit and a refused sign-in are named; the secret never appears', async () => {
    let logins = 0;
    const renewing = await setup({}, (request) => {
      if (request.path === '/services/oauth2/token') { logins++; return { json: { access_token: `tok-${logins}` } }; }
      if (request.path.endsWith('/query')) return request.headers.authorization === 'Bearer tok-1' ? { status: 401, json: [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }] } : { json: { totalSize: 0, records: [] } };
    });
    assert.equal(((await renewing.call('list_cases', {})) as any).payload.ok, true);
    assert.equal(logins, 2);
    await renewing.vendor.close();

    const limited = await setup({}, (request) => (request.path.endsWith('/query') ? { status: 403, json: [{ message: 'TotalRequests Limit exceeded.', errorCode: 'REQUEST_LIMIT_EXCEEDED' }] } : undefined));
    assert.equal(((await limited.call('list_cases', {})) as any).payload.error.code, 'rate_limited');
    await limited.vendor.close();

    const refusing = await setup({}, (request) => (request.path === '/services/oauth2/token' ? { status: 400, json: { error: 'invalid_client', error_description: `invalid client credentials ${SECRET}` } } : undefined));
    const refused: any = await refusing.call('find_account', {});
    assert.equal(refused.payload.error.code, 'not_authorised');
    assert.equal(leaks(refused.payload, SECRET), false);
    await refusing.vendor.close();

    const direct = await mockVendor(() => ({ status: 401, json: [{ message: 'Session expired', errorCode: 'INVALID_SESSION_ID' }] }));
    const fixed = serverFor(salesforce({ SALESFORCE_INSTANCE_URL: direct.url, SALESFORCE_ACCESS_TOKEN: 'direct-token-789' }, realDeps()));
    const result: any = await callTool(fixed, 'salesforce', 'find_account', {});
    assert.equal(result.payload.error.code, 'not_authorised');
    assert.equal(leaks(result.payload, 'direct-token-789'), false);
    assert.equal(direct.seen.length, 2, 'a fixed token is tried twice at most, never in a loop');
    await direct.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
