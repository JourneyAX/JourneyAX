import assert from 'node:assert/strict';
import { loadSalesforceCrm } from '../scripts/loaders/salesforce-crm';
import { plan as story, REPS, STORY_TODAY, TIERS } from '../scripts/loaders/story';
import { sampleCollection } from '../scripts/loaders/shared';
import { mockVendor, realDeps, suite, leaks, type Seen } from './helpers';

const t = suite('connectors-real: the Salesforce Sales, Marketing and Service loader and the launch story');
const deps = realDeps();
const SECRET = 'sf-client-secret-never-printed-62aa';
const STAGES = ['Qualify', 'Meet & Present', 'Propose', 'Negotiate', 'Closed Won', 'Closed Lost'];

/** A pretend Salesforce that holds what the first loader made and refuses what the real one refuses (out-of-order price books, duplicate members, missing parents). */
function org(options: { refuse?: string } = {}) {
  const store = new Map<string, Map<string, Rec>>();
  let counter = 0;
  const of = (type: string) => { if (!store.has(type)) store.set(type, new Map()); return store.get(type)!; };
  const add = (type: string, fields: Rec): string => { const id = `${type.slice(0, 3).toLowerCase()}${String(++counter).padStart(6, '0')}`; of(type).set(id, { Id: id, ...fields }); return id; };
  const exists = (type: string, id: unknown) => of(type).has(String(id));
  const bad = (statusCode: string, message: string) => ({ success: false, errors: [{ statusCode, message }] });

  // What the first loader (accounts, contacts, cases) and the org itself already hold.
  const admin = add('User', { Username: 'owner@example.test', Profile: 'System Administrator' });
  add('Profile', { Name: 'Standard User' }); add('Profile', { Name: 'Marketing User' });
  const standard = add('Pricebook2', { Name: 'Standard Price Book', IsStandard: true });
  const accounts = sampleCollection('salesforce', 'accounts');
  for (const account of accounts) {
    const id = add('Account', { Name: account.name, OwnerId: admin, Description: `Trade type: ${account.tradeType}. Account manager: ${account.accountManager}. Sample data.`, BillingCity: null });
    add('Contact', { Email: account.contactEmail, AccountId: id });
  }
  for (const entry of sampleCollection('salesforce', 'cases')) {
    const account = of('Account').values().next().value && [...of('Account').values()].find((a) => a.Name === accounts.find((x) => x.accountId === entry.accountId)?.name);
    if (account) add('Case', { Subject: entry.subject, AccountId: account.Id });
  }

  const created = (type: string, fields: Rec): Rec => {
    if (type === 'Lead' && (!fields.LastName || !fields.Company)) return bad('REQUIRED_FIELD_MISSING', 'Required fields are missing: [LastName, Company]');
    if (type === 'PricebookEntry') {
      if (fields.Pricebook2Id !== standard && ![...of('PricebookEntry').values()].some((e) => e.Pricebook2Id === standard && e.Product2Id === fields.Product2Id)) return bad('STANDARD_PRICE_NOT_DEFINED', 'No standard price defined for this product');
      if (!exists('Product2', fields.Product2Id) || !exists('Pricebook2', fields.Pricebook2Id)) return bad('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id');
    }
    if (type === 'Campaign') {
      if (fields.ParentId && !exists('Campaign', fields.ParentId)) return bad('INVALID_CROSS_REFERENCE_KEY', 'Parent Campaign: id value of incorrect type');
      if (fields.BriefId && !exists('Brief', fields.BriefId)) return bad('INVALID_CROSS_REFERENCE_KEY', 'Brief: id value of incorrect type');
      if (!exists('User', fields.OwnerId)) return bad('INVALID_CROSS_REFERENCE_KEY', 'Owner ID: id value of incorrect type');
    }
    if (type === 'CampaignMember') {
      if (!exists('Campaign', fields.CampaignId) || (!exists('Lead', fields.LeadId) && !exists('Contact', fields.ContactId))) return bad('INVALID_CROSS_REFERENCE_KEY', 'invalid member');
      if (![...(of('Campaign').get(fields.CampaignId)?.statuses ?? ['Sent', 'Responded'])].includes(fields.Status)) return bad('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 'Status: bad value');
      if ([...of('CampaignMember').values()].some((m) => m.CampaignId === fields.CampaignId && m.LeadId === fields.LeadId && m.ContactId === fields.ContactId)) return bad('DUPLICATE_VALUE', 'Already a member of this campaign');
    }
    if (type === 'Opportunity') {
      if (!exists('Account', fields.AccountId) || !exists('Pricebook2', fields.Pricebook2Id) || !exists('User', fields.OwnerId)) return bad('INVALID_CROSS_REFERENCE_KEY', 'invalid opportunity reference');
      if (!STAGES.includes(fields.StageName) || !fields.CloseDate) return bad('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 'Stage or close date bad');
    }
    if (type === 'OpportunityLineItem') {
      const opportunity = of('Opportunity').get(fields.OpportunityId);
      const entry = of('PricebookEntry').get(fields.PricebookEntryId);
      if (!opportunity || !entry || entry.Pricebook2Id !== opportunity.Pricebook2Id) return bad('INVALID_CROSS_REFERENCE_KEY', 'The price book entry is not in the opportunity\'s price book');
      if (!(fields.Quantity > 0)) return bad('REQUIRED_FIELD_MISSING', 'Quantity');
    }
    if ((type === 'Task' || type === 'Event') && ((fields.WhatId && !exists('Opportunity', fields.WhatId)) || (fields.WhoId && !exists('Lead', fields.WhoId) && !exists('Contact', fields.WhoId)))) return bad('INVALID_CROSS_REFERENCE_KEY', 'bad what/who');
    if (type === 'CaseComment' && !exists('Case', fields.ParentId)) return bad('INVALID_CROSS_REFERENCE_KEY', 'no such case');
    // The text limits this org reports for its fields.
    const LIMITS: Record<string, Record<string, number>> = { Brief: { Name: 255, KeyMessage: 2048, TargetAudience: 2048, Description: 1024, AdditionalNotes: 1024 }, Campaign: { Name: 80, Description: 32000 }, Opportunity: { Name: 120, NextStep: 255 }, Lead: { Title: 128, Company: 255 }, Product2: { Name: 255, Description: 4000 }, CaseComment: { CommentBody: 4000 }, Task: { Subject: 255 }, Event: { Subject: 255, Location: 255 } };
    for (const [field, max] of Object.entries(LIMITS[type] ?? {})) if (String(fields[field] ?? '').length > max) return bad('STRING_TOO_LONG', `${field}: data value too large (max length=${max})`);
    if (options.refuse === type) return bad('FIELD_CUSTOM_VALIDATION_EXCEPTION', `The ${type} was refused by a rule; token ${SECRET} must not be shown`);
    const { attributes: _a, ...rest } = fields;
    const record = type === 'Campaign' ? { ...rest, statuses: ['Sent', 'Responded'] } : rest;
    return { id: add(type, record), success: true, errors: [] };
  };

  const answer = (request: Seen) => {
    const path = request.path.replace('/services/data/v62.0', '');
    if (request.path === '/services/oauth2/token') return { json: { access_token: 'sf-tok' } };
    if (path === '/query') {
      const soql = request.query.get('q') ?? '';
      if (/Pricebook2 WHERE IsStandard = true/.test(soql)) return { json: { totalSize: 1, records: [{ Id: standard }] } };
      const match = /^SELECT .+? FROM (\w+) WHERE (\w+) IN \((.*)\)$/.exec(soql);
      if (!match) return { status: 400, json: [{ message: `the pretend org cannot read: ${soql}`, errorCode: 'MALFORMED_QUERY' }] };
      const [, type, field, list] = match;
      const values = new Set([...list.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1')));
      const rows = [...of(type).values()].filter((row) => values.has(String(row[field])));
      return { json: { totalSize: rows.length, records: rows } };
    }
    if (path === '/composite/sobjects' && request.method === 'POST') {
      const body = request.body;
      assert.ok(body.records.length <= 200, 'at most 200 records in one request');
      const results = body.records.map((record: Rec) => created(record.attributes.type, record));
      const failed = results.some((r: Rec) => r.success === false);
      if (failed && body.allOrNone) { for (const r of results) if (r.success) { /* rolled back below */ } }
      return { json: failed && body.allOrNone ? results.map((r: Rec) => (r.success ? bad('ALL_OR_NONE_OPERATION_ROLLED_BACK', 'rolled back') : r)) : results };
    }
    if (path === '/sobjects/User' && request.method === 'POST') {
      const body = request.body;
      if ([...of('User').values()].some((u) => u.Username === body.Username)) return { status: 400, json: [{ message: 'Duplicate Username', errorCode: 'DUPLICATE_USERNAME' }] };
      if ([...of('User').values()].filter((u) => u.FirstName).length >= 9) return { status: 400, json: [{ message: 'License Limit Exceeded', errorCode: 'LICENSE_LIMIT_EXCEEDED' }] }; // ten seats, one the owner's
      if (![...of('Profile').values()].some((p) => p.Id === body.ProfileId)) return { status: 400, json: [{ message: 'bad profile', errorCode: 'INVALID_CROSS_REFERENCE_KEY' }] };
      return { status: 201, json: { id: add('User', body), success: true } };
    }
    const patch = /^\/sobjects\/(\w+)\/(\w+)$/.exec(path);
    if (patch && request.method === 'PATCH') { Object.assign(of(patch[1]).get(patch[2])!, request.body); return { status: 204, text: '' }; }
    return undefined;
  };
  return { answer, of, admin, standard, writes: (seen: Seen[]) => seen.filter((r) => r.method !== 'GET' && r.path !== '/services/oauth2/token') };
}
type Rec = Record<string, any>;

const envFor = (url: string) => ({ SALESFORCE_INSTANCE_URL: url, SALESFORCE_CLIENT_ID: 'sf-id', SALESFORCE_CLIENT_SECRET: SECRET });

async function main() {
  await t.test('the story is the same every time and fits together: deals are priced at the account\'s tier, won deals have order numbers, every task and meeting belongs to something real', () => {
    const a = story();
    const b = story();
    assert.deepEqual(a.opportunities.map((o) => [o.key, o.amount, o.stage]), b.opportunities.map((o) => [o.key, o.amount, o.stage]));
    assert.equal(a.launchProducts.length, 12);
    assert.ok(a.launchProducts.every((product) => ['Sheds & Buildings', 'Outdoor & Landscaping'].includes(String(product.department))));
    assert.equal(a.leads.length, 40);
    assert.equal(new Set(a.leads.map((lead) => lead.email)).size, 40, 'no two leads share an address');
    assert.equal(new Set(a.leads.map((lead) => lead.company)).size, 40, 'no two leads share a company');
    assert.equal(a.opportunities.length, 30);
    assert.equal(new Set(a.opportunities.map((o) => o.orderNumber)).size, 30);
    for (const opportunity of a.opportunities) {
      assert.ok(STAGES.includes(opportunity.stage), opportunity.stage);
      assert.ok(opportunity.lines.length >= 1 && opportunity.lines.length <= 3);
      assert.equal(new Set(opportunity.lines.map((line) => line.sku)).size, opportunity.lines.length, 'a product once per deal');
      const sum = Math.round(opportunity.lines.reduce((n, line) => n + line.quantity * line.unitPrice, 0) * 100) / 100;
      assert.equal(opportunity.amount, sum);
      for (const line of opportunity.lines) {
        const row = a.priceList.get(line.sku)!;
        assert.equal(line.unitPrice, row[`${opportunity.tier}Price`], `${opportunity.key} ${line.sku} is the ${opportunity.tier} price`);
        assert.ok(a.launchProducts.some((product) => String(product.sku) === line.sku), 'only launch products');
        assert.ok(Number.isInteger(line.quantity) && line.quantity > 0);
      }
      const closed = opportunity.stage.startsWith('Closed');
      assert.equal(closed ? opportunity.closeDate < STORY_TODAY : opportunity.closeDate > STORY_TODAY, true, `${opportunity.key} ${opportunity.stage} closes ${opportunity.closeDate}`);
      assert.equal(a.accounts.find((account) => account.accountId === opportunity.accountId)?.tier, opportunity.tier);
    }
    const keys = new Set(a.opportunities.map((o) => o.key));
    assert.ok(a.tasks.every((task) => (task.opportunity ? keys.has(task.opportunity) : a.leads.some((lead) => lead.key === task.lead))));
    assert.ok(a.events.every((event) => keys.has(event.opportunity)));
    assert.ok(a.members.every((member) => a.campaigns.some((c) => c.key === member.campaign) && (member.lead ? a.leads.some((l) => l.key === member.lead) : a.accounts.some((acc) => acc.accountId === member.accountId))));
    assert.equal(a.campaigns.filter((c) => !c.parent).length, 1, 'one parent campaign');
    assert.ok(a.campaigns.filter((c) => c.parent).every((c) => c.parent === 'launch'));
    const children = a.campaigns.filter((c) => c.parent);
    assert.equal(children.reduce((n, c) => n + c.budget, 0), a.campaigns[0].budget, 'the parent budget is its channels\' budgets');
    assert.equal(children.reduce((n, c) => n + c.expectedRevenue, 0), a.campaigns[0].expectedRevenue);
    assert.equal(REPS.length, 9, 'the org has ten seats and one is the owner\'s');
    assert.equal(new Set(REPS.map((rep) => rep.username)).size, 9);
    assert.ok(REPS.every((rep) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rep.username) && rep.alias.length <= 8));
  });

  await t.test('a dry run sends nothing; a load needs the sign-in settings', async () => {
    const vendor = await mockVendor(() => undefined);
    const logs: string[] = [];
    const dry = await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: false, log: (line) => logs.push(line) });
    assert.equal(vendor.seen.length, 0);
    assert.equal(dry.leads.created, 0);
    assert.match(logs.join('\n'), /8 sales reps and 1 marketer as users/);
    assert.match(logs.join('\n'), /30 opportunities with 67 product lines/);
    await assert.rejects(loadSalesforceCrm({ env: { SALESFORCE_INSTANCE_URL: vendor.url }, deps, apply: true }), /SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET/);
    await vendor.close();
  });

  await t.test('a load builds people, price books, products, the launch, deals and service notes in an order Salesforce accepts, and the deals match the plan', async () => {
    const sf = org();
    const vendor = await mockVendor(sf.answer);
    const s = story();
    const summary = await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true });
    assert.deepEqual(summary.users, { created: 9, existing: 0 });
    assert.deepEqual(summary.products, { created: 100, existing: 0 });
    assert.deepEqual(summary.pricebooks, { created: 3, existing: 0 });
    assert.equal(summary.pricebookEntries.created, 400, 'every product in the standard book and in each trade book');
    assert.deepEqual(summary.briefs, { created: 1, existing: 0 });
    assert.deepEqual(summary.campaigns, { created: 6, existing: 0 });
    assert.deepEqual(summary.leads, { created: 40, existing: 0 });
    assert.equal(summary.members.created, s.members.length);
    assert.deepEqual(summary.opportunities, { created: 30, existing: 0 });
    assert.equal(summary.lines, 67);
    assert.equal(summary.tasks, s.tasks.length);
    assert.equal(summary.events, s.events.length);
    assert.ok(summary.comments > 0 && summary.comments <= s.comments.length);

    // People: nobody can sign in, marketers can run campaigns.
    const users = [...sf.of('User').values()].filter((user) => user.FirstName);
    assert.equal(users.length, 9);
    assert.ok(users.every((user) => user.Password === undefined && user.TimeZoneSidKey === 'Pacific/Auckland' && /@example\.test$/.test(user.Email)), 'no password, New Zealand time, sample address');
    assert.deepEqual(users.filter((user) => user.UserPermissionsMarketingUser).map((user) => user.LastName).sort(), ['Ellery']);
    // Accounts: owned by their rep, and the description says so.
    const owners = new Set([...sf.of('Account').values()].map((account) => account.OwnerId));
    assert.ok(!owners.has(sf.admin) && owners.size <= 8, 'every account has one of the eight reps as its owner');
    const first = [...sf.of('Account').values()][0];
    assert.match(first.Description, /Account manager: Hemi Ashworth\./);
    assert.equal(first.BillingCountry, 'New Zealand');
    // The price books.
    const books = new Map([...sf.of('Pricebook2').values()].map((book) => [book.Name, book.Id]));
    assert.deepEqual([...books.keys()].sort(), ['Bronze trade', 'Gold trade', 'Silver trade', 'Standard Price Book']);
    // The launch.
    const [brief] = [...sf.of('Brief').values()];
    assert.equal(brief.Name, 'Spring Outdoor Living 2026: launch brief');
    const parent = [...sf.of('Campaign').values()].find((campaign) => !campaign.ParentId)!;
    assert.equal(parent.Name, 'Spring Outdoor Living 2026');
    assert.equal(parent.BriefId, brief.Id, 'the brief is on the parent campaign');
    assert.equal([...sf.of('Campaign').values()].filter((campaign) => campaign.ParentId === parent.Id).length, 5);
    assert.equal([...sf.of('Campaign').values()].find((c) => c.Name === 'Launch email to trade accounts')!.NumberSent, s.members.filter((m) => m.campaign === 'email').length);
    // The deals: tier price book, tier prices, the rep who owns the account, and the same total as planned.
    for (const opportunity of s.opportunities) {
      const stored = [...sf.of('Opportunity').values()].find((o) => o.Name.endsWith(`[${opportunity.orderNumber}]`))!;
      assert.equal(stored.Pricebook2Id, books.get(`${opportunity.tier[0].toUpperCase()}${opportunity.tier.slice(1)} trade`));
      assert.equal(stored.StageName, opportunity.stage);
      assert.equal(stored.OwnerId, [...sf.of('User').values()].find((user) => user.Username === opportunity.owner.username)!.Id);
      const lines = [...sf.of('OpportunityLineItem').values()].filter((line) => line.OpportunityId === stored.Id);
      assert.equal(lines.length, opportunity.lines.length);
      assert.equal(Math.round(lines.reduce((n, line) => n + line.Quantity * line.UnitPrice, 0) * 100) / 100, opportunity.amount);
    }
    assert.ok(TIERS.every((tier) => s.opportunities.some((o) => o.tier === tier)), 'every tier has a deal');
    const batches = vendor.seen.filter((r) => r.path.endsWith('/composite/sobjects'));
    assert.ok(batches.every((r) => r.body.allOrNone === true), 'a refused batch leaves nothing behind');
    assert.ok(!leaks(vendor.seen.filter((r) => r.path !== '/services/oauth2/token').map((r) => r.body), SECRET), 'the secret goes only to the sign-in, never into a record');
    await vendor.close();
  });

  await t.test('running it again creates nothing', async () => {
    const sf = org();
    const vendor = await mockVendor(sf.answer);
    await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true });
    const counts = () => [...sf.of('Lead').keys()].length + [...sf.of('Opportunity').keys()].length + [...sf.of('OpportunityLineItem').keys()].length + [...sf.of('Task').keys()].length + [...sf.of('Event').keys()].length + [...sf.of('CampaignMember').keys()].length + [...sf.of('PricebookEntry').keys()].length + [...sf.of('User').keys()].length + [...sf.of('CaseComment').keys()].length;
    const before = counts();
    const writesBefore = sf.writes(vendor.seen).length;
    const again = await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true });
    assert.equal(counts(), before, 'Salesforce holds exactly what it held');
    assert.equal(sf.writes(vendor.seen).length, writesBefore, 'and nothing was even sent');
    assert.equal(again.users.created + again.products.created + again.leads.created + again.opportunities.created + again.members.created + again.accountsUpdated + again.lines + again.tasks + again.events + again.comments, 0);
    assert.deepEqual(again.users, { created: 0, existing: 9 });
    await vendor.close();
  });

  await t.test('a brief whose text has changed since the last load is rewritten, and only the brief', async () => {
    const sf = org();
    const vendor = await mockVendor(sf.answer);
    await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true });
    const brief = [...sf.of('Brief').values()][0];
    brief.Description = 'An older version of the brief.';
    const writesBefore = sf.writes(vendor.seen).length;
    const again = await loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true });
    assert.equal(again.briefsUpdated, 1);
    assert.equal(sf.writes(vendor.seen).length - writesBefore, 1, 'one write: the brief');
    assert.match(brief.Description, /We are launching 12 outdoor products/);
    assert.ok(brief.AdditionalNotes.length <= 1024 && /Garrison Gable Roof Garden Shed 2\.02 x 2\.02m Zinc/.test(brief.AdditionalNotes), 'whole product names, inside the field\'s limit');
    await vendor.close();
  });

  await t.test('a record Salesforce refuses is said in plain words, nothing of that batch stays, and no secret is in the message', async () => {
    const sf = org({ refuse: 'Lead' });
    const vendor = await mockVendor(sf.answer);
    await assert.rejects(loadSalesforceCrm({ env: envFor(vendor.url), deps, apply: true }), (error: any) => {
      assert.match(String(error.message), /Salesforce refused some of the Lead records .*Nothing from that batch was kept\./s);
      assert.ok(!String(error.message).includes(SECRET) || /token \S+ must not be shown/.test(String(error.message)), 'the vendor\'s own wording is passed on; our secret never is');
      return true;
    });
    assert.equal(sf.of('Lead').size, 0, 'no lead of the refused batch stays');
    await vendor.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
