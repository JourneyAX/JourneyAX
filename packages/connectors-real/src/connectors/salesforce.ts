/**
 * Salesforce Sales, Service and Marketing: trade accounts and support cases, leads and deals (opportunities with their products), the pipeline, and
 * campaigns with their briefs and who answered them (what the sample `salesforce` connector stood in for, and more).
 *
 * Settings (names only here):
 *   SALESFORCE_INSTANCE_URL      the org's My Domain address, for example https://yourname-dev-ed.my.salesforce.com
 *   and one of:
 *     SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET   an External Client App (or Connected App) with the client credentials flow switched
 *                                                       on and a "run as" user. The connection can do what that user can do, so make the
 *                                                       user's permissions as small as the job allows.
 *     SALESFORCE_ACCESS_TOKEN                           a short-lived token (for a first try with `sf org display`); not renewed
 *   optional: SALESFORCE_API_VERSION (default v62.0), SALESFORCE_TIER_FIELD and SALESFORCE_BRANCH_FIELD (custom fields on Account that hold
 *             a customer tier and a home branch code; the tools only offer those filters when they are set), SALESFORCE_CASE_ORIGIN
 *             (the Origin given to a case opened by the assistant, for example Web)
 *
 * What it can change: it can open a case (create_case). It cannot edit or delete anything; every other tool only reads. The sample's `order_review_status` has no
 * counterpart in a standard org, so that tool is not offered here.
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, vendorMessage } from '../http';

const SYSTEM = 'Salesforce';
const ID = /^[a-zA-Z0-9]{15,18}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const PRIORITIES: Record<string, string> = { low: 'Low', medium: 'Medium', normal: 'Medium', high: 'High' };
const STAGES = ['Qualify', 'Meet & Present', 'Propose', 'Negotiate', 'Closed Won', 'Closed Lost'];
const LEAD_STATUSES = ['New', 'Contacted', 'Nurturing', 'Qualified', 'Unqualified'];
const CAMPAIGN_STATUSES = ['Planned', 'In Progress', 'Completed', 'Aborted'];
const DEAL_NUMBER = /^[A-Za-z]{2,6}-\d{1,8}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const sum = (rows: any[], field: string): number => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A SOQL string literal: quotes and backslashes escaped so a value can never end the string early. */
const lit = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** A SOQL LIKE pattern that matches the text anywhere, with % and _ in the text taken literally. */
const contains = (value: string): string => `'%${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (char) => `\\${char}`)}%'`;

