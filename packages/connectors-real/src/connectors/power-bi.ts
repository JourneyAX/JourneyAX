/**
 * Power BI: figures from sales and service reports (what the sample `power-bi` connector stood in for). Read only.
 *
 * Power BI's API does not hand over what a report shows. The way to get figures out is to run a DAX query against the report's dataset,
 * and only DAX is accepted (one table per query, at most 100,000 rows). So the figures this connector offers are the ones named in a
 * small file the administrator controls, each with its dataset and its query. The model never sends a query of its own.
 *
 * Settings (names only here):
 *   POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET   a Microsoft Entra app registration (a service principal)
 *   POWERBI_WORKSPACE_ID                                           the workspace that holds the reports and datasets
 *   POWERBI_REPORTS_FILE (a path) or POWERBI_REPORTS_JSON          the list of figures, as below
 *   optional: POWERBI_API_URL / POWERBI_TOKEN_URL (override the hosts, for a proxy or a test)
 *
 * On the Power BI side: the tenant settings "Allow service principals to use Power BI APIs" and "Dataset Execute Queries REST API" must
 * be on, and the app must be a member of the workspace (Viewer is enough to read; "Build" permission on the dataset is also needed).
 *
 * The figures file is a JSON list:
 *   [{ "id": "sales-by-branch", "name": "Sales by branch", "description": "Sales and orders for each branch",
 *      "datasetId": "<dataset guid>", "reportId": "<optional: the report's guid, so list_reports can match them>",
 *      "query": "EVALUATE SUMMARIZECOLUMNS(Branch[Name], \"Sales\", [Total Sales])",
 *      "totalsQuery": "<optional: a DAX query that returns the totals>" }]
 */
import { readFileSync } from 'node:fs';
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, clip, compact, errorFor, redact, send, setting, settingsMissing, vendorMessage } from '../http';

const SYSTEM = 'Power BI';
const REQUIRED = ['POWERBI_TENANT_ID', 'POWERBI_CLIENT_ID', 'POWERBI_CLIENT_SECRET', 'POWERBI_WORKSPACE_ID'];
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FIGURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{2,99}$/;
const MAX_ROWS_FOR_TOTALS = 5000;

interface FigureSet { id: string; name: string; description?: string; datasetId: string; reportId?: string; query: string; totalsQuery?: string }

/** A DAX query we are willing to send: it must start like one, and it comes only from the administrator's file. */
const looksLikeDax = (text: unknown): text is string => typeof text === 'string' && text.length <= 6000 && /^\s*(EVALUATE|DEFINE)\b/i.test(text);

/** The figure sets from the administrator's file, read each time so an edit shows without a restart. */
function readFigureSets(env: Env): FigureSet[] {
  const inline = setting(env, 'POWERBI_REPORTS_JSON');
  const file = setting(env, 'POWERBI_REPORTS_FILE');
  if (!inline && !file) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(inline ?? readFileSync(file as string, 'utf8')); } catch { throw new ToolError('not_connected', `${SYSTEM}: the list of figures could not be read. An administrator needs to check it.`); }
  if (!Array.isArray(parsed)) throw new ToolError('not_connected', `${SYSTEM}: the list of figures must be a JSON list.`);
  const sets: FigureSet[] = [];
  for (const entry of parsed as Rec[]) {
    if (!entry || !FIGURE_ID.test(String(entry.id)) || !GUID.test(String(entry.datasetId)) || !looksLikeDax(entry.query)) {
      throw new ToolError('not_connected', `${SYSTEM}: one entry in the list of figures is not valid (it needs an id, a dataset guid and a DAX query that starts with EVALUATE).`);
    }
    if (entry.totalsQuery !== undefined && !looksLikeDax(entry.totalsQuery)) throw new ToolError('not_connected', `${SYSTEM}: a totals query in the list of figures is not valid.`);
    sets.push({ id: String(entry.id), name: String(entry.name ?? entry.id), description: entry.description ? String(entry.description) : undefined, datasetId: String(entry.datasetId), reportId: entry.reportId ? String(entry.reportId) : undefined, query: entry.query, totalsQuery: entry.totalsQuery });
  }
  return sets;
}

/** `Sales[Branch]` becomes `Branch`; `[Total]` becomes `Total`. A name that would clash keeps its table. */
function tidyColumns(rows: Rec[]): Rec[] {
  if (!rows.length) return rows;
  const short = (name: string) => /^(?:.*\[)?([^\]]+)\]?$/.exec(name)?.[1] ?? name;
  const names = Object.keys(rows[0]);
  const shortNames = names.map(short);
  const clash = new Set(shortNames.filter((name, index) => shortNames.indexOf(name) !== index));
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [clash.has(shortNames[index]) ? name : shortNames[index], row[name]])));
}

