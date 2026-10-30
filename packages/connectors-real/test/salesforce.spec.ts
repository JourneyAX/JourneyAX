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

  await t.test('it offers the account and case tools, the sales and marketing tools (leads, deals, pipeline, campaigns), and only create_case changes anything', async () => {
    const { server, vendor } = await setup();
    const tools = await listTools(server, 'salesforce');
    assert.deepEqual(tools.map((tool) => tool.name), ['find_account', 'get_account', 'list_cases', 'get_case', 'find_lead', 'list_opportunities', 'get_opportunity', 'pipeline_summary', 'list_campaigns', 'get_campaign', 'create_case']);
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
    // A field name that is not a plain field name is not accepted as a setting, so the tool has no tier input: the call is refused, and nothing is sent.
    const refused: any = await bad.call('find_account', { tier: 'Gold' });
    assert.equal(refused.isError, true);
    assert.match(refused.payload.error.message, /tier is not an input of this tool/);
    assert.equal(soqlSeen(bad.vendor).length, 0, 'nothing is sent for an input the tool does not have');
    await bad.call('find_account', { query: 'Hamilton' });
    assert.ok(!soqlSeen(bad.vendor)[0]!.includes('User--'), 'a field name that is not plain is never put in the query');
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

  /** A pretend org that answers the questions the sales and marketing tools ask, shaped like the real answers. */
  const salesOrg = (request: Seen) => {
    const soql = request.query.get('q') ?? '';
    if (!request.path.endsWith('/query')) return undefined;
    if (/FROM Lead/.test(soql)) return { json: { totalSize: 1, records: [{ Id: '00Qi8000002Dv6OEAS', Name: 'Emma Cooper', Company: 'Coastal Homes Ltd', Title: 'Project manager', Status: 'Qualified', Rating: 'Hot', LeadSource: 'Web', City: 'Hamilton', Email: 'emma@example.test', Phone: '021 555 0100', Owner: { Name: 'Wendy Hartley' }, CreatedDate: '2026-10-25T01:00:00.000+0000' }] } };
    if (/FROM Opportunity WHERE Id =|FROM Opportunity WHERE Name LIKE/.test(soql)) return { json: { totalSize: 1, records: [{
      Id: '006i80000023uu9AAA', Name: 'Talbot: Pool Gate [OPP-0001]', Account: { Name: 'Talbot & Nguyen Concrete Ltd' }, AccountId: ACCOUNT, StageName: 'Closed Won', Amount: 1849.5, CloseDate: '2026-10-15', Owner: { Name: 'Hemi Ashworth' }, Probability: 100, NextStep: 'Delivered', LeadSource: 'Web', Type: 'Existing Business',
      Description: 'Launch products for Talbot.', Pricebook2: { Name: 'Silver trade' }, OpportunityContactRoles: { records: [{ Contact: { Name: 'Tessa Thornbury', Title: 'Director' }, IsPrimary: true }] },
      OpportunityLineItems: { records: [{ Product2: { Name: 'Pool Gate Post', ProductCode: '2910018' }, Quantity: 3, UnitPrice: 123.5, TotalPrice: 370.5 }] },
      Tasks: { records: [{ Subject: 'Thank you call', Status: 'Completed', ActivityDate: '2026-10-23' }] }, Events: { records: [{ Subject: 'Site visit', StartDateTime: '2026-10-20T09:00:00.000+0000', Location: 'Hamilton' }] },
    }] } };
    if (/FROM Opportunity WHERE AccountId IN/.test(soql)) return { json: { totalSize: 3, records: [{ stage: 'Propose', deals: 2, amount: 3000.5 }, { stage: 'Closed Won', deals: 1, amount: 1849.5 }, { stage: 'Closed Lost', deals: 1, amount: 99 }] } };
    if (/FROM Opportunity WHERE IsClosed = false GROUP BY Owner\.Name/.test(soql)) return { json: { totalSize: 2, records: [{ rep: 'Hemi Ashworth', deals: 3, amount: 14639.3 }, { rep: 'Jess Penrose', deals: 5, amount: 27612.09 }] } };
    if (/FROM Opportunity WHERE IsWon = true GROUP BY Owner\.Name/.test(soql)) return { json: { totalSize: 1, records: [{ rep: 'Hemi Ashworth', deals: 2, amount: 5103.25 }] } };
    if (/FROM Opportunity GROUP BY StageName/.test(soql)) return { json: { totalSize: 4, records: [{ stage: 'Propose', deals: 7, amount: 30135.29 }, { stage: 'Qualify', deals: 5, amount: 10626.4 }, { stage: 'Negotiate', deals: 5, amount: 23447.02 }, { stage: 'Closed Won', deals: 6, amount: 38787.95 }] } };
    if (/FROM Opportunity/.test(soql)) return { json: { totalSize: 2, records: [{ Id: '006i80000023uuEAAQ', Name: 'Ngata: Shed [OPP-0006]', Account: { Name: 'Ngata Ltd' }, AccountId: ACCOUNT, StageName: 'Propose', Amount: 6612, CloseDate: '2026-11-01', Owner: { Name: 'Jess Penrose' }, NextStep: 'Send the quote', LeadSource: 'Web' }, { Id: '006i80000023uuFAAQ', Name: 'Other: Gate [OPP-0007]', StageName: 'Qualify', Amount: 100.25, CloseDate: '2026-11-09', Owner: { Name: 'Jess Penrose' } }] } };
    if (/FROM CampaignMember WHERE CampaignId IN .* GROUP BY Status/.test(soql)) return { json: { totalSize: 2, records: [{ status: 'Sent', members: 3 }, { status: 'Responded', members: 15 }] } };
    if (/FROM CampaignMember WHERE CampaignId IN .* ContactId != null/.test(soql)) return { json: { totalSize: 2, records: [{ Contact: { AccountId: ACCOUNT } }, { Contact: { AccountId: ACCOUNT } }, { Contact: { AccountId: '001i8000008Uu8IAAS' } }] } };
    if (/FROM CampaignMember/.test(soql)) return { json: { totalSize: 2, records: [{ Status: 'Responded', Contact: { Name: 'Tessa Thornbury', Account: { Name: 'Talbot & Nguyen Concrete Ltd' } }, Campaign: { Name: 'Trade night' } }, { Status: 'Responded', Lead: { Name: 'Emma Cooper', Company: 'Coastal Homes Ltd' }, Campaign: { Name: 'Trade night' } }] } };
    if (/FROM Campaign WHERE ParentId =/.test(soql)) return { json: { totalSize: 1, records: [{ Id: '701i8000008V7IMAA0', Name: 'Trade night', Type: 'Seminar / Conference', Status: 'Completed', Parent: { Name: 'Spring' }, NumberSent: 18, NumberOfResponses: 15 }] } };
    if (/FROM Campaign/.test(soql)) return { json: { totalSize: 1, records: [{
      Id: '701i8000008UylLAAS', Name: 'Spring Outdoor Living 2026', Type: 'Other', Status: 'In Progress', StartDate: '2026-09-14', EndDate: '2026-12-13', BudgetedCost: 38500, ActualCost: 19850, ExpectedRevenue: 150000, NumberSent: 0, NumberOfResponses: 0, NumberOfLeads: 0, NumberOfContacts: 0,
      Brief: { Name: 'Launch brief', KeyMessage: 'Everything for the deck.', TargetAudience: 'Builders.', Description: 'We are launching 12 products.', AdditionalNotes: 'Range list.' }, Description: 'The spring launch.', Owner: { Name: 'Yvette Ellery' },
    }] } };
    return undefined;
  };

  await t.test('find_lead searches open leads by words, status, rating and the campaign they came from, with every value escaped', async () => {
    const { vendor, call } = await setup({}, salesOrg);
    const { payload } = (await call('find_lead', { query: "Coast'al", status: 'Qualified', rating: 'Hot', campaign: 'banners', limit: 5 })) as any;
    assert.equal(soqlSeen(vendor)[0], "SELECT Id, Name, Company, Title, Status, Rating, LeadSource, City, Email, Phone, Owner.Name, CreatedDate FROM Lead WHERE IsConverted = false AND (Name LIKE '%Coast\\'al%' OR Company LIKE '%Coast\\'al%' OR Email LIKE '%Coast\\'al%') AND Status = 'Qualified' AND Rating = 'Hot' AND Id IN (SELECT LeadId FROM CampaignMember WHERE Campaign.Name LIKE '%banners%') ORDER BY CreatedDate DESC, Name ASC LIMIT 5");
    assert.deepEqual(payload.records[0], { leadId: '00Qi8000002Dv6OEAS', name: 'Emma Cooper', company: 'Coastal Homes Ltd', title: 'Project manager', status: 'Qualified', rating: 'Hot', source: 'Web', city: 'Hamilton', email: 'emma@example.test', phone: '021 555 0100', owner: 'Wendy Hartley', created: '2026-10-25T01:00:00.000+0000' });
    const bad: any = await call('find_lead', { status: "New' OR Name != '" });
    assert.equal(bad.payload.error.code, 'invalid_arguments', 'a status must be one of the real ones');
    await vendor.close();
  });

  await t.test('list_opportunities: "open", "won" and "lost" are groups of stages, open deals come soonest first and finished ones latest first, and a bad date is refused before anything is sent', async () => {
    const { vendor, call } = await setup({}, salesOrg);
    const open = ((await call('list_opportunities', { stage: 'open', owner: 'Jess', closingBefore: '2026-12-31', limit: 2 })) as any).payload;
    assert.equal(soqlSeen(vendor)[0], "SELECT Id, Name, Account.Name, AccountId, StageName, Amount, CloseDate, Owner.Name, NextStep, LeadSource FROM Opportunity WHERE IsClosed = false AND Owner.Name LIKE '%Jess%' AND CloseDate <= 2026-12-31 ORDER BY CloseDate ASC LIMIT 2");
    assert.equal(open.amountOfThese, 6712.25);
    assert.deepEqual(open.records[0], { opportunityId: '006i80000023uuEAAQ', name: 'Ngata: Shed [OPP-0006]', account: 'Ngata Ltd', accountId: ACCOUNT, stage: 'Propose', amount: 6612, closeDate: '2026-11-01', owner: 'Jess Penrose', nextStep: 'Send the quote', source: 'Web' });
    await call('list_opportunities', { stage: 'won' });
    await call('list_opportunities', { stage: 'lost', accountId: ACCOUNT });
    await call('list_opportunities', { stage: 'Negotiate' });
    const sent = soqlSeen(vendor);
    assert.match(sent[1]!, /WHERE IsWon = true ORDER BY CloseDate DESC/);
    assert.match(sent[2]!, new RegExp(`WHERE AccountId = '${ACCOUNT}' AND IsClosed = true AND IsWon = false ORDER BY CloseDate DESC`));
    assert.match(sent[3]!, /WHERE StageName = 'Negotiate' ORDER BY CloseDate ASC/);
    const count = vendor.seen.length;
    const refused: any = await call('list_opportunities', { closingAfter: "2026-10-01' OR Amount > 0" });
    assert.equal(refused.payload.error.code, 'invalid_arguments');
    assert.equal(vendor.seen.length, count, 'nothing was sent');
    await vendor.close();
  });

  await t.test('get_opportunity finds a deal by its number or id and shows its products at the tier price, its contact, and the latest calls and meetings', async () => {
    const { vendor, call } = await setup({}, salesOrg);
    const byNumber = ((await call('get_opportunity', { dealNumber: 'OPP-0001' })) as any).payload.record;
    assert.match(soqlSeen(vendor)[0]!, /FROM Opportunity WHERE Name LIKE '%\[OPP-0001\]%' LIMIT 1$/);
    assert.deepEqual(byNumber.products, [{ name: 'Pool Gate Post', sku: '2910018', quantity: 3, unitPrice: 123.5, total: 370.5 }]);
    assert.equal(byNumber.priceBook, 'Silver trade');
    assert.equal(byNumber.contact, 'Tessa Thornbury');
    assert.deepEqual(byNumber.tasks, [{ subject: 'Thank you call', status: 'Completed', due: '2026-10-23' }]);
    assert.deepEqual(byNumber.meetings, [{ subject: 'Site visit', start: '2026-10-20T09:00:00.000+0000', where: 'Hamilton' }]);
    assert.equal(byNumber.owner, 'Hemi Ashworth');
    await call('get_opportunity', { opportunityId: '006i80000023uu9AAA' });
    assert.match(soqlSeen(vendor)[1]!, /WHERE Id = '006i80000023uu9AAA' LIMIT 1$/);
    assert.equal(((await call('get_opportunity', {})) as any).payload.error.code, 'invalid_arguments');
    assert.equal(((await call('get_opportunity', { dealNumber: "OPP-1'] OR Name != ['" })) as any).payload.error.code, 'invalid_arguments');
    const empty = await setup({}, (request) => (request.path.endsWith('/query') ? { json: { totalSize: 0, records: [] } } : undefined));
    assert.equal(((await empty.call('get_opportunity', { dealNumber: 'OPP-9999' })) as any).payload.error.code, 'not_found');
    await vendor.close(); await empty.vendor.close();
  });

  await t.test('pipeline_summary gives each stage in order with the open, won and lost totals, or each rep\'s open and won deals', async () => {
    const { vendor, call } = await setup({}, salesOrg);
    const byStage = ((await call('pipeline_summary', {})) as any).payload;
    assert.deepEqual(byStage.stages.map((entry: any) => entry.stage), ['Qualify', 'Meet & Present', 'Propose', 'Negotiate', 'Closed Won', 'Closed Lost']);
    assert.deepEqual(byStage.stages[1], { stage: 'Meet & Present', deals: 0, amount: 0 }, 'a stage with no deals still shows');
    assert.deepEqual(byStage.open, { deals: 17, amount: 64208.71 });
    assert.deepEqual(byStage.won, { deals: 6, amount: 38787.95 });
    assert.deepEqual(byStage.lost, { deals: 0, amount: 0 });
    const byRep = ((await call('pipeline_summary', { groupBy: 'rep' })) as any).payload;
    assert.deepEqual(byRep.reps, [{ rep: 'Jess Penrose', openDeals: 5, openAmount: 27612.09, wonDeals: 0, wonAmount: 0 }, { rep: 'Hemi Ashworth', openDeals: 3, openAmount: 14639.3, wonDeals: 2, wonAmount: 5103.25 }]);
    await vendor.close();
  });

  await t.test('list_campaigns and get_campaign show a campaign with its brief, its channels, who answered, and the deals of the accounts that answered', async () => {
    const { vendor, call } = await setup({}, salesOrg);
    const list = ((await call('list_campaigns', { query: 'spring', status: 'In Progress', type: 'Other' })) as any).payload;
    assert.match(soqlSeen(vendor)[0]!, /FROM Campaign WHERE Name LIKE '%spring%' AND Status = 'In Progress' AND Type = 'Other' ORDER BY StartDate ASC, Name ASC LIMIT 10$/);
    assert.equal(list.records[0].brief, 'Launch brief');
    assert.equal(list.records[0].budget, 38500);
    const one = ((await call('get_campaign', { campaign: 'Spring Outdoor' })) as any).payload.record;
    assert.equal(one.name, 'Spring Outdoor Living 2026');
    assert.deepEqual(one.brief, { name: 'Launch brief', keyMessage: 'Everything for the deck.', targetAudience: 'Builders.', about: 'We are launching 12 products.', notes: 'Range list.' });
    assert.deepEqual(one.members, { Sent: 3, Responded: 15 });
    assert.equal(one.channels[0].name, 'Trade night');
    assert.deepEqual(one.responders, [{ campaign: 'Trade night', name: 'Tessa Thornbury', company: 'Talbot & Nguyen Concrete Ltd', kind: 'contact' }, { campaign: 'Trade night', name: 'Emma Cooper', company: 'Coastal Homes Ltd', kind: 'lead' }]);
    assert.deepEqual(one.pipelineOfResponders, { accountsThatResponded: 2, openDeals: { deals: 2, amount: 3000.5 }, wonDeals: { deals: 1, amount: 1849.5 } });
    const sent = soqlSeen(vendor).join('\n');
    assert.match(sent, /FROM Campaign WHERE Name LIKE '%Spring Outdoor%' ORDER BY ParentId NULLS FIRST/);
    assert.match(sent, /CampaignId IN \('701i8000008UylLAAS', '701i8000008V7IMAA0'\)/, 'the channels count with their campaign');
    const byId = await setup({}, salesOrg);
    await byId.call('get_campaign', { campaign: '701i8000008UylLAAS' });
    assert.match(soqlSeen(byId.vendor)[0]!, /WHERE Id = '701i8000008UylLAAS' ORDER BY/);
    const missing = await setup({}, (request) => (request.path.endsWith('/query') ? { json: { totalSize: 0, records: [] } } : undefined));
    assert.equal(((await missing.call('get_campaign', { campaign: 'nothing here' })) as any).payload.error.code, 'not_found');
    assert.equal(((await call('list_campaigns', { status: 'Dead' })) as any).payload.error.code, 'invalid_arguments');
    await vendor.close(); await byId.vendor.close(); await missing.vendor.close();
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
