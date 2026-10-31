/**
 * The corner tile, the dashboard it opens and the cards the chat shows for a lookup (pack `extensions.dashboard`): what is read, for whom, how
 * often, and what is left blank rather than guessed.
 *   npx tsx apps/journey-runtime-service/test/dashboard-view.spec.ts
 */
import assert from 'node:assert/strict';
import { DashboardSchema } from '@journeyax/business-pack';
import { DashboardViewService, type DashboardRequest } from '../src/dashboard/dashboard-view';
import { executeConnectorMetaTool } from '../src/agent/connector-tools';
import { showRecordCards } from '../src/agent/record-cards';
import { customerAccountRecords } from '../src/agent/customer-account';
import fixture from '../../../packages/business-pack/test/fixtures/dashboard-salesforce.json';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

console.log('🧪 Dashboard view: the tile, the dashboard and the record cards');

const ROW = { title: '{account}', subtitle: '{name|clean}', badge: '{stage}', amount: '{amount|money}' };
const CASE_ROW = { title: '{subject}', subtitle: '{account}', badge: '{priority}', tones: { High: 'bad' } };

const dashboard = DashboardSchema.parse({
  timeZone: 'Pacific/Auckland',
  people: { 'sales@placemakers.demo': { name: 'Jess Penrose' } },
  entries: [{
    groups: ['sales'],
    title: 'My day',
    tile: ['open-deals', 'open-cases'],
    metrics: [
      { id: 'open-deals', label: 'Open deals', source: { connector: 'crm', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, measure: 'count' },
      { id: 'open-cases', label: 'Open cases', source: { connector: 'crm', tool: 'list_cases', args: { status: 'open', limit: 25 } }, measure: 'count' },
    ],
    sections: [
      { id: 'deals', title: 'Deals', source: { connector: 'crm', tool: 'list_opportunities', args: { stage: 'open', owner: '{me.name}', limit: 25 } }, limit: 2, row: ROW },
      { id: 'changes', title: 'Should never be read', source: { connector: 'crm', tool: 'create_case', args: { subject: 'x' } }, row: ROW },
    ],
    cards: [
      { connector: 'crm', tool: 'list_opportunities', heading: 'Open deals', limit: 3, row: ROW },
      { connector: 'crm', tool: 'list_cases', heading: 'Open cases', limit: 5, row: CASE_ROW },
    ],
  }],
});

const connectors = {
  askVia: 'card',
  connectors: [{
    connectorId: 'crm', displayName: 'CRM', description: 'Accounts, deals and cases.', owner: 'Sales operations', enabled: true,
    tools: [{ name: 'list_opportunities', sideEffect: 'read' }, { name: 'list_cases', sideEffect: 'read' }, { name: 'create_case', sideEffect: 'write' }],
  }],
  policy: [
    { connectorId: 'crm', tool: '*', audience: 'staff', groups: ['sales'], state: 'allow' },
    { connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: ['sales'], state: 'ask' },
    { connectorId: 'crm', tool: 'list_cases', audience: 'staff', groups: ['finance'], state: 'blocked' },
  ],
};

const release = (extra: Record<string, unknown> = {}) => ({
  manifest: { packId: 'p', version: '1.0.0' },
  profile: { primaryCurrency: 'NZD', primaryLocale: 'en-NZ' },
  extensions: { connectors, dashboard, ...extra },
}) as any;

const sales = { userId: 'sales@placemakers.demo', role: 'rep', audience: 'staff' as const, groups: ['sales'] };
const request = (person = sales, rel = release()): DashboardRequest => ({ tenantId: 'placemakers', environmentId: 'production', release: rel, person });

function fakeRuntime(options: { slow?: string; fail?: string } = {}) {
  const calls: Array<{ connector: string; tool: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    runtime: {
      async call(_release: any, _person: any, _ctx: any, connector: string, tool: string, args: Record<string, unknown>) {
        calls.push({ connector, tool, args });
        if (options.slow === tool) return new Promise(() => {});
        if (options.fail === tool) return { ok: false, status: 'failed', error: 'down' };
        return { ok: true, connector, tool, result: tool === 'list_cases' ? fixture.cases : fixture.opps };
      },
    } as any,
  };
}

// ---- A signed-in trade customer's own board: the customer-account tools, for the company the team linked to their login --------------------
const DELIVERY_ROW = { title: 'Order {orderId}', subtitle: '{day|date} · {window}', badge: '{status|words}', tones: { Delivered: 'good', 'Failed attempt': 'bad' } };
const customerBoard = DashboardSchema.parse({
  entries: [
    { companyRoles: ['account_admin', 'accounts_payable'], title: 'My account', tile: ['owed', 'on-the-way'], metrics: [
      { id: 'owed', label: 'Owed on the account', source: { connector: 'customer-account', tool: 'my_balance' }, measure: 'sum', field: 'balance', format: 'money' },
      { id: 'overdue', label: 'Overdue', source: { connector: 'customer-account', tool: 'my_balance' }, measure: 'sum', field: 'overdue', format: 'money', tone: [{ atLeast: 0.01, tone: 'bad' }] },
      { id: 'on-the-way', label: 'On the way', source: { connector: 'customer-account', tool: 'my_deliveries' }, measure: 'count', where: [{ field: 'status', op: 'equals', value: 'out_for_delivery' }] },
    ], sections: [{ id: 'deliveries', title: 'Your deliveries', source: { connector: 'customer-account', tool: 'my_deliveries' }, limit: 5, row: DELIVERY_ROW }], cards: [{ connector: 'customer-account', tool: 'my_deliveries', heading: 'Your deliveries', limit: 5, row: DELIVERY_ROW }] },
    { companyRoles: ['buyer', 'job_viewer'], title: 'My deliveries', tile: ['on-the-way'], metrics: [
      { id: 'on-the-way', label: 'On the way', source: { connector: 'customer-account', tool: 'my_deliveries' }, measure: 'count', where: [{ field: 'status', op: 'equals', value: 'out_for_delivery' }] },
    ], sections: [{ id: 'deliveries', title: 'Your deliveries', source: { connector: 'customer-account', tool: 'my_deliveries' }, limit: 5, row: DELIVERY_ROW }], cards: [] },
  ],
});
const erp = {
  askVia: 'card',
  connectors: [{ connectorId: 'erp', displayName: 'ERP', description: 'Accounts.', owner: 'Finance', enabled: true, tools: [{ name: 'account_balance', sideEffect: 'read' }, { name: 'list_deliveries', sideEffect: 'read' }] }],
  policy: [],
};
const customerRelease = (enabled = true) => ({
  manifest: { packId: 'p', version: '1.0.0' },
  profile: { primaryCurrency: 'NZD', primaryLocale: 'en-NZ' },
  extensions: { connectors: erp, dashboard: customerBoard, customerAccount: { enabled, connector: 'erp', tools: { balance: 'account_balance', deliveries: 'list_deliveries', price: 'trade_price' } } },
}) as any;
const DELIVERIES = [
  { deliveryId: 'D-1', orderId: 'ORD-1', status: 'out_for_delivery', scheduledDate: '2026-10-28', window: '08:00-12:00' },
  { deliveryId: 'D-2', orderId: 'ORD-2', status: 'failed_attempt', scheduledDate: '2026-10-26', window: '13:00-17:00', note: 'Nobody on site.' },
  { deliveryId: 'D-3', orderId: 'ORD-3', status: 'delivered', scheduledDate: '2026-10-20', window: '08:00-12:00' },
];
function customerRuntime() {
  const reads: Array<{ connector: string; tool: string; args: Record<string, unknown> }> = [];
  return {
    reads,
    runtime: {
      async call() { throw new Error('a customer board never goes through the staff connector gate'); },
      async callRead(_release: any, _ctx: any, connector: string, tool: string, args: Record<string, unknown>) {
        reads.push({ connector, tool, args });
        if (tool === 'account_balance') return { ok: true, result: { record: { balance: 30456.47, overdue: 12159.66, currency: 'NZD', terms: '30 days', lastPaymentAt: '2026-07-30' } } };
        if (tool === 'list_deliveries') return { ok: true, result: { records: DELIVERIES } };
        return { ok: false, status: 'not_found' };
      },
    } as any,
  };
}
const customer = (userId: string, role: 'account_admin' | 'buyer' | 'job_viewer', id = 'ACC-0028'): DashboardRequest => ({
  tenantId: 'placemakers', environmentId: 'production', release: customerRelease(),
  person: { userId, role: 'buyer', audience: 'shopper', groups: [] }, companies: [{ id, name: 'Harlow & Talbot Landscapes Ltd', role }],
});

async function main() {
  await check('a trade customer’s board reads their own company only: the account id is the one the team linked, never anything else', async () => {
    const { reads, runtime } = customerRuntime();
    const view = await new DashboardViewService({ runtime }).load(customer('admin@x.test', 'account_admin'));
    assert.ok(view);
    assert.equal(view!.title, 'My account');
    assert.ok(reads.length >= 2 && reads.every((r) => r.connector === 'erp' && r.args.accountId === 'ACC-0028'), 'every read names the linked company');
    assert.deepEqual(view!.tile.map((t) => t.value), ['$30,456', '1']);
    assert.equal(view!.metrics.find((m) => m.id === 'overdue')?.tone, 'bad');
    const deliveries = view!.sections.find((s) => s.id === 'deliveries')!;
    assert.equal(deliveries.rows.length, 3);
    assert.deepEqual(deliveries.rows.map((r) => r.badge), ['Out for delivery', 'Failed attempt', 'Delivered']);
    assert.equal(deliveries.rows[1].tone, 'bad');
  });

  await check('a buyer is never read the balance: their board has no balance figure and the account tool is not called', async () => {
    const { reads, runtime } = customerRuntime();
    const view = await new DashboardViewService({ runtime }).load(customer('buyer@x.test', 'buyer'));
    assert.equal(view?.title, 'My deliveries');
    assert.ok(!reads.some((r) => r.tool === 'account_balance'), 'no balance read for a buyer');
    assert.deepEqual(view!.tile.map((t) => t.value), ['1']);
  });

  await check('an ordinary shopper (no company) and a customer when the pack has customer accounts off get no board', async () => {
    const { runtime } = customerRuntime();
    const none: DashboardRequest = { ...customer('shopper@x.test', 'buyer'), companies: [] };
    assert.equal(await new DashboardViewService({ runtime }).load(none), undefined);
    const off = await new DashboardViewService({ runtime }).load({ ...customer('admin@x.test', 'account_admin'), release: customerRelease(false) });
    assert.ok(off, 'the board still exists');
    assert.ok(off!.metrics.every((m) => !m.ok), 'but every figure is blank: nothing was read');
  });

  await check('a company the customer was not linked to is never asked for: the id comes from the link, not from the board', async () => {
    const { reads, runtime } = customerRuntime();
    await new DashboardViewService({ runtime }).load(customer('admin@x.test', 'account_admin', 'ACC-0016'));
    assert.ok(reads.every((r) => r.args.accountId === 'ACC-0016'));
  });

  await check('each distinct lookup is made once for the whole view, as the person, with their name filled in', async () => {
    const { calls, runtime } = fakeRuntime();
    const view = await new DashboardViewService({ runtime }).load(request());
    assert.ok(view);
    assert.equal(calls.length, 2, 'open deals (used twice) and open cases');
    const deals = calls.find((c) => c.tool === 'list_opportunities')!;
    assert.deepEqual(deals.args, { stage: 'open', owner: 'Jess Penrose', limit: 25 });
    assert.equal(view!.scope, 'mine');
    assert.deepEqual(view!.tile.map((t) => t.value), [String(fixture.opps.total), `${fixture.cases.total}+`]);
  });

  await check('a tool that changes data is never read for a dashboard, however the setting names it', async () => {
    const { calls, runtime } = fakeRuntime();
    const view = await new DashboardViewService({ runtime }).load(request());
    assert.ok(!calls.some((c) => c.tool === 'create_case'));
    assert.equal(view!.sections.find((s) => s.id === 'changes')?.state, 'blocked');
  });

  await check('answers are kept for a short while per person, so a tile that refreshes does not ask the system again', async () => {
    let clock = new Date('2026-10-27T01:00:00Z');
    const { calls, runtime } = fakeRuntime();
    const service = new DashboardViewService({ runtime, cacheMs: 45_000, now: () => clock });
    await service.load(request());
    await service.load(request());
    assert.equal(calls.length, 2, 'the second view used the kept answers');
    clock = new Date(clock.getTime() + 46_000);
    await service.load(request());
    assert.equal(calls.length, 4, 'after the time is up it asks again');
    await service.load(request({ ...sales, userId: 'other.rep@placemakers.demo' }));
    assert.equal(calls.length, 6, 'another person does not get the first person’s answers');
  });

  await check('a number the person may not read is left blank without asking, and ask-first tools are not read either', async () => {
    const finance = { userId: 'finance@placemakers.demo', role: 'rep', audience: 'staff' as const, groups: ['finance'] };
    const rel = release({ dashboard: DashboardSchema.parse({ entries: [{ ...dashboard.entries[0], groups: ['finance'] }] }) });
    rel.extensions.connectors = { ...connectors, policy: [{ connectorId: 'crm', tool: '*', audience: 'staff', groups: ['finance'], state: 'allow' }, { connectorId: 'crm', tool: 'list_cases', audience: 'staff', groups: ['finance'], state: 'ask' }] };
    const { calls, runtime } = fakeRuntime();
    const view = await new DashboardViewService({ runtime }).load(request(finance, rel));
    assert.ok(!calls.some((c) => c.tool === 'list_cases'));
    const cases = view!.metrics.find((m) => m.id === 'open-cases')!;
    assert.equal(cases.value, '–');
    assert.equal(view!.metrics.find((m) => m.id === 'open-deals')!.ok, true);
    assert.equal(view!.scope, 'team', 'no name is known for this login, so the figures are the team’s');
  });

  await check('a slow or failing system blanks its own figure only, and a failure is not kept', async () => {
    const slow = fakeRuntime({ slow: 'list_cases' });
    const view = await new DashboardViewService({ runtime: slow.runtime, callTimeoutMs: 30 }).load(request());
    assert.equal(view!.metrics.find((m) => m.id === 'open-cases')!.value, '–');
    assert.equal(view!.metrics.find((m) => m.id === 'open-deals')!.ok, true);

    const failing = fakeRuntime({ fail: 'list_cases' });
    const service = new DashboardViewService({ runtime: failing.runtime });
    await service.load(request());
    await service.load(request());
    assert.equal(failing.calls.filter((c) => c.tool === 'list_cases').length, 2, 'asked again, because the failure was not remembered');
  });

  await check('nobody sees a dashboard they have none of: a shopper, or a team the pack does not name', async () => {
    const { calls, runtime } = fakeRuntime();
    const service = new DashboardViewService({ runtime });
    assert.equal(await service.load(request({ userId: 'shopper@x.test', role: 'customer', audience: 'shopper' as any, groups: [] })), undefined);
    assert.equal(await service.load(request({ ...sales, groups: ['branch'] })), undefined);
    assert.equal(await service.load(request(sales, release({ dashboard: undefined }))), undefined);
    assert.equal(calls.length, 0);
  });

  const ctxFor = (person: { audience: string; groups: string[] } | undefined, rel = release()) => {
    const presentedCards: any[] = [];
    const actions: any[] = [];
    return {
      presentedCards, actions,
      ctx: {
        tenantId: 'placemakers', environmentId: 'production', correlationId: 'c1', release: rel, principal: person, presentedCards,
        allowedClaimClasses: new Set(), emitUiAction: (a: any) => actions.push(a), emitTrace: () => {},
      } as any,
    };
  };

  await check('a trade customer’s own deliveries show as a card in the chat, only for a customer linked to a company', async () => {
    const answer = { ok: true, company: 'Harlow & Talbot Landscapes Ltd', deliveries: [{ deliveryId: 'D-1', orderId: 'ORD-1', status: 'out_for_delivery', day: '2026-10-28', window: '08:00-12:00' }] };
    const records = customerAccountRecords('my_deliveries', answer);
    const linked = ctxFor({ audience: 'shopper', groups: [] }, customerRelease());
    (linked.ctx as any).companies = [{ id: 'ACC-0028', name: 'Harlow & Talbot Landscapes Ltd', role: 'account_admin' }];
    assert.deepEqual(showRecordCards(linked.ctx, 'customer-account', 'my_deliveries', records), ['Your deliveries']);
    assert.equal(linked.presentedCards[0].state.rows[0].badge, 'Out for delivery');
    const homeowner = ctxFor({ audience: 'shopper', groups: [] }, customerRelease());
    assert.deepEqual(showRecordCards(homeowner.ctx, 'customer-account', 'my_deliveries', records), [], 'no company, no card');
    assert.deepEqual(customerAccountRecords('my_deliveries', { deliveries: Array.from({ length: 10 }, (_, i) => ({ orderId: `O${i}` })) }), { ok: true, records: Array.from({ length: 10 }, (_, i) => ({ orderId: `O${i}` })), returned: 10, more: true }, 'a full page may be only the first page');
  });

  await check('a lookup the team has a card for is shown as a card, built from the answer, and the model is told so', async () => {
    const { ctx, presentedCards, actions } = ctxFor({ audience: 'staff', groups: ['sales'] });
    const runtime = { summaries: () => [], call: async () => ({ ok: true, connector: 'crm', tool: 'list_opportunities', result: fixture.opps, claimClasses: [] }) };
    ctx.connectorRuntime = runtime;
    const answer = await executeConnectorMetaTool('call_connector_tool', { connector: 'crm', tool: 'list_opportunities', arguments: { stage: 'open' } }, ctx, {} as any);
    assert.equal(presentedCards.length, 1);
    assert.equal(presentedCards[0].cardType, 'records');
    assert.equal(presentedCards[0].state.heading, 'Open deals');
    assert.equal(presentedCards[0].state.shown, 3);
    assert.equal(presentedCards[0].state.total, fixture.opps.records.length);
    assert.equal(actions[0].name, 'presentCard');
    assert.equal(actions[0].arguments.card.cardType, 'records');
    assert.match(answer.shownAsCards, /Open deals/);
    assert.match(answer.shownAsCards, /Do not read the records out again/);
    assert.match(answer.shownAsCards, /name each in one short line with its number so they can choose/, 'several records: the person may have to pick one, so the note allows naming them');
    assert.deepEqual(answer.result.records.length, fixture.opps.records.length, 'the model still has the full answer');
    const one = { summaries: () => [], call: async () => ({ ok: true, connector: 'crm', tool: 'list_opportunities', result: { ...fixture.opps, records: fixture.opps.records.slice(0, 1) }, claimClasses: [] }) };
    const single = ctxFor({ audience: 'staff', groups: ['sales'] });
    single.ctx.connectorRuntime = one;
    const oneAnswer = await executeConnectorMetaTool('call_connector_tool', { connector: 'crm', tool: 'list_opportunities', arguments: { stage: 'open' } }, single.ctx, {} as any);
    assert.doesNotMatch(oneAnswer.shownAsCards, /name each/, 'one record: nothing to choose between');
  });

  await check('the same lookup twice makes one card, and a turn shows at most three', async () => {
    const { ctx, presentedCards } = ctxFor({ audience: 'staff', groups: ['sales'] });
    assert.equal(showRecordCards(ctx, 'crm', 'list_opportunities', fixture.opps).length, 1);
    assert.equal(showRecordCards(ctx, 'crm', 'list_opportunities', fixture.opps).length, 0);
    assert.equal(showRecordCards(ctx, 'crm', 'list_cases', fixture.cases).length, 1);
    assert.equal(presentedCards.length, 2);
    const wide = release({ dashboard: DashboardSchema.parse({ entries: [{ ...dashboard.entries[0], cards: [1, 2, 3, 4].map((n) => ({ connector: 'crm', tool: 'list_cases', heading: `Cases ${n}`, row: CASE_ROW })) }] }) });
    const more = ctxFor({ audience: 'staff', groups: ['sales'] }, wide);
    assert.equal(showRecordCards(more.ctx, 'crm', 'list_cases', fixture.cases).length, 3);
  });

  await check('no card for a shopper, for a team without one, for a tool without one, or for an empty answer', async () => {
    assert.deepEqual(showRecordCards(ctxFor({ audience: 'shopper', groups: [] }).ctx, 'crm', 'list_cases', fixture.cases), []);
    assert.deepEqual(showRecordCards(ctxFor(undefined).ctx, 'crm', 'list_cases', fixture.cases), []);
    assert.deepEqual(showRecordCards(ctxFor({ audience: 'staff', groups: ['branch'] }).ctx, 'crm', 'list_cases', fixture.cases), []);
    assert.deepEqual(showRecordCards(ctxFor({ audience: 'staff', groups: ['sales'] }).ctx, 'crm', 'find_account', fixture.find), []);
    assert.deepEqual(showRecordCards(ctxFor({ audience: 'staff', groups: ['sales'] }).ctx, 'crm', 'list_cases', { records: [] }), []);
    assert.deepEqual(showRecordCards(ctxFor({ audience: 'staff', groups: ['sales'] }, release({ dashboard: undefined })).ctx, 'crm', 'list_cases', fixture.cases), []);
  });

  console.log(`\n✅ ${passed} dashboard view checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
