/**
 * Proves each real connection with a few harmless reads, the way the chat would use it. Prints what worked and what did not, in plain
 * words, and never prints a secret. Nothing is changed in any vendor system unless --writes is given.
 *
 *   npx tsx --env-file=.env.connectors packages/connectors-real/scripts/live-check.ts [commercetools|salesforce|google-analytics|power-bi] [--writes]
 *
 * With --writes it also tries the one change each connector can make, on a throwaway record, and says so:
 *   salesforce      opens one case on the first account it finds, titled "JourneyAX connection check (safe to delete)"
 *   commercetools   adds one unit of the first product it finds to the cart named in CHECK_COMMERCETOOLS_CART_ID (a test cart you made)
 *
 * Some checks need an id only you know; set these to include them:
 *   CHECK_COMMERCETOOLS_ACCOUNT_ID (a customer id)   CHECK_COMMERCETOOLS_CART_ID   CHECK_COMMERCETOOLS_ORDER_ID (an id or an order number)
 */
import { createRealConnectors } from '../src/index';
import { RealConnectorServer } from '../src/server';
import type { Rec } from '../src/types';

const args = process.argv.slice(2);
const only = args.find((arg) => !arg.startsWith('--'));
const WRITES = args.includes('--writes');

const server = new RealConnectorServer({ connectors: createRealConnectors(process.env), warn: () => {} });
let failures = 0;
let skipped = 0;

async function call(connector: string, tool: string, input: Rec = {}): Promise<{ ok: boolean; payload: Rec }> {
  const answer: any = await server.handle(connector, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } });
  if (answer.error) return { ok: false, payload: { error: { code: 'protocol', message: answer.error.message } } };
  const payload = JSON.parse(answer.result.content[0].text) as Rec;
  return { ok: !answer.result.isError, payload };
}

async function check(connector: string, tool: string, input: Rec, describe: (payload: Rec) => string): Promise<Rec | undefined> {
  const { ok, payload } = await call(connector, tool, input);
  if (ok) { console.log(`    ok       ${tool}: ${describe(payload)}`); return payload; }
  failures++;
  console.log(`    FAILED   ${tool}: ${payload.error?.code} - ${payload.error?.message}`);
  return undefined;
}

function skip(tool: string, why: string) {
  skipped++;
  console.log(`    skipped  ${tool}: ${why}`);
}

const counts = (payload: Rec) => `${payload.returned ?? 0} of ${payload.total ?? '?'} returned`;

async function commercetools() {
  const list = await check('commercetools', 'find_product', { limit: 3 }, counts);
  const sku = list?.records?.[0]?.sku;
  if (sku) await check('commercetools', 'get_product', { sku }, (p) => `${p.record.name} (${p.record.price ?? 'no price'} ${p.record.currency ?? ''})`);
  else skip('get_product', 'no product to look at (is the catalogue loaded?)');
  const account = process.env.CHECK_COMMERCETOOLS_ACCOUNT_ID;
  account ? await check('commercetools', 'order_history', { accountId: account, limit: 3 }, counts) : skip('order_history', 'set CHECK_COMMERCETOOLS_ACCOUNT_ID');
  const cart = process.env.CHECK_COMMERCETOOLS_CART_ID;
  cart ? await check('commercetools', 'get_cart', { cartId: cart }, (p) => `${p.record.lineCount} line(s), total ${p.record.total ?? '?'}`) : skip('get_cart', 'set CHECK_COMMERCETOOLS_CART_ID');
  const order = process.env.CHECK_COMMERCETOOLS_ORDER_ID;
  order ? await check('commercetools', 'get_order', { orderId: order }, (p) => `order ${p.record.orderNumber ?? p.record.orderId}, ${p.record.state}`) : skip('get_order', 'set CHECK_COMMERCETOOLS_ORDER_ID');
  if (!WRITES) skip('add_to_cart', 'a change; run with --writes');
  else if (!cart || !sku) skip('add_to_cart', 'needs CHECK_COMMERCETOOLS_CART_ID and a product');
  else await check('commercetools', 'add_to_cart', { cartId: cart, sku, quantity: 1 }, (p) => `cart now has ${p.record.lineCount} line(s)`);
}

