/**
 * Puts PlaceMakers-style orders and support cases into a Power BI workspace as a "push" dataset, and writes the list of figures the Power BI
 * connector reads (a file you point POWERBI_REPORTS_FILE at). Without a dataset the connector has nothing to run a query against.
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/loaders/power-bi.ts [--figures ./powerbi-figures.json] [--apply]
 *
 * It needs powers to create a dataset, which the chat's connection must not have: make a second Entra app registration (or use your own
 * sign-in) that is a Member of the workspace, and set POWERBI_LOADER_CLIENT_ID and POWERBI_LOADER_CLIENT_SECRET, next to the same
 * POWERBI_TENANT_ID and POWERBI_WORKSPACE_ID the connector uses.
 *
 * The data is the sample orders and cases (invented, with the real PlaceMakers branch names). A dry run (the default) says what it would
 * do. Running it again replaces the rows of the same dataset instead of making another one.
 *
 * Two things I could not check without a Power BI account: that DAX queries run against a push dataset in your tenant, and the exact
 * data type names Power BI wants. If a figure fails, the live check says why in Power BI's own words.
 */
import { writeFileSync } from 'node:fs';
import type { Deps, Env, Rec } from '../../src/types';
import { must, readFlags, required, sampleCollection } from './shared';

const SYSTEM = 'Power BI';
const DATASET_NAME = 'PlaceMakers demo';
const BATCH = 1000;

const TABLES = [
  { name: 'Orders', columns: [['OrderId', 'String'], ['Branch', 'String'], ['Placed', 'Datetime'], ['Status', 'String'], ['DeliveryType', 'String'], ['Total', 'Double'], ['Items', 'Int64']] },
  { name: 'Cases', columns: [['CaseId', 'String'], ['Topic', 'String'], ['Status', 'String'], ['Priority', 'String'], ['Branch', 'String'], ['Opened', 'Datetime']] },
] as const;

export interface PowerBiLoadSummary { datasetId?: string; dataset: 'created' | 'existing' | 'would create'; orders: number; cases: number; figures: Rec[] }

/** The figures the connector will offer, as DAX over the two tables above. */
export const figuresFor = (datasetId: string): Rec[] => [
  { id: 'sales-by-branch', name: 'Sales by branch', description: 'Sales and number of orders for each branch', datasetId, query: 'EVALUATE SUMMARIZECOLUMNS(Orders[Branch], "Sales", SUM(Orders[Total]), "Orders", COUNTROWS(Orders))', totalsQuery: 'EVALUATE ROW("Sales", SUM(Orders[Total]), "Orders", COUNTROWS(Orders))' },
  { id: 'orders-by-status', name: 'Orders by status', description: 'How many orders are in each state, and their value', datasetId, query: 'EVALUATE SUMMARIZECOLUMNS(Orders[Status], "Orders", COUNTROWS(Orders), "Sales", SUM(Orders[Total]))' },
  { id: 'cases-by-priority', name: 'Support cases by priority', description: 'Support cases for each priority and status', datasetId, query: 'EVALUATE SUMMARIZECOLUMNS(Cases[Priority], Cases[Status], "Cases", COUNTROWS(Cases))', totalsQuery: 'EVALUATE ROW("Cases", COUNTROWS(Cases))' },
];

