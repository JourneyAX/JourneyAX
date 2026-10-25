/**
 * Puts PlaceMakers-style trade accounts, their contacts and their support cases into a Salesforce org (a Developer Edition), so the
 * Salesforce connector has something real to read. The records are the sample ones (invented, with real PlaceMakers branch codes).
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/salesforce.ts [--accounts 30] [--apply]
 *
 * It needs powers to create records, which the chat's connection must not have, so it uses your own short-lived session token:
 *   SALESFORCE_INSTANCE_URL (as for the connector) and SALESFORCE_LOADER_ACCESS_TOKEN (from `sf org display`, or Setup > Session).
 * A dry run (the default) says what it would do and sends nothing. Accounts that already exist (by name) are left alone, so running it
 * again changes nothing. Everything created is plain test data with example.test e-mail addresses; delete it in Salesforce when done.
 */
import type { Deps, Env, Rec } from '../../src/types';
import { must, readFlags, required, sampleCollection } from './shared';

const SYSTEM = 'Salesforce';
const STATUS: Record<string, string> = { new: 'New', open: 'Working', waiting: 'Escalated', closed: 'Closed' };
const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Medium', high: 'High' };
const ORIGIN: Record<string, string> = { phone: 'Phone', email: 'Email', web: 'Web' };
/** Salesforce accepts at most 200 records in one composite tree request; stay well under it. */
const MAX_RECORDS = 180;
const soqlText = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export interface SalesforceLoadSummary { accounts: { created: number; existing: number }; contacts: number; cases: number }

export async function loadSalesforce(options: { env: Env; deps: Deps; apply: boolean; accounts?: number; log?: (line: string) => void }): Promise<SalesforceLoadSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  required(env, ['SALESFORCE_INSTANCE_URL', ...(apply ? ['SALESFORCE_LOADER_ACCESS_TOKEN'] : [])]);
  const secrets = [env.SALESFORCE_LOADER_ACCESS_TOKEN ?? ''];
  const base = `${env.SALESFORCE_INSTANCE_URL!.trim().replace(/\/$/, '')}/services/data/${env.SALESFORCE_API_VERSION?.trim() || 'v62.0'}`;
  const accounts = sampleCollection('salesforce', 'accounts').slice(0, options.accounts ?? 30);
  const cases = sampleCollection('salesforce', 'cases');
  const casesFor = (accountId: string) => cases.filter((entry) => entry.accountId === accountId);
  const summary: SalesforceLoadSummary = { accounts: { created: 0, existing: 0 }, contacts: 0, cases: 0 };
  const totalCases = accounts.reduce((sum, account) => sum + casesFor(account.accountId).length, 0);
  log(`${apply ? 'Loading' : 'Dry run. Would load'}: ${accounts.length} accounts, each with 1 contact, and ${totalCases} cases.`);
  if (!apply) return summary;

  const headers = { authorization: `Bearer ${env.SALESFORCE_LOADER_ACCESS_TOKEN}` };
  const query = async (soql: string) => (await must(deps, SYSTEM, secrets, 'GET', `${base}/query`, { headers, query: { q: soql } })).json?.records ?? [];
  const existing = new Set<string>();
  for (let i = 0; i < accounts.length; i += 50) {
    const names = accounts.slice(i, i + 50).map((account) => soqlText(String(account.name)));
    for (const row of await query(`SELECT Name FROM Account WHERE Name IN (${names.join(', ')})`)) existing.add(String(row.Name));
  }

  const tierField = env.SALESFORCE_TIER_FIELD?.trim();
  const branchField = env.SALESFORCE_BRANCH_FIELD?.trim();
  const tree = (account: Rec, index: number): { record: Rec; count: number } => {
    const [firstName, ...rest] = String(account.contactName ?? '').split(' ');
    const accountCases = casesFor(account.accountId);
    const record: Rec = {
      attributes: { type: 'Account', referenceId: `acc${index}` },
      Name: account.name,
      Industry: 'Construction',
      Phone: account.contactPhone,
      Description: `Trade type: ${account.tradeType}. Tier: ${account.tier}. Home branch: ${account.homeBranchCode}. Account manager: ${account.accountManager}. Credit limit: ${account.creditLimit}. Terms: ${account.paymentTerms}. Sample data.`,
      ...(tierField ? { [tierField]: account.tier } : {}),
      ...(branchField ? { [branchField]: String(account.homeBranchCode) } : {}),
      Contacts: { records: [{ attributes: { type: 'Contact', referenceId: `con${index}` }, FirstName: firstName, LastName: rest.join(' ') || 'Trade', Email: account.contactEmail, Phone: account.contactPhone }] },
      ...(accountCases.length ? { Cases: { records: accountCases.map((entry, n) => ({
        attributes: { type: 'Case', referenceId: `case${index}x${n}` },
        Subject: entry.subject, Description: entry.description, Status: STATUS[entry.status] ?? 'New', Priority: PRIORITY[entry.priority] ?? 'Medium', Origin: ORIGIN[entry.origin] ?? 'Web',
      })) } } : {}),
    };
    return { record, count: 2 + accountCases.length };
  };

  let batch: Rec[] = [];
  let batchCount = 0;
  const flush = async () => {
    if (!batch.length) return;
    const answer = await must(deps, SYSTEM, secrets, 'POST', `${base}/composite/tree/Account`, { headers, body: { records: batch } }, [400]);
    if (answer.json?.hasErrors) {
      const first = answer.json.results?.[0]?.errors?.[0];
      throw new Error(`${SYSTEM} refused some of the records${first?.message ? ` (${String(first.message).slice(0, 200)})` : ''}. Nothing from that batch was kept.`);
    }
    batch = []; batchCount = 0;
  };
  for (const [index, account] of accounts.entries()) {
    if (existing.has(String(account.name))) { summary.accounts.existing++; continue; }
    const { record, count } = tree(account, index);
    if (batchCount + count > MAX_RECORDS) await flush();
    batch.push(record); batchCount += count;
    summary.accounts.created++; summary.contacts++; summary.cases += casesFor(account.accountId).length;
  }
  await flush();
  log(`Accounts: ${summary.accounts.created} created, ${summary.accounts.existing} already there. Contacts: ${summary.contacts}. Cases: ${summary.cases}.`);
  return summary;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), ['accounts']);
  await loadSalesforce({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, accounts: flags.limit.accounts, log: console.log });
  if (!flags.apply) console.log('Nothing was sent. Add --apply to load.');
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
