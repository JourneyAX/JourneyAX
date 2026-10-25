/**
 * Fills the Sales, Marketing and Service sides of a Salesforce org with the PlaceMakers launch story (see story.ts), on top of the trade
 * accounts, contacts and cases that loaders/salesforce.ts already made:
 *
 *   people     eight sales reps and one marketer as real (login-less) users; the thirty accounts are shared out among the reps
 *   products   the catalogue as products, in the standard price book and in a Bronze / Silver / Gold trade price book each
 *   marketing  a launch brief, the "Spring Outdoor Living 2026" campaign with five channels, forty leads, and who was sent / answered what
 *   sales      opportunities for the trade accounts with the launch products on them at the account's tier price, and the calls and meetings
 *   service    comments on the cases that are being worked or are done
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/salesforce-crm.ts [--apply]
 *
 * A dry run (the default) says what it would do and sends nothing. Running it again creates only what is missing. Everything is sample data
 * (example.test addresses); the users cannot sign in (they have no password) and can be deactivated in Setup. The org's currency is shown on the
 * amounts, and the numbers are New Zealand dollars. No Salesforce field is added or changed, and nothing is deleted.
 */
import type { Deps, Env, Rec } from '../../src/types';
import { must } from './shared';
import { signIn } from './salesforce';
import { plan, repFor, REPS, TIERS, type Rep } from './story';