export async function loadPowerBi(options: { env: Env; deps: Deps; apply: boolean; figuresFile?: string; log?: (line: string) => void }): Promise<PowerBiLoadSummary> {
  const { env, deps, apply } = options;
  const log = options.log ?? (() => {});
  required(env, ['POWERBI_TENANT_ID', 'POWERBI_WORKSPACE_ID', ...(apply ? ['POWERBI_LOADER_CLIENT_ID', 'POWERBI_LOADER_CLIENT_SECRET'] : [])]);
  const secrets = [env.POWERBI_LOADER_CLIENT_SECRET ?? ''];
  const api = (env.POWERBI_API_URL?.trim() || 'https://api.powerbi.com/v1.0/myorg').replace(/\/$/, '');
  const workspace = env.POWERBI_WORKSPACE_ID!.trim();

  const branchNames = new Map<string, string>(sampleCollection('ace-erp', 'branches').map((branch) => [String(branch.code), String(branch.name)]));
  const branch = (code: unknown) => branchNames.get(String(code)) ?? String(code ?? 'Unknown');
  const orders = sampleCollection('sap-commerce', 'orders').map((order) => ({
    OrderId: String(order.orderId), Branch: branch(order.branchCode), Placed: order.placedAt, Status: String(order.status), DeliveryType: String(order.deliveryType), Total: Number(order.total), Items: Number(order.lineCount),
  }));
  const cases = sampleCollection('salesforce', 'cases').map((entry) => ({
    CaseId: String(entry.caseId), Topic: String(entry.topic ?? ''), Status: String(entry.status), Priority: String(entry.priority), Branch: branch(entry.branchCode), Opened: entry.createdAt,
  }));
  const rowsByTable: Record<string, Rec[]> = { Orders: orders, Cases: cases };
  log(`${apply ? 'Loading' : 'Dry run. Would load'}: a dataset "${DATASET_NAME}" with ${orders.length} orders and ${cases.length} cases, and the list of figures.`);
  const summary: PowerBiLoadSummary = { dataset: 'would create', orders: orders.length, cases: cases.length, figures: [] };
  if (!apply) { summary.figures = figuresFor('<the dataset id>'); return summary; }

  const tokenUrl = env.POWERBI_TOKEN_URL?.trim() || `https://login.microsoftonline.com/${env.POWERBI_TENANT_ID!.trim()}/oauth2/v2.0/token`;
  const login = await must(deps, SYSTEM, secrets, 'POST', tokenUrl, { form: { grant_type: 'client_credentials', client_id: env.POWERBI_LOADER_CLIENT_ID!, client_secret: env.POWERBI_LOADER_CLIENT_SECRET!, scope: 'https://analysis.windows.net/powerbi/api/.default' } });
  const headers = { authorization: `Bearer ${login.json?.access_token}` };
  const call = (method: string, path: string, body?: unknown, accept: number[] = []) => must(deps, SYSTEM, secrets, method, `${api}${path}`, { headers, ...(body !== undefined ? { body } : {}) }, accept);

  const found = (await call('GET', `/groups/${workspace}/datasets`)).json?.value?.find((dataset: Rec) => dataset.name === DATASET_NAME);
  let datasetId: string | undefined = found?.id;
  if (datasetId) summary.dataset = 'existing';
  else {
    const created = await call('POST', `/groups/${workspace}/datasets?defaultRetentionPolicy=None`, {
      name: DATASET_NAME, defaultMode: 'Push',
      tables: TABLES.map((table) => ({ name: table.name, columns: table.columns.map(([name, dataType]) => ({ name, dataType })) })),
    });
    datasetId = created.json?.id;
    summary.dataset = 'created';
  }
  for (const table of TABLES) {
    await call('DELETE', `/groups/${workspace}/datasets/${datasetId}/tables/${table.name}/rows`, undefined, [404]);
    const rows = rowsByTable[table.name];
    for (let i = 0; i < rows.length; i += BATCH) await call('POST', `/groups/${workspace}/datasets/${datasetId}/tables/${table.name}/rows`, { rows: rows.slice(i, i + BATCH) });
  }
  summary.datasetId = datasetId;
  summary.figures = figuresFor(String(datasetId));
  if (options.figuresFile) writeFileSync(options.figuresFile, `${JSON.stringify(summary.figures, null, 2)}\n`);
  log(`Dataset ${summary.dataset} (${datasetId}); rows loaded. ${options.figuresFile ? `The list of figures is in ${options.figuresFile}: set POWERBI_REPORTS_FILE to that path.` : 'Pass --figures <file> to write the list of figures.'}`);
  return summary;
}

async function main() {
  const flags = readFlags(process.argv.slice(2), []);
  const at = flags.rest.indexOf('--figures');
  const figuresFile = at >= 0 ? flags.rest[at + 1] : undefined;
  const summary = await loadPowerBi({ env: process.env, deps: { fetchImpl: fetch, now: Date.now }, apply: flags.apply, figuresFile, log: console.log });
  if (!flags.apply) { console.log('Nothing was sent. The list of figures would be:'); console.log(JSON.stringify(summary.figures, null, 2)); console.log('Add --apply to load.'); }
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });
