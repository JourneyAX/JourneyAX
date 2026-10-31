/**
 * Google Analytics 4: website traffic, searches and conversions (what the sample `google-analytics` connector stood in for).
 * Read only: it uses the Analytics Data API with a read-only scope, so it cannot change anything in Google Analytics.
 *
 * Settings (names only here):
 *   GA4_PROPERTY_ID            the numeric id of the GA4 property (Admin > Property details)
 *   and one of:
 *     GA4_SERVICE_ACCOUNT_FILE  the path of a Google service account's JSON key file
 *     GA4_SERVICE_ACCOUNT_JSON  the same JSON, pasted whole into the setting
 *   The service account's email must be added to the property (Admin > Property access management) with the Viewer role, and the
 *   "Google Analytics Data API" must be switched on in the Google Cloud project the service account belongs to.
 *   optional: GA4_API_URL / GA4_TOKEN_URL (override the hosts, for a proxy or a test)
 *
 * "Conversions" are GA4's key events. Search terms need the site to report searches (GA4's site search measurement).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ToolError, type Deps, type Env, type RealConnector, type Rec, type ToolSpec } from '../types';
import { TokenCache, VendorClient, boundedInt, errorFor, redact, send, setting, vendorMessage } from '../http';

const SYSTEM = 'Google Analytics';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATE = '^(\\d{4}-\\d{2}-\\d{2}|today|yesterday|\\d{1,3}daysAgo)$';
const DATE_RE = new RegExp(DATE);

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

function readServiceAccount(env: Env): ServiceAccount {
  const inline = setting(env, 'GA4_SERVICE_ACCOUNT_JSON');
  const file = setting(env, 'GA4_SERVICE_ACCOUNT_FILE');
  let text: string;
  try { text = inline ?? readFileSync(file as string, 'utf8'); } catch { throw new ToolError('not_connected', `${SYSTEM}: the service account key file could not be read.`); }
  let key: Partial<ServiceAccount>;
  try { key = JSON.parse(text); } catch { throw new ToolError('not_connected', `${SYSTEM}: the service account key is not valid JSON.`); }
  if (!key.client_email || !key.private_key) throw new ToolError('not_connected', `${SYSTEM}: the service account key has no client_email or private_key.`);
  return key as ServiceAccount;
}

/** The signed request Google exchanges for an access token (a JWT, RS256). */
function signedAssertion(key: ServiceAccount, audience: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: audience, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64url(signer.sign(key.private_key))}`;
}

/** GA4 dates come as YYYYMMDD; people read YYYY-MM-DD. */
const readableDate = (value: string): string => (/^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value);

export function googleAnalytics(env: Env, deps: Deps): RealConnector {
  const tokens = new TokenCache(deps.now);
  let account: ServiceAccount | undefined;
  const secrets = () => { try { return [account?.private_key ?? '']; } catch { return []; } };
  const propertyId = () => setting(env, 'GA4_PROPERTY_ID') ?? '';
  const apiBase = () => (setting(env, 'GA4_API_URL') ?? 'https://analyticsdata.googleapis.com/v1beta').replace(/\/$/, '');

  async function fetchToken() {
    account ??= readServiceAccount(env);
    const tokenUrl = setting(env, 'GA4_TOKEN_URL') ?? account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const answer = await send(deps, SYSTEM, 'POST', tokenUrl, {
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(account, tokenUrl, Math.floor(deps.now() / 1000)) },
    });
    if (!answer.ok || typeof answer.json?.access_token !== 'string') {
      throw errorFor(SYSTEM, answer.status === 400 || answer.status === 401 ? 401 : answer.status || 500, redact(vendorMessage(answer.json, answer.text), secrets()));
    }
    return { token: answer.json.access_token as string, expiresInSec: Number(answer.json.expires_in) || 3600 };
  }

  const client = new VendorClient({ system: SYSTEM, deps, secrets, token: () => tokens.get(fetchToken), forgetToken: () => tokens.clear() });

  /** One report, flattened: each row becomes an object of its dimension and metric values (metrics as numbers). */
  async function report(body: Rec): Promise<{ rows: Rec[]; total: number; period: { from: string; to: string } }> {
    const answer = await client.json('POST', `${apiBase()}/properties/${propertyId()}:runReport`, { body });
    const dimensions: string[] = (answer.dimensionHeaders ?? []).map((header: any) => header.name);
    const metrics: string[] = (answer.metricHeaders ?? []).map((header: any) => header.name);
    const rows: Rec[] = (answer.rows ?? []).map((row: any) => ({
      ...Object.fromEntries(dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value])),
      ...Object.fromEntries(metrics.map((name, index) => [name, Number(row.metricValues?.[index]?.value)])),
    }));
    const range = body.dateRanges[0];
    return { rows, total: Number(answer.rowCount) || rows.length, period: { from: range.startDate, to: range.endDate } };
  }

  const dateProps = {
    from: { type: 'string', pattern: DATE, description: 'First day: YYYY-MM-DD, or a word such as 28daysAgo or yesterday. Default 28daysAgo.' },
    to: { type: 'string', pattern: DATE, description: 'Last day: YYYY-MM-DD, or today or yesterday. Default today.' },
  };
  const limitProp = { type: 'integer', minimum: 1, maximum: 50, description: 'How many rows to return (default 10).' };
  const range = (args: Rec) => {
    const from = typeof args.from === 'string' && DATE_RE.test(args.from) ? args.from : '28daysAgo';
    const to = typeof args.to === 'string' && DATE_RE.test(args.to) ? args.to : 'today';
    return [{ startDate: from, endDate: to }];
  };
  const result = (data: { rows: Rec[]; total: number; period: Rec }, records: Rec[]) => ({
    total: data.total, returned: records.length, period: data.period, property: propertyId(), records,
  });

  const tools: ToolSpec[] = [
    {
      name: 'traffic_by_page',
      readOnly: true,
      description: 'Views and visitors for pages of the website, busiest first, for a period (default the last 28 days).',
      inputSchema: { type: 'object', properties: { pathContains: { type: 'string', maxLength: 100, description: 'Only pages whose path contains this.' }, ...dateProps, limit: limitProp } },
      async run(args) {
        const data = await report({
          dateRanges: range(args),
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: String(boundedInt(args.limit, 10, 1, 50)),
          ...(typeof args.pathContains === 'string' && args.pathContains ? { dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: args.pathContains, caseSensitive: false } } } } : {}),
        });
        return result(data, data.rows.map((row) => ({ pagePath: row.pagePath, views: row.screenPageViews, visitors: row.activeUsers })));
      },
    },
    {
      name: 'top_searches',
      readOnly: true,
      description: 'The words people searched for on the website, most searched first, for a period (default the last 28 days).',
      inputSchema: { type: 'object', properties: { ...dateProps, limit: limitProp } },
      async run(args) {
        const data = await report({
          dateRanges: range(args),
          dimensions: [{ name: 'searchTerm' }],
          metrics: [{ name: 'eventCount' }, { name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: String(boundedInt(args.limit, 10, 1, 50)),
          dimensionFilter: { notExpression: { filter: { fieldName: 'searchTerm', stringFilter: { matchType: 'EXACT', value: '(not set)' } } } },
        });
        return result(data, data.rows.map((row) => ({ searchTerm: row.searchTerm, searches: row.eventCount, visitors: row.activeUsers })));
      },
    },
    {
      name: 'daily_traffic',
      readOnly: true,
      description: 'Sessions, visitors and conversions (key events) day by day, newest first, for a period (default the last 28 days).',
      inputSchema: { type: 'object', properties: { ...dateProps, limit: { ...limitProp, maximum: 90, description: 'How many days to return (default 10).' } } },
      async run(args) {
        const data = await report({
          dateRanges: range(args),
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }],
          orderBys: [{ dimension: { dimensionName: 'date', orderType: 'ALPHANUMERIC' }, desc: true }],
          limit: String(boundedInt(args.limit, 10, 1, 90)),
        });
        return result(data, data.rows.map((row) => ({ date: readableDate(String(row.date)), sessions: row.sessions, visitors: row.activeUsers, conversions: row.keyEvents })));
      },
    },
    {
      name: 'conversion_summary',
      readOnly: true,
      description: 'Sessions and conversions (key events) for each way people arrived (search, direct, email, paid and so on), for a period (default the last 28 days).',
      inputSchema: { type: 'object', properties: { ...dateProps } },
      async run(args) {
        const data = await report({
          dateRanges: range(args),
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: '25',
        });
        return result(data, data.rows.map((row) => ({ channel: row.sessionDefaultChannelGroup, sessions: row.sessions, conversions: row.keyEvents })));
      },
    },
  ];

  return {
    connectorId: 'google-analytics',
    title: 'Google Analytics',
    description: 'Website traffic, searches and conversions.',
    required: ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_FILE'],
    missing: () => {
      const missing: string[] = [];
      if (!setting(env, 'GA4_PROPERTY_ID')) missing.push('GA4_PROPERTY_ID');
      if (!setting(env, 'GA4_SERVICE_ACCOUNT_FILE') && !setting(env, 'GA4_SERVICE_ACCOUNT_JSON')) missing.push('GA4_SERVICE_ACCOUNT_FILE');
      return missing;
    },
    tools,
  };
}