async function salesforce() {
  const accounts = await check('salesforce', 'find_account', { limit: 3 }, counts);
  const accountId = accounts?.records?.[0]?.accountId;
  if (accountId) await check('salesforce', 'get_account', { accountId }, (p) => `${p.record.name}: ${p.record.cases?.length ?? 0} case(s), ${p.record.contacts?.length ?? 0} contact(s)`);
  else skip('get_account', 'no account to look at (is the org loaded?)');
  const cases = await check('salesforce', 'list_cases', { limit: 3 }, counts);
  const caseId = cases?.records?.[0]?.caseId;
  if (caseId) await check('salesforce', 'get_case', { caseId }, (p) => `case ${p.record.caseNumber}: ${p.record.subject}`);
  else skip('get_case', 'no case to look at');
  if (!WRITES) skip('create_case', 'a change; run with --writes');
  else if (!accountId) skip('create_case', 'needs an account');
  else await check('salesforce', 'create_case', { accountId, subject: 'JourneyAX connection check (safe to delete)', description: 'Opened by the live check to prove the connection can open a case.', priority: 'low' }, (p) => `opened case ${p.record.caseNumber} (delete it in Salesforce)`);
}

async function googleAnalytics() {
  await check('google-analytics', 'daily_traffic', { limit: 3 }, (p) => `${p.returned} day(s), newest ${p.records?.[0]?.date ?? 'none'} (${p.records?.[0]?.sessions ?? 0} sessions)`);
  await check('google-analytics', 'traffic_by_page', { limit: 3 }, (p) => `${p.returned} page(s); the property has data for ${p.period.from} to ${p.period.to}`);
  await check('google-analytics', 'top_searches', { limit: 3 }, (p) => (p.returned ? `${p.returned} search term(s)` : 'none yet (the site has to report searches)'));
  await check('google-analytics', 'conversion_summary', {}, (p) => `${p.returned} channel(s)`);
}

async function powerBi() {
  const list = await check('power-bi', 'list_reports', {}, (p) => `${p.returned} report(s), ${p.records.filter((r: Rec) => r.hasFigures).length} with figures set up${p.note ? ` (${p.note})` : ''}`);
  const withFigures = (list?.records ?? []).filter((record: Rec) => record.hasFigures);
  if (!withFigures.length) skip('get_report_figures', 'no report has figures set up yet (see POWERBI_REPORTS_FILE in the setup guide)');
  for (const report of withFigures.slice(0, 3)) {
    await check('power-bi', 'get_report_figures', { reportId: report.reportId, limit: 3 }, (p) => `${report.name}: ${p.total} row(s)`);
    await check('power-bi', 'report_totals', { reportId: report.reportId }, (p) => `${report.name}: ${Object.keys(p.record).length} total(s)`);
  }
}

const RUNNERS: Record<string, () => Promise<void>> = { commercetools, salesforce, 'google-analytics': googleAnalytics, 'power-bi': powerBi };

async function main() {
  if (only && !RUNNERS[only]) throw new Error(`Unknown connector "${only}". Use one of: ${Object.keys(RUNNERS).join(', ')}.`);
  const health = (server.health().connectors as Array<{ id: string; connected: boolean; missing?: string[] }>);
  for (const id of only ? [only] : Object.keys(RUNNERS)) {
    const state = health.find((entry) => entry.id === id)!;
    console.log(`\n${id}`);
    if (!state.connected) { console.log(`    not set up: still needs ${state.missing!.join(', ')}`); skipped++; continue; }
    try { await RUNNERS[id](); } catch (error: any) { failures++; console.log(`    FAILED   ${error?.message ?? error}`); }
  }
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'Everything that was tried worked'}${skipped ? `; ${skipped} not tried` : ''}.${WRITES ? '' : ' Nothing was changed in any system.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