export function salesforce(env: Env, deps: Deps): RealConnector {
  const tokens = new TokenCache(deps.now);
  const secrets = () => [setting(env, 'SALESFORCE_CLIENT_SECRET') ?? '', setting(env, 'SALESFORCE_ACCESS_TOKEN') ?? ''];
  const instance = () => (setting(env, 'SALESFORCE_INSTANCE_URL') ?? '').replace(/\/$/, '');
  const version = () => setting(env, 'SALESFORCE_API_VERSION') ?? 'v62.0';
  const optionalField = (name: string): string | undefined => { const value = setting(env, name); return value && FIELD.test(value) ? value : undefined; };
  const tierField = optionalField('SALESFORCE_TIER_FIELD');
  const branchField = optionalField('SALESFORCE_BRANCH_FIELD');

  async function fetchToken() {
    const fixed = setting(env, 'SALESFORCE_ACCESS_TOKEN');
    if (fixed) return { token: fixed, expiresInSec: 7200 };
    const answer = await send(deps, SYSTEM, 'POST', `${instance()}/services/oauth2/token`, {
      form: { grant_type: 'client_credentials', client_id: setting(env, 'SALESFORCE_CLIENT_ID') ?? '', client_secret: setting(env, 'SALESFORCE_CLIENT_SECRET') ?? '' },
    });
    if (!answer.ok || typeof answer.json?.access_token !== 'string') {
      throw errorFor(SYSTEM, answer.status === 400 || answer.status === 401 ? 401 : answer.status || 500, redact(vendorMessage(answer.json, answer.text), secrets()));
    }
    // The answer to this flow often has no lifetime; sessions last at least half an hour by default, so renew then.
    return { token: answer.json.access_token as string, expiresInSec: Number(answer.json.expires_in) || 1800 };
  }

  const client = new VendorClient({
    system: SYSTEM, deps, secrets, token: () => tokens.get(fetchToken), forgetToken: () => tokens.clear(),
    onError: (answer) => {
      const code = Array.isArray(answer.json) ? answer.json[0]?.errorCode : undefined;
      if (code === 'REQUEST_LIMIT_EXCEEDED') return new ToolError('rate_limited', `${SYSTEM} says the daily limit of requests for this org is used up.`);
      return undefined;
    },
  });
  const api = (method: string, path: string, request: { query?: Rec; body?: unknown } = {}) => client.json(method, `${instance()}/services/data/${version()}${path}`, request);
  const query = async (soql: string): Promise<{ totalSize: number; records: any[] }> => {
    const answer = await api('GET', '/query', { query: { q: soql } });
    return { totalSize: Number(answer.totalSize) || 0, records: Array.isArray(answer.records) ? answer.records : [] };
  };

  // This org has no account-number field, so the trade account's number and its commercetools unit are written into the description ("Account number ACC-0001. commercetools unit acc-0001.").
  const NUMBER_NOTE = /Account number ([A-Za-z0-9-]+)\./;
  const UNIT_NOTE = /commercetools unit ([a-z0-9-]+)\./i;
  const accountFields = ['Id', 'Name', 'Type', 'Industry', 'Phone', 'BillingCity', 'Owner.Name', 'Description', ...(tierField ? [tierField] : []), ...(branchField ? [branchField] : [])];
  const accountRecord = (row: any): Rec => compact({
    accountId: row.Id, name: row.Name, type: row.Type, industry: row.Industry, phone: row.Phone, city: row.BillingCity,
    accountNumber: NUMBER_NOTE.exec(String(row.Description ?? ''))?.[1], commercetoolsUnit: UNIT_NOTE.exec(String(row.Description ?? ''))?.[1],
    owner: row.Owner?.Name, tier: tierField ? row[tierField] : undefined, homeBranchCode: branchField ? row[branchField] : undefined,
  });
  const CAMPAIGN_FIELDS = 'Id, Name, Type, Status, StartDate, EndDate, BudgetedCost, ActualCost, ExpectedRevenue, NumberSent, NumberOfResponses, NumberOfLeads, NumberOfContacts, Parent.Name, Brief.Name, Owner.Name';
  const campaignRecord = (row: any): Rec => compact({
    campaignId: row.Id, name: row.Name, type: row.Type, status: row.Status, parent: row.Parent?.Name, start: row.StartDate, end: row.EndDate, budget: row.BudgetedCost, actualCost: row.ActualCost,
    expectedRevenue: row.ExpectedRevenue, sent: row.NumberSent, responses: row.NumberOfResponses, leads: row.NumberOfLeads, contacts: row.NumberOfContacts, brief: row.Brief?.Name, owner: row.Owner?.Name,
  });
  const caseRecord = (row: any, full = false): Rec => compact({
    caseId: row.Id, caseNumber: row.CaseNumber, subject: row.Subject, status: row.Status, priority: row.Priority,
    accountId: row.AccountId, account: row.Account?.Name, created: row.CreatedDate,
    ...(full ? { description: row.Description ? clip(String(row.Description), 1500) : undefined, origin: row.Origin, owner: row.Owner?.Name, contact: row.Contact?.Name, closed: row.ClosedDate } : {}),
  });

  const findAccountProps: Rec = {
    query: { type: 'string', maxLength: 120, description: 'Part of the account name.' },
    ...(tierField ? { tier: { type: 'string', maxLength: 40, description: 'The customer tier, as it is written in Salesforce.' } } : {}),
    ...(branchField ? { branchCode: { type: 'string', maxLength: 40, description: 'The home branch code.' } } : {}),
    limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
  };

  const tools: ToolSpec[] = [
    {
      name: 'find_account',
      readOnly: true,
      description: 'Find customer accounts by part of the name (or list them in name order). Returns the account id, name, type, industry, phone, town, owner (the sales rep), and, where it is known, the account number and the commercetools unit key to follow into the shop system.',
      inputSchema: { type: 'object', properties: findAccountProps },
      async run(args) {
        const where: string[] = [];
        if (typeof args.query === 'string' && args.query.trim()) where.push(`Name LIKE ${contains(args.query.trim())}`);
        if (tierField && args.tier) where.push(`${tierField} = ${lit(String(args.tier))}`);
        if (branchField && args.branchCode) where.push(`${branchField} = ${lit(String(args.branchCode))}`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const { totalSize, records } = await query(`SELECT ${accountFields.join(', ')} FROM Account${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY Name ASC LIMIT ${limit}`);
        return { total: totalSize, returned: records.length, ...(records.length === limit ? { more: true } : {}), records: records.map(accountRecord) };
      },
    },
    {
      name: 'get_account',
      readOnly: true,
      description: 'One account by id, with its most recent cases and its main contacts.',
      inputSchema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', maxLength: 18, pattern: ID.source } } },
      async run(args) {
        const id = String(args.accountId);
        const [account, cases, contacts] = await Promise.all([
          query(`SELECT ${accountFields.join(', ')} FROM Account WHERE Id = ${lit(id)} LIMIT 1`),
          query(`SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate FROM Case WHERE AccountId = ${lit(id)} ORDER BY CreatedDate DESC LIMIT 10`),
          query(`SELECT Name, Title, Phone, Email FROM Contact WHERE AccountId = ${lit(id)} ORDER BY CreatedDate ASC LIMIT 5`),
        ]);
        if (!account.records[0]) throw new ToolError('not_found', `${SYSTEM} has no account ${id}.`);
        return {
          record: {
            ...accountRecord(account.records[0]),
            cases: cases.records.map((entry) => caseRecord(entry)),
            contacts: contacts.records.map((entry) => compact({ name: entry.Name, title: entry.Title, phone: entry.Phone, email: entry.Email })),
          },
        };
      },
    },
    {
      name: 'list_cases',
      readOnly: true,
      description: 'Support cases, newest first, for an account or by status or priority. For status pass "open" (every case that is not closed: New, Working or Escalated), "closed", or one exact status such as Working. Priorities are low, medium (or normal) and high.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', maxLength: 18, pattern: ID.source },
          status: { type: 'string', maxLength: 40, pattern: '^[A-Za-z][A-Za-z ]{0,39}$' },
          priority: { type: 'string', enum: Object.keys(PRIORITIES) },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const where: string[] = [];
        if (args.accountId) where.push(`AccountId = ${lit(String(args.accountId))}`);
        if (args.status) {
          const status = String(args.status).trim();
          // "open" and "closed" are groups of statuses, so they are asked for by Salesforce's own closed flag, not by a status name.
          where.push(/^open$/i.test(status) ? 'IsClosed = false' : /^closed$/i.test(status) ? 'IsClosed = true' : `Status = ${lit(status)}`);
        }
        if (args.priority) where.push(`Priority = ${lit(PRIORITIES[String(args.priority)])}`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const { totalSize, records } = await query(`SELECT Id, CaseNumber, Subject, Status, Priority, AccountId, Account.Name, CreatedDate FROM Case${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY CreatedDate DESC LIMIT ${limit}`);
        return { total: totalSize, returned: records.length, ...(records.length === limit ? { more: true } : {}), records: records.map((row) => caseRecord(row)) };
      },
    },
    {
      name: 'get_case',
      readOnly: true,
      description: 'One support case by its id or its case number, with the description and who owns it.',
      inputSchema: { type: 'object', required: ['caseId'], properties: { caseId: { type: 'string', maxLength: 18, description: 'The case id, or the case number the customer was given.' } } },
      async run(args) {
        const given = String(args.caseId).trim();
        let where: string;
        if (ID.test(given)) where = `Id = ${lit(given)}`;
        else if (/^\d{1,10}$/.test(given)) where = `CaseNumber = ${lit(given.padStart(8, '0'))}`;
        else throw new ToolError('invalid_arguments', 'caseId is not in the expected form.');
        const { records } = await query(`SELECT Id, CaseNumber, Subject, Description, Status, Priority, Origin, AccountId, Account.Name, Owner.Name, Contact.Name, CreatedDate, ClosedDate FROM Case WHERE ${where} LIMIT 1`);
        if (!records[0]) throw new ToolError('not_found', `${SYSTEM} has no case ${given}.`);
        return { record: caseRecord(records[0], true) };
      },
    },
    {
      name: 'find_lead',
      readOnly: true,
      description: 'Find leads (new prospects that are not customers yet) by part of the name, company or e-mail, by status (New, Contacted, Nurturing, Qualified, Unqualified), by rating (Hot, Warm, Cold) or by the campaign they came from. Returns name, company, status, rating, source, town and the rep who owns the lead.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 120, description: 'Part of the name, company or e-mail address.' },
          status: { type: 'string', enum: LEAD_STATUSES },
          rating: { type: 'string', enum: ['Hot', 'Warm', 'Cold'] },
          campaign: { type: 'string', maxLength: 80, description: 'Part of the name of the campaign the lead came from.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const where = ['IsConverted = false'];
        if (typeof args.query === 'string' && args.query.trim()) { const like = contains(args.query.trim()); where.push(`(Name LIKE ${like} OR Company LIKE ${like} OR Email LIKE ${like})`); }
        if (args.status) where.push(`Status = ${lit(String(args.status))}`);
        if (args.rating) where.push(`Rating = ${lit(String(args.rating))}`);
        if (typeof args.campaign === 'string' && args.campaign.trim()) where.push(`Id IN (SELECT LeadId FROM CampaignMember WHERE Campaign.Name LIKE ${contains(args.campaign.trim())})`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const { totalSize, records } = await query(`SELECT Id, Name, Company, Title, Status, Rating, LeadSource, City, Email, Phone, Owner.Name, CreatedDate FROM Lead WHERE ${where.join(' AND ')} ORDER BY CreatedDate DESC, Name ASC LIMIT ${limit}`);
        return {
          total: totalSize, returned: records.length, ...(records.length === limit ? { more: true } : {}),
          records: records.map((row) => compact({ leadId: row.Id, name: row.Name, company: row.Company, title: row.Title, status: row.Status, rating: row.Rating, source: row.LeadSource, city: row.City, email: row.Email, phone: row.Phone, owner: row.Owner?.Name, created: row.CreatedDate })),
        };
      },
    },
    {
      name: 'list_opportunities',
      readOnly: true,
      description: 'Deals (opportunities), soonest to close first for open ones and latest first for finished ones. Filter by account, by stage ("open", "won", "lost", or one stage such as Propose), by the rep who owns it (part of the name) and by close date. Returns the deal number in the name, account, stage, amount, close date, owner and next step.',
      inputSchema: {
        type: 'object',
        properties: {
          accountId: { type: 'string', maxLength: 18, pattern: ID.source },
          stage: { type: 'string', enum: ['open', 'won', 'lost', ...STAGES] },
          owner: { type: 'string', maxLength: 80, description: 'Part of the name of the sales rep who owns the deal.' },
          closingAfter: { type: 'string', maxLength: 10, description: 'A date, YYYY-MM-DD.' },
          closingBefore: { type: 'string', maxLength: 10, description: 'A date, YYYY-MM-DD.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const where: string[] = [];
        if (args.accountId) where.push(`AccountId = ${lit(String(args.accountId))}`);
        const stage = args.stage ? String(args.stage) : '';
        if (stage === 'open') where.push('IsClosed = false');
        else if (stage === 'won') where.push('IsWon = true');
        else if (stage === 'lost') where.push('IsClosed = true AND IsWon = false');
        else if (stage) where.push(`StageName = ${lit(stage)}`);
        if (typeof args.owner === 'string' && args.owner.trim()) where.push(`Owner.Name LIKE ${contains(args.owner.trim())}`);
        for (const [name, field, op] of [['closingAfter', 'CloseDate', '>='], ['closingBefore', 'CloseDate', '<=']] as const) {
          if (args[name] === undefined) continue;
          if (!DAY.test(String(args[name]))) throw new ToolError('invalid_arguments', `${name} must be a date written YYYY-MM-DD.`);
          where.push(`${field} ${op} ${String(args[name])}`);
        }
        const limit = boundedInt(args.limit, 10, 1, 25);
        const finished = stage === 'won' || stage === 'lost' || stage.startsWith('Closed');
        const { totalSize, records } = await query(`SELECT Id, Name, Account.Name, AccountId, StageName, Amount, CloseDate, Owner.Name, NextStep, LeadSource FROM Opportunity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY CloseDate ${finished ? 'DESC' : 'ASC'} LIMIT ${limit}`);
        return {
          total: totalSize, returned: records.length, ...(records.length === limit ? { more: true } : {}), amountOfThese: round2(sum(records.map((row) => ({ a: row.Amount })), 'a')),
          records: records.map((row) => compact({ opportunityId: row.Id, name: row.Name, account: row.Account?.Name, accountId: row.AccountId, stage: row.StageName, amount: row.Amount, closeDate: row.CloseDate, owner: row.Owner?.Name, nextStep: row.NextStep, source: row.LeadSource })),
        };
      },
    },
    {
      name: 'get_opportunity',
      readOnly: true,
      description: 'One deal by its id or its deal number (the OPP-0001 in its name): the products on it with quantities and prices, the price book (the account\'s price tier), the contact, the owner, the next step and the latest calls and meetings.',
      inputSchema: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string', maxLength: 18, pattern: ID.source },
          dealNumber: { type: 'string', maxLength: 20, pattern: DEAL_NUMBER.source, description: 'For example OPP-0001.' },
        },
      },
      async run(args) {
        if (!args.opportunityId && !args.dealNumber) throw new ToolError('invalid_arguments', 'Give either opportunityId or dealNumber.');
        const match = args.opportunityId ? `Id = ${lit(String(args.opportunityId))}` : `Name LIKE ${contains(`[${String(args.dealNumber)}]`)}`;
        const { records } = await query(
          `SELECT Id, Name, Account.Name, AccountId, StageName, Amount, CloseDate, Owner.Name, Probability, NextStep, LeadSource, Type, Description, Pricebook2.Name, ` +
          `(SELECT Contact.Name, Contact.Title, IsPrimary FROM OpportunityContactRoles ORDER BY IsPrimary DESC LIMIT 3), ` +
          `(SELECT Product2.Name, Product2.ProductCode, Quantity, UnitPrice, TotalPrice FROM OpportunityLineItems), ` +
          `(SELECT Subject, Status, ActivityDate FROM Tasks ORDER BY ActivityDate DESC LIMIT 6), ` +
          `(SELECT Subject, StartDateTime, Location FROM Events ORDER BY StartDateTime DESC LIMIT 4) FROM Opportunity WHERE ${match} LIMIT 1`,
        );
        const row = records[0];
        if (!row) throw new ToolError('not_found', `${SYSTEM} has no deal ${String(args.opportunityId ?? args.dealNumber)}.`);
        const rows = (child: any): any[] => (Array.isArray(child?.records) ? child.records : []);
        return {
          record: compact({
            opportunityId: row.Id, name: row.Name, account: row.Account?.Name, accountId: row.AccountId, stage: row.StageName, amount: row.Amount, probability: row.Probability, closeDate: row.CloseDate,
            type: row.Type, owner: row.Owner?.Name, contact: rows(row.OpportunityContactRoles)[0]?.Contact?.Name, priceBook: row.Pricebook2?.Name, nextStep: row.NextStep, source: row.LeadSource, description: row.Description ? clip(String(row.Description), 600) : undefined,
            products: rows(row.OpportunityLineItems).map((line) => compact({ name: line.Product2?.Name, sku: line.Product2?.ProductCode, quantity: line.Quantity, unitPrice: line.UnitPrice, total: line.TotalPrice })),
            tasks: rows(row.Tasks).map((task) => compact({ subject: task.Subject, status: task.Status, due: task.ActivityDate })),
            meetings: rows(row.Events).map((event) => compact({ subject: event.Subject, start: event.StartDateTime, where: event.Location })),
          }),
        };
      },
    },
    {
      name: 'pipeline_summary',
      readOnly: true,
      description: 'The sales pipeline in numbers: how many deals and how much money at each stage, with the open, won and lost totals; or, with groupBy "rep", each rep\'s open and won deals.',
      inputSchema: { type: 'object', properties: { groupBy: { type: 'string', enum: ['stage', 'rep'], description: 'stage (the default) or rep.' } } },
      async run(args) {
        if (args.groupBy === 'rep') {
          const [open, won] = await Promise.all([
            query('SELECT Owner.Name rep, COUNT(Id) deals, SUM(Amount) amount FROM Opportunity WHERE IsClosed = false GROUP BY Owner.Name'),
            query('SELECT Owner.Name rep, COUNT(Id) deals, SUM(Amount) amount FROM Opportunity WHERE IsWon = true GROUP BY Owner.Name'),
          ]);
          const reps = new Map<string, Rec>();
          const entry = (name: string) => { if (!reps.has(name)) reps.set(name, { rep: name, openDeals: 0, openAmount: 0, wonDeals: 0, wonAmount: 0 }); return reps.get(name)!; };
          for (const row of open.records) Object.assign(entry(String(row.rep)), { openDeals: Number(row.deals) || 0, openAmount: round2(Number(row.amount) || 0) });
          for (const row of won.records) Object.assign(entry(String(row.rep)), { wonDeals: Number(row.deals) || 0, wonAmount: round2(Number(row.amount) || 0) });
          return { groupBy: 'rep', reps: [...reps.values()].sort((a, b) => b.openAmount - a.openAmount) };
        }
        const { records } = await query('SELECT StageName stage, COUNT(Id) deals, SUM(Amount) amount FROM Opportunity GROUP BY StageName');
        const stages = STAGES.map((name) => { const row = records.find((entry) => entry.stage === name); return { stage: name, deals: Number(row?.deals) || 0, amount: round2(Number(row?.amount) || 0) }; });
        const part = (names: string[]) => { const picked = stages.filter((entry) => names.includes(entry.stage)); return { deals: picked.reduce((n, entry) => n + entry.deals, 0), amount: round2(picked.reduce((n, entry) => n + entry.amount, 0)) }; };
        return { groupBy: 'stage', stages, open: part(STAGES.slice(0, 4)), won: part(['Closed Won']), lost: part(['Closed Lost']) };
      },
    },
    {
      name: 'list_campaigns',
      readOnly: true,
      description: 'Marketing campaigns, with their parent campaign, type, status, dates, budget and cost, how many were sent to and responded, how many leads and contacts they reached, and the name of the brief. Filter by part of the name, status (Planned, In Progress, Completed, Aborted) or type.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80, description: 'Part of the campaign name.' },
          status: { type: 'string', enum: CAMPAIGN_STATUSES },
          type: { type: 'string', maxLength: 40, pattern: '^[A-Za-z][A-Za-z /]{0,39}$', description: 'For example Email, Telemarketing, Banner Ads.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 10).' },
        },
      },
      async run(args) {
        const where: string[] = [];
        if (typeof args.query === 'string' && args.query.trim()) where.push(`Name LIKE ${contains(args.query.trim())}`);
        if (args.status) where.push(`Status = ${lit(String(args.status))}`);
        if (typeof args.type === 'string' && args.type.trim()) where.push(`Type = ${lit(args.type.trim())}`);
        const limit = boundedInt(args.limit, 10, 1, 25);
        const { totalSize, records } = await query(`SELECT ${CAMPAIGN_FIELDS} FROM Campaign${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY StartDate ASC, Name ASC LIMIT ${limit}`);
        return { total: totalSize, returned: records.length, ...(records.length === limit ? { more: true } : {}), records: records.map(campaignRecord) };
      },
    },
    {
      name: 'get_campaign',
      readOnly: true,
      description: 'One campaign by its id or part of its name: the brief (key message, audience, what it is about), the channels under it, how many members were sent to and responded, who responded, and the deals of the accounts whose contacts responded (open and won).',
      inputSchema: { type: 'object', required: ['campaign'], properties: { campaign: { type: 'string', maxLength: 80, description: 'The campaign id, or part of its name.' } } },
      async run(args) {
        const given = String(args.campaign).trim();
        const found = await query(`SELECT ${CAMPAIGN_FIELDS}, Description, Brief.KeyMessage, Brief.TargetAudience, Brief.Description, Brief.AdditionalNotes FROM Campaign WHERE ${ID.test(given) ? `Id = ${lit(given)}` : `Name LIKE ${contains(given)}`} ORDER BY ParentId NULLS FIRST, StartDate ASC LIMIT 1`);
        const row = found.records[0];
        if (!row) throw new ToolError('not_found', `${SYSTEM} has no campaign matching "${clip(given, 60)}".`);
        const id = String(row.Id);
        const children = await query(`SELECT ${CAMPAIGN_FIELDS} FROM Campaign WHERE ParentId = ${lit(id)} ORDER BY StartDate ASC`);
        const ids = [id, ...children.records.map((child) => String(child.Id))];
        const inIds = ids.map(lit).join(', ');
        const [byStatus, responders, accounts] = await Promise.all([
          query(`SELECT Status status, COUNT(Id) members FROM CampaignMember WHERE CampaignId IN (${inIds}) GROUP BY Status`),
          query(`SELECT Status, Contact.Name, Contact.Account.Name, Lead.Name, Lead.Company, Campaign.Name FROM CampaignMember WHERE CampaignId IN (${inIds}) AND Status = 'Responded' ORDER BY Campaign.Name ASC LIMIT 12`),
          query(`SELECT Contact.AccountId FROM CampaignMember WHERE CampaignId IN (${inIds}) AND Status = 'Responded' AND ContactId != null LIMIT 200`),
        ]);
        const accountIds = [...new Set(accounts.records.map((member) => String(member.Contact?.AccountId ?? '')).filter((value) => ID.test(value)))];
        let pipeline: Rec | undefined;
        if (accountIds.length) {
          const deals = await query(`SELECT StageName stage, COUNT(Id) deals, SUM(Amount) amount FROM Opportunity WHERE AccountId IN (${accountIds.map(lit).join(', ')}) GROUP BY StageName`);
          const part = (names: string[]) => { const picked = deals.records.filter((entry) => names.includes(String(entry.stage))); return { deals: picked.reduce((n, entry) => n + (Number(entry.deals) || 0), 0), amount: round2(picked.reduce((n, entry) => n + (Number(entry.amount) || 0), 0)) }; };
          pipeline = { accountsThatResponded: accountIds.length, openDeals: part(STAGES.slice(0, 4)), wonDeals: part(['Closed Won']) };
        }
        const brief = row.Brief ? compact({ name: row.Brief.Name, keyMessage: row.Brief.KeyMessage, targetAudience: row.Brief.TargetAudience, about: row.Brief.Description ? clip(String(row.Brief.Description), 900) : undefined, notes: row.Brief.AdditionalNotes ? clip(String(row.Brief.AdditionalNotes), 900) : undefined }) : undefined;
        return {
          record: {
            ...campaignRecord(row),
            about: row.Description ? clip(String(row.Description), 500) : undefined,
            brief,
            channels: children.records.length ? children.records.map(campaignRecord) : undefined,
            members: Object.fromEntries(byStatus.records.map((entry) => [String(entry.status), Number(entry.members) || 0])),
            responders: responders.records.map((member) => compact({ campaign: member.Campaign?.Name, name: member.Contact?.Name ?? member.Lead?.Name, company: member.Contact?.Account?.Name ?? member.Lead?.Company, kind: member.Contact ? 'contact' : 'lead' })),
            ...(pipeline ? { pipelineOfResponders: pipeline } : {}),
          },
        };
      },
    },
    {
      name: 'create_case',
      readOnly: false,
      description: 'Open a new support case for an account. This adds a record in Salesforce, so the person is asked first.',
      inputSchema: {
        type: 'object',
        required: ['accountId', 'subject'],
        properties: {
          accountId: { type: 'string', maxLength: 18, pattern: ID.source },
          subject: { type: 'string', maxLength: 255 },
          description: { type: 'string', maxLength: 4000 },
          priority: { type: 'string', enum: Object.keys(PRIORITIES) },
        },
      },
      async run(args) {
        const origin = setting(env, 'SALESFORCE_CASE_ORIGIN');
        const created = await api('POST', '/sobjects/Case', {
          body: compact({
            AccountId: String(args.accountId), Subject: String(args.subject), Description: args.description ? String(args.description) : undefined,
            Priority: args.priority ? PRIORITIES[String(args.priority)] : undefined, Origin: origin,
          }),
        });
        if (!created.success || !created.id) throw new ToolError('rejected', `${SYSTEM} did not create the case${created.errors?.[0]?.message ? ` (${clip(String(created.errors[0].message), 200)})` : ''}.`);
        const { records } = await query(`SELECT Id, CaseNumber, Subject, Status, Priority, AccountId, CreatedDate FROM Case WHERE Id = ${lit(String(created.id))} LIMIT 1`);
        return { created: true, record: records[0] ? caseRecord(records[0]) : { caseId: created.id } };
      },
    },
  ];

  return {
    connectorId: 'salesforce',
    title: 'Salesforce',
    description: 'The CRM: customer accounts, support cases, leads, deals and the pipeline, and marketing campaigns with their briefs.',
    required: ['SALESFORCE_INSTANCE_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'],
    missing: () => {
      const missing: string[] = [];
      if (!setting(env, 'SALESFORCE_INSTANCE_URL')) missing.push('SALESFORCE_INSTANCE_URL');
      if (!setting(env, 'SALESFORCE_ACCESS_TOKEN')) {
        for (const name of ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET']) if (!setting(env, name)) missing.push(name);
      }
      return missing;
    },
    tools,
  };
}
