/**
 * Salesforce Sales and Service Cloud: trade accounts and support cases (what the sample `salesforce` connector stood in for).
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
 * What it can change: it can open a case (create_case). It cannot edit or delete anything. The sample's `order_review_status` has no
 * counterpart in a standard org, so that tool is not offered here.
 */
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, vendorMessage } from '../http';

const SYSTEM = 'Salesforce';
const ID = /^[a-zA-Z0-9]{15,18}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const PRIORITIES: Record<string, string> = { low: 'Low', medium: 'Medium', normal: 'Medium', high: 'High' };

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

  const accountFields = ['Id', 'Name', 'Type', 'Industry', 'Phone', 'BillingCity', 'Owner.Name', ...(tierField ? [tierField] : []), ...(branchField ? [branchField] : [])];
  const accountRecord = (row: any): Rec => compact({
    accountId: row.Id, name: row.Name, type: row.Type, industry: row.Industry, phone: row.Phone, city: row.BillingCity,
    owner: row.Owner?.Name, tier: tierField ? row[tierField] : undefined, homeBranchCode: branchField ? row[branchField] : undefined,
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
      description: 'Find customer accounts by part of the name (or list them in name order). Returns the account id, name, type, industry, phone, town, rating and owner.',
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
      description: 'Support cases, newest first, for an account or by status or priority. Standard statuses are New, Working, Escalated and Closed; priorities are low, medium and high.',
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
        if (args.status) where.push(`Status = ${lit(String(args.status))}`);
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
    description: 'The CRM: customer accounts and support cases.',
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