export function powerBi(env: Env, deps: Deps): RealConnector {
  const tokens = new TokenCache(deps.now);
  const secrets = () => [setting(env, 'POWERBI_CLIENT_SECRET') ?? ''];
  const apiBase = () => (setting(env, 'POWERBI_API_URL') ?? 'https://api.powerbi.com/v1.0/myorg').replace(/\/$/, '');
  const workspace = () => setting(env, 'POWERBI_WORKSPACE_ID') ?? '';

  async function fetchToken() {
    const tenant = setting(env, 'POWERBI_TENANT_ID') ?? '';
    if (!TENANT.test(tenant)) throw new ToolError('not_connected', `${SYSTEM}: the tenant id setting is not a tenant id.`);
    const tokenUrl = setting(env, 'POWERBI_TOKEN_URL') ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const answer = await send(deps, SYSTEM, 'POST', tokenUrl, {
      form: { grant_type: 'client_credentials', client_id: setting(env, 'POWERBI_CLIENT_ID') ?? '', client_secret: setting(env, 'POWERBI_CLIENT_SECRET') ?? '', scope: 'https://analysis.windows.net/powerbi/api/.default' },
    });
    if (!answer.ok || typeof answer.json?.access_token !== 'string') {
      throw errorFor(SYSTEM, answer.status === 400 || answer.status === 401 ? 401 : answer.status || 500, redact(vendorMessage(answer.json, answer.text), secrets()));
    }
    return { token: answer.json.access_token as string, expiresInSec: Number(answer.json.expires_in) || 3600 };
  }

  const client = new VendorClient({ system: SYSTEM, deps, secrets, token: () => tokens.get(fetchToken), forgetToken: () => tokens.clear() });

  /** Runs one DAX query (from the administrator's list) and returns its rows with tidy column names. */
  async function run(set: FigureSet, query: string): Promise<Rec[]> {
    const answer = await client.json('POST', `${apiBase()}/groups/${workspace()}/datasets/${set.datasetId}/executeQueries`, {
      body: { queries: [{ query }], serializerSettings: { includeNulls: true } },
      timeoutMs: 30_000,
    });
    const result = answer.results?.[0];
    const problem = answer.error ?? result?.error ?? result?.tables?.[0]?.error;
    if (problem) throw new ToolError('rejected', `${SYSTEM} could not run the query for "${set.name}" (${clip(String(problem.message ?? problem.code ?? 'unknown error'), 200)}).`);
    return tidyColumns(Array.isArray(result?.tables?.[0]?.rows) ? result.tables[0].rows : []);
  }

  function findSet(sets: FigureSet[], given: string): FigureSet | undefined {
    const wanted = given.trim().toLowerCase();
    return sets.find((set) => set.id.toLowerCase() === wanted || set.reportId?.toLowerCase() === wanted || set.name.toLowerCase() === wanted);
  }

  async function figureSetFor(reportId: string): Promise<FigureSet> {
    const sets = readFigureSets(env);
    const found = findSet(sets, reportId);
    if (found) return found;
    if (GUID.test(reportId)) {
      throw new ToolError('not_set_up', `${SYSTEM} has that report, but its figures have not been set up. An administrator needs to add it to the list of figures.`);
    }
    throw new ToolError('not_found', `No figures are set up under "${clip(reportId, 60)}". Use list_reports to see what there is.`);
  }

  const reportIdProp = { type: 'string', maxLength: 80, description: 'The id of a report from list_reports.' };

  const tools: ToolSpec[] = [
    {
      name: 'list_reports',
      readOnly: true,
      description: 'The reports whose figures can be read. Each has an id to pass to get_report_figures and report_totals. Reports that exist in Power BI but have no figures set up are shown as hasFigures: false.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const sets = readFigureSets(env);
        let existing: any[] = [];
        let note: string | undefined;
        try {
          const answer = await client.json('GET', `${apiBase()}/groups/${workspace()}/reports`);
          existing = Array.isArray(answer.value) ? answer.value : [];
        } catch (error) {
          if (!sets.length || !(error instanceof ToolError)) throw error;
          note = 'The list of reports in the workspace could not be read, so only the reports with figures are shown.';
        }
        const configured = sets.map((set) => compact({ reportId: set.id, name: set.name, description: set.description, hasFigures: true }));
        const known = new Set(sets.flatMap((set) => [set.reportId?.toLowerCase(), set.id.toLowerCase()]));
        const others = existing.filter((report) => !known.has(String(report.id).toLowerCase())).map((report) => ({ reportId: report.id, name: report.name, hasFigures: false }));
        const records = [...configured, ...others];
        return { total: records.length, returned: records.length, ...(note ? { note } : {}), records };
      },
    },
    {
      name: 'get_report_figures',
      readOnly: true,
      description: 'The figures of one report, as rows (for example sales for each branch). Use list_reports first to find the id.',
      inputSchema: { type: 'object', required: ['reportId'], properties: { reportId: reportIdProp, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many rows to return (default 20).' } } },
      async run(args) {
        const set = await figureSetFor(String(args.reportId));
        const rows = await run(set, set.query);
        const limit = boundedInt(args.limit, 20, 1, 200);
        return { report: { reportId: set.id, name: set.name }, total: rows.length, returned: Math.min(rows.length, limit), ...(rows.length > limit ? { truncated: true } : {}), records: rows.slice(0, limit) };
      },
    },
    {
      name: 'report_totals',
      readOnly: true,
      description: 'The totals of one report. If the report has no totals of its own, they are added up from its figures.',
      inputSchema: { type: 'object', required: ['reportId'], properties: { reportId: reportIdProp } },
      async run(args) {
        const set = await figureSetFor(String(args.reportId));
        if (set.totalsQuery) {
          const rows = await run(set, set.totalsQuery);
          return { report: { reportId: set.id, name: set.name }, record: rows[0] ?? {} };
        }
        const rows = await run(set, set.query);
        const counted = rows.slice(0, MAX_ROWS_FOR_TOTALS);
        const totals: Rec = {};
        for (const column of Object.keys(counted[0] ?? {})) {
          const values = counted.map((row) => row[column]);
          if (values.length && values.every((value) => value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value)))) {
            totals[column] = Math.round(values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0) * 100) / 100;
          }
        }
        return { report: { reportId: set.id, name: set.name }, record: totals, computedFrom: 'the report figures', rowsCounted: counted.length, ...(rows.length > counted.length ? { partial: true } : {}) };
      },
    },
  ];

  return {
    connectorId: 'power-bi',
    title: 'Power BI',
    description: 'Sales and service reports.',
    required: REQUIRED,
    missing: () => settingsMissing(env, REQUIRED),
    tools,
  };
}