const SYSTEM = 'Salesforce';
const lit = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const chunks = <T>(list: T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
const trim = (text: unknown, max: number) => String(text ?? '').slice(0, max);

export interface Tally { created: number; existing: number }
const tally = (): Tally => ({ created: 0, existing: 0 });
export interface CrmSummary {
  users: Tally; accountsUpdated: number; briefsUpdated: number; products: Tally; pricebooks: Tally; pricebookEntries: Tally; briefs: Tally; campaigns: Tally; leads: Tally;
  members: Tally; opportunities: Tally; lines: number; tasks: number; events: number; comments: number;
}

export async function loadSalesforceCrm(options: { env: Env; deps: Deps; apply: boolean; log?: (line: string) => void }): Promise<CrmSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  const story = plan();
  const summary: CrmSummary = { users: tally(), accountsUpdated: 0, briefsUpdated: 0, products: tally(), pricebooks: tally(), pricebookEntries: tally(), briefs: tally(), campaigns: tally(), leads: tally(), members: tally(), opportunities: tally(), lines: 0, tasks: 0, events: 0, comments: 0 };
  const linesPlanned = story.opportunities.reduce((sum, opportunity) => sum + opportunity.lines.length, 0);
  log(`${apply ? 'Loading' : 'Dry run. Would load'} into Salesforce:`);
  const marketers = REPS.filter((r) => r.role === 'marketing').length;
  log(`  people: ${REPS.filter((r) => r.role === 'sales').length} sales reps and ${marketers} marketer${marketers === 1 ? '' : 's'} as users; the ${story.accounts.length} accounts shared out among the reps`);
  log(`  products: ${story.products.length} in the standard price book and in ${TIERS.length} trade price books (${TIERS.join(', ')}), ${story.launchProducts.length} of them the launch range`);
  log(`  marketing: 1 brief, ${story.campaigns.length} campaigns, ${story.leads.length} leads, ${story.members.length} campaign members`);
  log(`  sales: ${story.opportunities.length} opportunities with ${linesPlanned} product lines, ${story.tasks.length} tasks and ${story.events.length} meetings`);
  log(`  service: ${story.comments.length} comments on cases`);
  if (!apply) return summary;

  const { base, headers, secrets, query } = await signIn(env, deps);
  const call = (method: string, path: string, body?: unknown, accept: number[] = []) => must(deps, SYSTEM, secrets, method, `${base}${path}`, { headers, ...(body !== undefined ? { body } : {}) }, accept);

  const find = async (soql: string): Promise<Rec[]> => query(soql);
  const inList = (values: string[]) => `(${values.map(lit).join(', ')})`;
  /** Rows of `type` whose `field` is one of `values`, a few at a time so the query stays short. */
  const lookup = async (select: string, type: string, field: string, values: string[]): Promise<Rec[]> => {
    const rows: Rec[] = [];
    for (const part of chunks([...new Set(values)], 40)) rows.push(...await find(`SELECT ${select} FROM ${type} WHERE ${field} IN ${inList(part)}`));
    return rows;
  };
  /** Creates records in batches of 200 and gives back their ids in the same order. A refusal is said in plain words and nothing of that batch stays. */
  const createMany = async (type: string, records: Rec[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const part of chunks(records, 200)) {
      const answer = await call('POST', '/composite/sobjects', { allOrNone: true, records: part.map((record) => ({ attributes: { type }, ...record })) });
      const results: Rec[] = Array.isArray(answer.json) ? answer.json : [];
      const failed = results.find((result) => result.success === false && !/ROLLED_BACK/.test(String(result.errors?.[0]?.statusCode)));
      if (failed || results.length !== part.length) {
        throw new Error(`${SYSTEM} refused some of the ${type} records${failed?.errors?.[0]?.message ? ` (${trim(failed.errors[0].message, 220)})` : ''}. Nothing from that batch was kept.`);
      }
      ids.push(...results.map((result) => String(result.id)));
    }
    return ids;
  };
  /** Ensures a record exists for each key: finds the ones that are there, creates the rest, and gives back key -> id for all of them. */
  const ensure = async (type: string, keyField: string, keys: string[], make: (key: string) => Rec, into: Tally): Promise<Map<string, string>> => {
    const byKey = new Map<string, string>();
    for (const row of await lookup(`Id, ${keyField}`, type, keyField, keys)) byKey.set(String(row[keyField]), String(row.Id));
    const missing = keys.filter((key) => !byKey.has(key));
    const ids = await createMany(type, missing.map(make));
    missing.forEach((key, i) => byKey.set(key, ids[i]));
    into.existing += keys.length - missing.length;
    into.created += missing.length;
    return byKey;
  };

  // 1. People: users with no password, so nobody can sign in as them, but they can own accounts, deals and campaigns.
  const profiles = new Map((await find(`SELECT Id, Name FROM Profile WHERE Name IN ('Standard User', 'Marketing User')`)).map((row) => [String(row.Name), String(row.Id)]));
  const userIds = new Map<string, string>();
  for (const row of await lookup('Id, Username', 'User', 'Username', REPS.map((rep) => rep.username))) userIds.set(String(row.Username), String(row.Id));
  for (const rep of REPS) {
    if (userIds.has(rep.username)) { summary.users.existing++; continue; }
    const profileId = profiles.get(rep.role === 'marketing' ? 'Marketing User' : 'Standard User');
    if (!profileId) throw new Error(`${SYSTEM} has no "${rep.role === 'marketing' ? 'Marketing User' : 'Standard User'}" profile to give ${rep.name}.`);
    const made = await call('POST', '/sobjects/User', {
      Username: rep.username, FirstName: rep.firstName, LastName: rep.lastName, Email: rep.email, Alias: rep.alias, CommunityNickname: rep.nickname, ProfileId: profileId,
      Title: rep.role === 'marketing' ? 'Marketing' : 'Trade Sales Representative', TimeZoneSidKey: 'Pacific/Auckland', LocaleSidKey: 'en_NZ', EmailEncodingKey: 'UTF-8', LanguageLocaleKey: 'en_US',
      ...(rep.role === 'marketing' ? { UserPermissionsMarketingUser: true } : {}),
    });
    userIds.set(rep.username, String(made.json?.id));
    summary.users.created++;
  }
  const idOf = (rep: Rep) => userIds.get(rep.username)!;
  log(`People: ${summary.users.created} users created, ${summary.users.existing} already there.`);

  // 2. The accounts and their contacts and cases, which the first loader made: who owns each account now.
  const accountRows = await lookup('Id, Name, OwnerId, Description, BillingCity', 'Account', 'Name', story.accounts.map((account) => String(account.name)));
  const accountId = new Map(accountRows.map((row) => [String(row.Name), String(row.Id)]));
  const idByAccount = new Map<string, string>(); // sample account id (ACC-0001) -> Salesforce id
  story.accounts.forEach((account) => { const id = accountId.get(String(account.name)); if (id) idByAccount.set(String(account.accountId), id); });
  if (idByAccount.size < story.accounts.length) throw new Error(`${SYSTEM} is missing ${story.accounts.length - idByAccount.size} of the trade accounts. Run loaders/salesforce.ts first.`);
  for (const [index, account] of story.accounts.entries()) {
    const row = accountRows.find((entry) => String(entry.Name) === String(account.name))!;
    const rep = repFor(account, index);
    const description = String(row.Description ?? '').replace(/Account manager: [^.]+\./, `Account manager: ${rep.name}.`);
    const change: Rec = {
      ...(row.OwnerId !== idOf(rep) ? { OwnerId: idOf(rep) } : {}),
      ...(description !== String(row.Description ?? '') ? { Description: description } : {}),
      ...(!row.BillingCity ? { BillingCity: story.cityOf(account.homeBranchCode), BillingCountry: 'New Zealand' } : {}),
    };
    if (Object.keys(change).length) { await call('PATCH', `/sobjects/Account/${String(row.Id)}`, change, [204]); summary.accountsUpdated++; }
  }
  log(`Accounts: ${summary.accountsUpdated} updated with their rep as owner and their town.`);
  const contacts = await lookup('Id, Email, AccountId', 'Contact', 'Email', story.accounts.map((account) => String(account.contactEmail)));
  const contactByAccount = new Map<string, string>(); // sample account id -> contact id
  for (const account of story.accounts) { const row = contacts.find((c) => String(c.Email) === String(account.contactEmail)); if (row) contactByAccount.set(String(account.accountId), String(row.Id)); }

  // 3. Products and the price books they are sold from.
  const standard = String((await find('SELECT Id FROM Pricebook2 WHERE IsStandard = true'))[0]?.Id ?? '');
  if (!standard) throw new Error(`${SYSTEM} has no standard price book.`);
  const productIds = await ensure('Product2', 'ProductCode', story.products.map((product) => String(product.sku)), (sku) => {
    const product = story.products.find((p) => String(p.sku) === sku)!;
    return { Name: trim(product.title, 255), ProductCode: sku, StockKeepingUnit: sku, Description: trim(product.description, 2000), Family: trim(product.department, 40), IsActive: true };
  }, summary.products);
  const bookNames = TIERS.map((tier) => `${tier[0].toUpperCase()}${tier.slice(1)} trade`);
  const bookIds = await ensure('Pricebook2', 'Name', bookNames, (name) => ({ Name: name, IsActive: true, Description: `Trade prices for ${name.split(' ')[0]} accounts.` }), summary.pricebooks);
  const books: Array<{ id: string; tier?: (typeof TIERS)[number] }> = [{ id: standard }, ...TIERS.map((tier, i) => ({ id: bookIds.get(bookNames[i])!, tier }))];
  const have = new Set((await lookup('Product2Id, Pricebook2Id', 'PricebookEntry', 'Pricebook2Id', books.map((book) => book.id))).map((row) => `${row.Pricebook2Id}|${row.Product2Id}`));
  const entriesFor = (book: (typeof books)[number]): Rec[] => story.products.flatMap((product) => {
    const pid = productIds.get(String(product.sku))!;
    if (have.has(`${book.id}|${pid}`)) { summary.pricebookEntries.existing++; return []; }
    const price = book.tier ? Number(story.priceList.get(String(product.sku))?.[`${book.tier}Price`] ?? product.price) : Number(product.price);
    return [{ Pricebook2Id: book.id, Product2Id: pid, UnitPrice: price, IsActive: true }];
  });
  // A product must be in the standard price book before it can be in any other, so the standard entries go first.
  const standardEntries = entriesFor(books[0]);
  await createMany('PricebookEntry', standardEntries);
  const tradeEntries = books.slice(1).flatMap(entriesFor);
  await createMany('PricebookEntry', tradeEntries);
  summary.pricebookEntries.created = standardEntries.length + tradeEntries.length;
  const entryRows = await lookup('Id, Product2Id, Pricebook2Id', 'PricebookEntry', 'Pricebook2Id', books.map((book) => book.id));
  const entryId = (bookId: string, sku: string) => String(entryRows.find((row) => row.Pricebook2Id === bookId && row.Product2Id === productIds.get(sku))?.Id ?? '');
  log(`Products: ${summary.products.created} created, ${summary.products.existing} already there. Price books: ${summary.pricebooks.created} created. Price book entries: ${summary.pricebookEntries.created} created, ${summary.pricebookEntries.existing} already there.`);

  // 4. Marketing: the brief, the campaigns, the leads, and who was sent or answered what.
  const briefIds = await ensure('Brief', 'Name', [story.brief.name], () => ({ Name: story.brief.name, KeyMessage: trim(story.brief.keyMessage, 2048), TargetAudience: trim(story.brief.targetAudience, 2048), Description: trim(story.brief.description, 1024), AdditionalNotes: trim(story.brief.additionalNotes, 1024) }), summary.briefs);
  // The brief's text can change between runs of this loader; make the stored brief say what the story says now.
  const briefRow = (await lookup('Id, Name, KeyMessage, TargetAudience, Description, AdditionalNotes', 'Brief', 'Name', [story.brief.name]))[0];
  const briefText = { KeyMessage: trim(story.brief.keyMessage, 2048), TargetAudience: trim(story.brief.targetAudience, 2048), Description: trim(story.brief.description, 1024), AdditionalNotes: trim(story.brief.additionalNotes, 1024) };
  const briefChange = Object.fromEntries(Object.entries(briefText).filter(([field, value]) => String(briefRow?.[field] ?? '') !== value));
  if (briefRow && Object.keys(briefChange).length) { await call('PATCH', `/sobjects/Brief/${String(briefRow.Id)}`, briefChange, [204]); summary.briefsUpdated++; }
  const memberCounts = new Map<string, number>();
  for (const member of story.members) memberCounts.set(member.campaign, (memberCounts.get(member.campaign) ?? 0) + 1);
  const campaignIds = new Map<string, string>(); // story key -> id
  for (const parent of [true, false]) { // the parent first, then its channels
    const group = story.campaigns.filter((campaign) => Boolean(campaign.parent) !== parent);
    const made = await ensure('Campaign', 'Name', group.map((campaign) => campaign.name), (name) => {
      const campaign = story.campaigns.find((c) => c.name === name)!;
      return {
        Name: campaign.name, Type: campaign.type, Status: campaign.status, StartDate: campaign.start, EndDate: campaign.end, BudgetedCost: campaign.budget, ActualCost: campaign.actual, ExpectedRevenue: campaign.expectedRevenue,
        ExpectedResponse: campaign.expectedResponse, NumberSent: memberCounts.get(campaign.key) ?? 0, IsActive: true, Description: campaign.description, OwnerId: idOf(campaign.owner),
        ...(campaign.parent ? { ParentId: campaignIds.get(campaign.parent) } : { BriefId: briefIds.get(story.brief.name) }),
      };
    }, summary.campaigns);
    for (const campaign of group) campaignIds.set(campaign.key, made.get(campaign.name)!);
  }
  const leadIds = await ensure('Lead', 'Email', story.leads.map((lead) => lead.email), (email) => {
    const lead = story.leads.find((l) => l.email === email)!;
    return { FirstName: lead.firstName, LastName: lead.lastName, Company: lead.company, Title: lead.title, Email: lead.email, Phone: lead.phone, City: lead.city, Status: lead.status, Rating: lead.rating, LeadSource: lead.leadSource, Industry: 'Construction', Description: lead.description, OwnerId: idOf(lead.owner) };
  }, summary.leads);
  const leadId = (key: string) => leadIds.get(story.leads.find((lead) => lead.key === key)!.email)!;
  const knownMembers = new Set((await lookup('CampaignId, LeadId, ContactId', 'CampaignMember', 'CampaignId', [...campaignIds.values()])).map((row) => `${row.CampaignId}|${row.LeadId ?? ''}|${row.ContactId ?? ''}`));
  const newMembers: Rec[] = [];
  for (const member of story.members) {
    const cid = campaignIds.get(member.campaign)!;
    const lid = member.lead ? leadId(member.lead) : '';
    const contact = member.accountId ? contactByAccount.get(member.accountId) ?? '' : '';
    if (knownMembers.has(`${cid}|${lid}|${contact}`)) { summary.members.existing++; continue; }
    newMembers.push({ CampaignId: cid, Status: member.status, ...(lid ? { LeadId: lid } : { ContactId: contact }) });
  }
  await createMany('CampaignMember', newMembers);
  summary.members.created = newMembers.length;
  log(`Marketing: ${summary.briefs.created} brief${summary.briefsUpdated ? ` (${summary.briefsUpdated} brief rewritten)` : ''}, ${summary.campaigns.created} campaigns, ${summary.leads.created} leads, ${summary.members.created} campaign members created (${summary.members.existing} members already there).`);

  // 5. Sales: the deals, what is on them, and the calls and meetings.
  const bookFor = (tier: string) => books.find((book) => book.tier === tier)!.id;
  const oppName = (opportunity: (typeof story.opportunities)[number]) => `${opportunity.name} [${opportunity.orderNumber}]`.slice(0, 120);
  const oppIds = await ensure('Opportunity', 'Name', story.opportunities.map(oppName), (name) => {
    const opportunity = story.opportunities.find((o) => oppName(o) === name)!;
    return {
      AccountId: idByAccount.get(opportunity.accountId), Name: name, StageName: opportunity.stage, CloseDate: opportunity.closeDate, Amount: opportunity.amount, Type: 'Existing Business', LeadSource: opportunity.leadSource,
      NextStep: trim(opportunity.nextStep, 255), Description: trim(opportunity.description, 2000), Pricebook2Id: bookFor(opportunity.tier), OwnerId: idOf(opportunity.owner), ContactId: contactByAccount.get(opportunity.accountId),
    };
  }, summary.opportunities);
  const oppId = (key: string) => oppIds.get(oppName(story.opportunities.find((o) => o.key === key)!))!;
  const withLines = new Set((await lookup('OpportunityId', 'OpportunityLineItem', 'OpportunityId', [...oppIds.values()])).map((row) => String(row.OpportunityId)));
  const lines: Rec[] = [];
  for (const opportunity of story.opportunities) {
    if (withLines.has(oppId(opportunity.key))) continue;
    for (const line of opportunity.lines) lines.push({ OpportunityId: oppId(opportunity.key), PricebookEntryId: entryId(bookFor(opportunity.tier), line.sku), Quantity: line.quantity, UnitPrice: line.unitPrice });
  }
  await createMany('OpportunityLineItem', lines);
  summary.lines = lines.length;
  const hasTask = new Set((await lookup('WhatId', 'Task', 'WhatId', [...oppIds.values()])).map((row) => String(row.WhatId)));
  const leadHasTask = new Set((await lookup('WhoId', 'Task', 'WhoId', [...leadIds.values()])).map((row) => String(row.WhoId)));
  const tasks: Rec[] = [];
  for (const task of story.tasks) {
    const opportunity = task.opportunity ? story.opportunities.find((o) => o.key === task.opportunity)! : undefined;
    if (opportunity ? hasTask.has(oppId(opportunity.key)) : leadHasTask.has(leadId(task.lead!))) continue;
    tasks.push({
      Subject: trim(task.subject, 255), Status: task.status, Priority: task.priority, ActivityDate: task.date, OwnerId: idOf(task.owner), Description: trim(task.description, 2000),
      ...(opportunity ? { WhatId: oppId(opportunity.key), WhoId: contactByAccount.get(opportunity.accountId) } : { WhoId: leadId(task.lead!) }),
    });
  }
  await createMany('Task', tasks);
  summary.tasks = tasks.length;
  const hasEvent = new Set((await lookup('WhatId', 'Event', 'WhatId', [...oppIds.values()])).map((row) => String(row.WhatId)));
  const events: Rec[] = [];
  for (const event of story.events) {
    const opportunity = story.opportunities.find((o) => o.key === event.opportunity)!;
    if (hasEvent.has(oppId(opportunity.key))) continue;
    events.push({ Subject: trim(event.subject, 255), StartDateTime: event.start, DurationInMinutes: event.minutes, Location: event.location, OwnerId: idOf(event.owner), Description: trim(event.description, 2000), WhatId: oppId(opportunity.key), WhoId: contactByAccount.get(opportunity.accountId) });
  }
  await createMany('Event', events);
  summary.events = events.length;
  log(`Sales: ${summary.opportunities.created} opportunities (${summary.opportunities.existing} already there), ${summary.lines} product lines, ${summary.tasks} tasks, ${summary.events} meetings.`);

  // 6. Service: comments on the cases that are being worked or are done.
  const caseRows = await lookup('Id, Subject, AccountId', 'Case', 'AccountId', [...idByAccount.values()]);
  const commented = new Set((await lookup('ParentId', 'CaseComment', 'ParentId', caseRows.map((row) => String(row.Id)))).map((row) => String(row.ParentId)));
  const comments: Rec[] = [];
  for (const comment of story.comments) {
    const row = caseRows.find((entry) => entry.Subject === comment.caseSubject && entry.AccountId === idByAccount.get(comment.accountId));
    if (!row || commented.has(String(row.Id))) continue;
    comments.push({ ParentId: String(row.Id), CommentBody: trim(comment.body, 3900), IsPublished: false });
  }
  await createMany('CaseComment', comments);
  summary.comments = comments.length;
  log(`Service: ${summary.comments} case comments.`);
  return summary;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await loadSalesforceCrm({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply, log: console.log });
  if (!apply) console.log('Nothing was sent. Add --apply to load.');
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
