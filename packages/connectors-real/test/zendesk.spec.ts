import assert from 'node:assert/strict';
import { zendesk } from '../src/connectors/zendesk';
import { RealConnectorServer } from '../src/server';
import { hashScopeArguments } from '@journeyax/jax-iq';
import { loadZendesk } from '../scripts/loaders/zendesk';
import { plan as ticketPlan } from '../scripts/loaders/tickets';
import { plan as story, STORY_TODAY } from '../scripts/loaders/story';
import { callTool, leaks, listTools, mockVendor, realDeps, serverFor, suite, type Seen } from './helpers';

const t = suite('connectors-real: Zendesk (the ticket desk), its sample tickets and how they follow the other systems');
const deps = realDeps();
const TOKEN = 'zd-api-token-very-private-4471';
const EMAIL = 'agent@example.test';
const BASIC = `Basic ${Buffer.from(`${EMAIL}/token:${TOKEN}`).toString('base64')}`;
const CLIENT_ID = 'journeyax_connector';
const CLIENT_SECRET = 'zd-oauth-secret-very-private-9981';

type Rec = Record<string, any>;
const envFor = (url: string, extra: Rec = {}) => ({ ZENDESK_SUBDOMAIN: 'placemakers-demo', ZENDESK_EMAIL: EMAIL, ZENDESK_API_TOKEN: TOKEN, ZENDESK_API_URL: url, ...extra });
const oauthEnvFor = (url: string, extra: Rec = {}) => ({ ZENDESK_SUBDOMAIN: 'placemakers-demo', ZENDESK_CLIENT_ID: CLIENT_ID, ZENDESK_CLIENT_SECRET: CLIENT_SECRET, ZENDESK_API_URL: url, ...extra });

/** A pretend Zendesk: it remembers the people and tickets it is given, answers the requests the connector and loader make, and checks the sign-in on every one. */
function desk(options: { canned?: (request: Seen) => any; expireTokens?: boolean } = {}) {
  const issued: string[] = [];
  const users = new Map<string, Rec>();
  const tickets: Rec[] = [];
  let ids = 1000;
  const rejected: string[] = [];
  const answer = (request: Seen) => {
    if (request.path === '/oauth/tokens') {
      const body = request.body ?? {};
      if (body.grant_type !== 'client_credentials' || body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return { status: 401, json: { error: 'invalid_client', error_description: `Client authentication failed ${body.client_secret}` } };
      issued.push(`oauth-token-${issued.length + 1}`);
      return { status: 201, json: { access_token: issued.at(-1), token_type: 'bearer', scope: body.scope, expires_in: 1800 } };
    }
    const signedIn = request.headers.authorization === BASIC || (Boolean(request.headers.authorization) && request.headers.authorization === `Bearer ${issued.at(-1)}` && !options.expireTokens);
    if (!signedIn) { rejected.push(request.path); return { status: 401, json: { error: 'invalid_token', description: 'The access token provided is invalid' } }; }
    const path = request.path.replace('/api/v2', '');
    if (options.canned) { const custom = options.canned(request); if (custom) return custom; }
    if (path === '/users/me.json') return { json: { user: { id: 1, name: 'Agent', role: 'admin' } } };
    if (path === '/users/create_or_update.json') {
      const body = request.body.user;
      const existing = users.get(body.email) ?? { id: ++ids, ...body };
      users.set(body.email, existing);
      return { status: 201, json: { user: existing } };
    }
    if (path === '/tickets.json' && request.method === 'GET') return { json: { tickets: tickets.filter((ticket) => ticket.external_id === request.query.get('external_id')) } };
    if (path === '/imports/tickets.json' && request.method === 'POST') {
      const ticket = { id: ++ids, ...request.body.ticket };
      tickets.push(ticket);
      return { status: 201, json: { ticket: { id: ticket.id, status: ticket.status } } };
    }
    return undefined;
  };
  return { answer, users, tickets, rejected, issued };
}

async function setup(answer: (request: Seen) => any, extra: Rec = {}, approvedWrites = false) {
  const vendor = await mockVendor(answer);
  const connector = zendesk(envFor(vendor.url, extra), deps);
  const server = approvedWrites ? new RealConnectorServer({ connectors: [connector], tenants: ['fixture'], environmentId: 'test', connectionRef: 'fixture-connection', commandScopeSecret: 'offline-adapter-command-scope-'.repeat(2), warn: () => {} }) : serverFor(connector);
  let callNumber = 0;
  return { vendor, server, call: (name: string, args: Rec = {}) => {
    // These adapter contract checks enter handle with an already verified fixture scope.
    // Signed HTTP authority/replay is checked independently in the source-boundary suites.
    const scope: any = approvedWrites && connector.tools.find(tool => tool.name === name)?.readOnly === false ? {
      v: 2, operation: 'command', actionId: `fixture-${++callNumber}`, tenantId: 'fixture', environmentId: 'test', queryId: 'fixture', correlationId: 'fixture',
      principal: { id: 'fixture-staff', audience: 'staff', groups: ['customer-service'] }, connectorId: 'zendesk', connectionRef: 'fixture-connection', tool: name,
      toolState: 'allow', toolStateVia: 'tool', capRuleIds: [], argsHash: hashScopeArguments(args), fields: [], release: { version: 'fixture', checksum: 'fixture' }, iat: 1, exp: 2, jti: `fixture-${callNumber}`,
    } : undefined;
    return callTool(server, 'zendesk', name, args, scope);
  } };
}

async function main() {
  await t.test('list_recent_tickets reads the current ticket list, newest change first, and returns only what changed after `since`', async () => {
    const seen: string[] = [];
    const { vendor, call } = await setup((request) => {
      if (request.path === '/api/v2/tickets.json') {
        seen.push(`${request.query.get('sort')} ${request.query.get('page[size]')}`);
        return { json: { tickets: [
          { id: 4322, subject: 'Where is my pergola order?', status: 'new', requester_id: 7, created_at: '2026-10-26T09:44:00Z', updated_at: '2026-10-26T09:44:00Z', description: 'I ordered the posts last week.\n\nWhere are they?', via: { channel: 'web' }, tags: [] },
          { id: 4300, subject: 'Older', status: 'open', requester_id: 7, created_at: '2026-10-25T08:00:00Z', updated_at: '2026-10-25T08:00:00Z', description: 'Old one.' },
        ] } };
      }
      if (request.path === '/api/v2/users/show_many.json') return { json: { users: [{ id: 7, name: 'Sam Shopper', email: 'sam@example.test' }] } };
      return undefined;
    });
    try {
      const all: any = await call('list_recent_tickets', {});
      assert.equal(all.payload.returned, 2);
      assert.equal(all.payload.records[0].ticketId, 4322);
      assert.equal(all.payload.records[0].requester.email, 'sam@example.test');
      assert.equal(all.payload.records[0].description, 'I ordered the posts last week. Where are they?', 'the first message, tidied');
      assert.equal(all.payload.records[0].via, 'web');
      assert.equal(seen[0], '-updated_at 25', 'it asks for the current cursor-paginated list, not search');
      const recent: any = await call('list_recent_tickets', { since: '2026-10-26T00:00:00Z', limit: 5 });
      assert.deepEqual(recent.payload.records.map((r: any) => r.ticketId), [4322], 'only the ticket changed after since');
      assert.equal(seen[1], '-updated_at 5');
      const bad: any = await call('list_recent_tickets', { since: 'yesterday-ish' });
      assert.equal(bad.payload.error.code, 'invalid_arguments');
    } finally { await vendor.close(); }
  });

  await t.test('backlog paging preserves the source cursor, oldest-first order and structured record references', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.path === '/api/v2/tickets.json') {
        assert.equal(request.query.get('sort'), 'updated_at');
        const after = request.query.get('page[after]');
        return { json: { tickets: [{ id: after ? 200 : 100, subject: 'Backlog item', external_id: 'source-reference', custom_fields: [{ id: 99, value: 'ORDER-REFERENCE' }], tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`) }], meta: { has_more: !after, after_cursor: after ? null : 'next-page-token' } } };
      }
      return undefined;
    });
    try {
      const first: any = await call('list_recent_tickets', { order: 'oldest_first' });
      assert.equal(first.payload.more, true); assert.equal(first.payload.nextCursor, 'next-page-token');
      assert.equal(first.payload.records[0].externalId, 'source-reference');
      assert.deepEqual(first.payload.records[0].customFields, [{ id: 99, value: 'ORDER-REFERENCE' }]);
      assert.equal(first.payload.records[0].tags.length, 12);
      const second: any = await call('list_recent_tickets', { order: 'oldest_first', afterCursor: first.payload.nextCursor });
      assert.equal(second.payload.more, false); assert.equal(second.payload.records[0].ticketId, 200);
    } finally { await vendor.close(); }
  });

  await t.test('without its settings it is served but offers no tools and says it is not connected', async () => {
    const server = serverFor(zendesk({}, deps));
    assert.deepEqual(await listTools(server, 'zendesk'), []);
    const result: any = await callTool(server, 'zendesk', 'find_tickets', {});
    assert.equal(result.payload.error.code, 'not_connected');
    assert.deepEqual(server.health().connectors[0].missing, ['ZENDESK_SUBDOMAIN', 'ZENDESK_CLIENT_ID', 'ZENDESK_CLIENT_SECRET']);
    assert.deepEqual(zendesk({ ZENDESK_SUBDOMAIN: 'x', ZENDESK_EMAIL: EMAIL, ZENDESK_API_TOKEN: TOKEN }, deps).missing(), [], 'the older e-mail and token pair still counts as connected');
    assert.deepEqual(zendesk({ ZENDESK_SUBDOMAIN: 'x', ZENDESK_CLIENT_ID: CLIENT_ID }, deps).missing(), ['ZENDESK_CLIENT_SECRET']);
  });

  await t.test('it declares read tools and the supported explicit ticket commands', async () => {
    const { server, vendor } = await setup(() => undefined);
    const tools = await listTools(server, 'zendesk');
    assert.deepEqual(tools.map((tool) => tool.name), ['find_tickets', 'count_tickets', 'list_recent_tickets', 'get_ticket', 'get_customer_ticket', 'create_ticket', 'reply_to_ticket', 'update_ticket', 'add_ticket_note']);
    assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name), ['create_ticket', 'reply_to_ticket', 'update_ticket', 'add_ticket_note']);
    await vendor.close();
  });

  await t.test('with the older e-mail and API token every call carries them as a Basic credential, there is no sign-in call, and a subdomain that is not a plain name is refused before anything is sent', async () => {
    const { vendor, call } = await setup(() => ({ json: { results: [], count: 0 } }));
    await call('find_tickets', {});
    await call('find_tickets', { status: 'open' });
    assert.equal(vendor.seen.length, 2, 'two calls, no sign-in in between');
    assert.ok(vendor.seen.every((request) => request.headers.authorization === BASIC));
    await vendor.close();
    const server = serverFor(zendesk({ ZENDESK_SUBDOMAIN: 'evil.example/@x', ZENDESK_EMAIL: EMAIL, ZENDESK_API_TOKEN: TOKEN }, deps));
    const refused: any = await callTool(server, 'zendesk', 'find_tickets', {});
    assert.equal(refused.payload.error.code, 'not_connected');
    assert.match(refused.payload.error.message, /only the name before \.zendesk\.com/);
  });

  await t.test('with an OAuth client it asks Zendesk once for an access token (client credentials, read and write), sends it as a Bearer credential, and reuses it', async () => {
    const zd = desk({ canned: (request) => (request.path.endsWith('/search.json') ? { json: { results: [], count: 0 } } : undefined) });
    const vendor = await mockVendor(zd.answer);
    const server = serverFor(zendesk(oauthEnvFor(vendor.url), deps));
    await callTool(server, 'zendesk', 'find_tickets', {});
    await callTool(server, 'zendesk', 'find_tickets', { status: 'open' });
    const asked = vendor.seen.filter((request) => request.path === '/oauth/tokens');
    assert.equal(asked.length, 1, 'one request for a token');
    assert.equal(asked[0].method, 'POST');
    assert.deepEqual(asked[0].body, { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: 'read write' });
    const calls = vendor.seen.filter((request) => request.path !== '/oauth/tokens');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((request) => request.headers.authorization === 'Bearer oauth-token-1'));
    assert.equal(zd.rejected.length, 0);
    await vendor.close();
  });

  await t.test('an access token Zendesk stops accepting is replaced once and the call repeated; a refused client is reported as a sign-in problem with no secret in it', async () => {
    let calls = 0;
    const zd = desk({ canned: (request) => {
      if (!request.path.endsWith('/search.json')) return undefined;
      calls++;
      return request.headers.authorization === 'Bearer oauth-token-1' ? { status: 401, json: { error: 'invalid_token', description: 'The access token provided is invalid' } } : { json: { results: [], count: 0 } };
    } });
    const vendor = await mockVendor((request) => {
      // The first token is refused by the search (as if it had run out); the second is accepted.
      if (request.path.endsWith('/search.json') && request.headers.authorization === 'Bearer oauth-token-2') return { json: { results: [], count: 0 } };
      if (request.path.endsWith('/search.json') && request.headers.authorization === 'Bearer oauth-token-1') return { status: 401, json: { error: 'invalid_token' } };
      return zd.answer(request);
    });
    const server = serverFor(zendesk(oauthEnvFor(vendor.url), deps));
    const renewed: any = await callTool(server, 'zendesk', 'find_tickets', {});
    assert.equal(renewed.payload.ok, true);
    assert.equal(vendor.seen.filter((request) => request.path === '/oauth/tokens').length, 2, 'a second token was asked for');
    await vendor.close();
    const wrong = await mockVendor(desk().answer);
    const refused: any = await callTool(serverFor(zendesk(oauthEnvFor(wrong.url, { ZENDESK_CLIENT_SECRET: 'not-the-secret-0000000000000000' }), deps)), 'zendesk', 'find_tickets', {});
    assert.equal(refused.payload.error.code, 'not_authorised');
    assert.match(refused.payload.error.message, /did not accept our sign-in/);
    assert.ok(!leaks(refused, CLIENT_SECRET) && !leaks(refused, 'not-the-secret-0000000000000000'), 'neither secret is in the message');
    await wrong.close();
    assert.ok(calls >= 0);
  });

  await t.test('find_tickets builds a safe search: words with operators taken out, status groups, priority, requester and tag, newest first, and shapes who asked', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.path.endsWith('/search.json')) return { json: { count: 7, next_page: 'next', results: [{ result_type: 'ticket', id: 51, subject: 'Where is order OPP-0001?', status: 'open', priority: 'high', type: 'question', requester_id: 9, assignee_id: 1, created_at: '2026-10-20T09:00:00Z', updated_at: '2026-10-21T09:00:00Z', tags: ['placemakers', 'acc-0001'], description: 'We ordered   1 x Pool Gate\nand it has not arrived.' }] } };
      if (request.path.endsWith('/users/show_many.json')) return { json: { users: [{ id: 9, name: 'Tessa Thornbury', email: 'tessa@example.test' }, { id: 1, name: 'Agent' }] } };
      return undefined;
    });
    const { payload } = (await call('find_tickets', { query: 'delivery status:solved "x" tags:evil', status: 'unsolved', priority: 'high', requesterEmail: 'tessa@example.test', tag: 'acc-0001', limit: 5 })) as any;
    const search = vendor.seen.find((request) => request.path.endsWith('/search.json'))!;
    assert.equal(search.query.get('query'), 'type:ticket delivery status solved x tags evil status<solved priority:high requester:tessa@example.test tags:acc-0001');
    assert.equal(search.query.get('sort_by'), 'created_at');
    assert.equal(search.query.get('sort_order'), 'desc');
    assert.equal(search.query.get('per_page'), '5');
    assert.equal(vendor.seen.find((request) => request.path.endsWith('/users/show_many.json'))!.query.get('ids'), '9');
    assert.equal(payload.total, 7);
    assert.equal(payload.more, true);
    assert.deepEqual(payload.records[0], { ticketId: 51, subject: 'Where is order OPP-0001?', status: 'open', priority: 'high', type: 'question', requester: { name: 'Tessa Thornbury', email: 'tessa@example.test' }, assignee: 'Agent', created: '2026-10-20T09:00:00Z', updated: '2026-10-21T09:00:00Z', tags: ['placemakers', 'acc-0001'], summary: 'We ordered 1 x Pool Gate and it has not arrived.' });
    const count = vendor.seen.length;
    const bad: any = await call('find_tickets', { requesterEmail: 'not an address' });
    assert.equal(bad.payload.error.code, 'invalid_arguments');
    const badTag: any = await call('find_tickets', { tag: 'a b" OR x' });
    assert.equal(badTag.payload.error.code, 'invalid_arguments');
    assert.equal(vendor.seen.length, count, 'nothing was sent for either');
    await vendor.close();
  });

  await t.test('get_ticket shows the conversation: who wrote each message, whether it was public or an internal note, and what it said; and says not found for an unknown ticket', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.path.endsWith('/tickets/51.json')) return { json: { ticket: { id: 51, subject: 'Where is it?', status: 'pending', priority: 'normal', requester_id: 9, assignee_id: 1, created_at: '2026-10-20T09:00:00Z', tags: [] } } };
      if (request.path.endsWith('/tickets/51/comments.json')) return { json: { comments: [{ author_id: 9, public: true, created_at: '2026-10-20T09:00:00Z', plain_body: 'It has not arrived.' }, { author_id: 1, public: false, created_at: '2026-10-20T10:00:00Z', plain_body: 'Checked with the branch.' }] } };
      if (request.path.endsWith('/users/show_many.json')) return { json: { users: [{ id: 9, name: 'Tessa Thornbury', email: 't@example.test' }, { id: 1, name: 'Agent' }] } };
      return { status: 404, json: { error: 'RecordNotFound', description: 'Not found' } };
    });
    const { payload } = (await call('get_ticket', { ticketId: 51 })) as any;
    assert.deepEqual(payload.record.conversation, [
      { from: 'Tessa Thornbury', kind: 'public reply', at: '2026-10-20T09:00:00Z', said: 'It has not arrived.' },
      { from: 'Agent', kind: 'internal note', at: '2026-10-20T10:00:00Z', said: 'Checked with the branch.' },
    ]);
    assert.equal(payload.record.requester.name, 'Tessa Thornbury');
    const missing: any = await call('get_ticket', { ticketId: 99999 });
    assert.equal(missing.payload.error.code, 'not_found');
    assert.equal(((await call('get_ticket', { ticketId: 'one' })) as any).payload.error.code, 'invalid_arguments');
    await vendor.close();
  });

  await t.test('create_ticket raises a ticket with the customer as requester, tags it as the assistant\'s, and reports a refusal in plain words', async () => {
    const { vendor, call } = await setup((request) => {
      if (request.method === 'POST' && request.path.endsWith('/tickets.json')) {
        return request.body.ticket.subject === 'Refuse me' ? { status: 422, json: { error: 'RecordInvalid', description: 'Record validation errors', details: { base: [{ description: 'Description: cannot be blank' }] } } } : { status: 201, json: { ticket: { id: 77, subject: request.body.ticket.subject, status: 'new', priority: 'high', tags: request.body.ticket.tags } } };
      }
      return undefined;
    }, {}, true);
    const made = ((await call('create_ticket', { subject: 'Pallet damaged on delivery', description: 'Three sheets cracked.', requesterEmail: 'tessa@example.test', requesterName: 'Tessa Thornbury', priority: 'high', type: 'incident', tags: ['acc-0001', 'opp-0001'] })) as any).payload;
    const sent = vendor.seen.find((request) => request.method === 'POST')!.body.ticket;
    assert.deepEqual(sent, { subject: 'Pallet damaged on delivery', comment: { body: 'Three sheets cracked.', public: true }, requester: { email: 'tessa@example.test', name: 'Tessa Thornbury' }, priority: 'high', type: 'incident', tags: ['jx-assistant', 'acc-0001', 'opp-0001'] });
    assert.equal(made.created, true);
    assert.deepEqual(made.record, { ticketId: 77, subject: 'Pallet damaged on delivery', status: 'new', priority: 'high', tags: ['jx-assistant', 'acc-0001', 'opp-0001'] });
    const emailOnly: any = await call('create_ticket', { subject: 'Help with a product', description: 'Please contact me about the selected product.', requesterEmail: 'another@example.test' });
    assert.equal(emailOnly.payload.created, true);
    const emailOnlyRequest = vendor.seen.filter((request) => request.method === 'POST').at(-1)!.body.ticket.requester;
    assert.deepEqual(emailOnlyRequest, { email: 'another@example.test', name: 'another@example.test' }, 'a missing display name uses the actual email, never an invented customer name');
    const refused: any = await call('create_ticket', { subject: 'Refuse me', description: 'x y z', requesterEmail: 'a@example.test' });
    assert.equal(refused.payload.error.code, 'rejected');
    assert.match(refused.payload.error.message, /Record validation errors: Description: cannot be blank/);
    const bad: any = await call('create_ticket', { subject: 'Ok subject', description: 'Ok text', requesterEmail: 'nope' });
    assert.equal(bad.payload.error.code, 'invalid_arguments');
    await vendor.close();
  });

  await t.test('add_ticket_note adds an INTERNAL note only: it can never send a public reply', async () => {
    const { vendor, call } = await setup((request) => (request.method === 'PUT' ? { json: { ticket: { id: 55, status: 'open', subject: 'Where is it?' } } } : undefined), {}, true);
    // Asking for a public reply is refused outright: the tool has no such input, and nothing is sent to Zendesk.
    const refused: any = await call('add_ticket_note', { ticketId: 55, note: 'Customer rang; branch is checking.', public: true, publicReply: true });
    assert.equal(refused.isError, true);
    assert.match(refused.payload.error.message, /public, publicReply are not inputs of this tool/);
    assert.equal(vendor.seen.filter((request) => request.method === 'PUT').length, 0, 'no request reached Zendesk');
    const done = ((await call('add_ticket_note', { ticketId: 55, note: 'Customer rang; branch is checking.' })) as any).payload;
    const put = vendor.seen.find((request) => request.method === 'PUT')!;
    assert.equal(put.path, '/api/v2/tickets/55.json');
    assert.deepEqual(put.body, { ticket: { comment: { body: 'Customer rang; branch is checking.', public: false } } });
    assert.equal(done.updated, true);
    assert.deepEqual(done.record, { ticketId: 55, status: 'open', subject: 'Where is it?' });
    await vendor.close();
  });

  await t.test('vendor failures become plain messages and the token never appears in them', async () => {
    for (const [status, code] of [[401, 'not_authorised'], [403, 'not_authorised'], [404, 'not_found'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const { vendor, call } = await setup(() => ({ status, json: { error: 'Boom', description: `bad token ${TOKEN}` } }));
      const result: any = await call('find_tickets', {});
      assert.equal(result.payload.error.code, code, String(status));
      assert.ok(!leaks(result, TOKEN), `no token in the ${status} message`);
      await vendor.close();
    }
  });

  await t.test('the sample tickets are the same every time and follow the other systems: orders of the won deals, the service cases, the launch\'s leads', () => {
    const a = ticketPlan();
    assert.deepEqual(a.map((ticket) => ticket.externalId), ticketPlan().map((ticket) => ticket.externalId));
    assert.equal(a.length, 36);
    assert.equal(new Set(a.map((ticket) => ticket.externalId)).size, 36);
    assert.ok(a.every((ticket) => /^PM-TKT-\d{4}$/.test(ticket.externalId) && ticket.subject.length >= 3 && ticket.description.length >= 3));
    assert.ok(a.every((ticket) => ['new', 'open', 'pending', 'solved'].includes(ticket.status)));
    assert.ok(a.every((ticket) => ticket.tags.every((tag) => /^[a-z0-9][a-z0-9_-]{0,59}$/.test(tag))), 'tags a search can use');
    const s = story();
    for (const deal of s.opportunities.filter((opportunity) => opportunity.stage === 'Closed Won')) {
      const ticket = a.find((entry) => entry.tags.includes(deal.orderNumber.toLowerCase()));
      assert.ok(ticket, `${deal.orderNumber} has a ticket`);
      assert.ok(ticket!.tags.includes(deal.accountId.toLowerCase()), 'tagged with the account');
      assert.equal(ticket!.requester.email, s.accounts.find((account) => account.accountId === deal.accountId)!.contactEmail);
      assert.match(ticket!.subject, new RegExp(deal.orderNumber));
    }
    assert.equal(a.filter((ticket) => ticket.tags.includes('service-case')).length, 12);
    assert.ok(a.filter((ticket) => ticket.tags.includes('quote')).every((ticket) => s.leads.some((lead) => lead.email === ticket.requester.email)), 'quote requests come from the leads');
    for (const ticket of a) {
      if (ticket.status === 'new') assert.equal(ticket.thread.length, 0, 'a new ticket has no reply yet');
      if (ticket.status === 'solved') assert.ok(ticket.thread.some((m) => m.from === 'customer'), 'a solved ticket ends with the customer\'s thanks');
      assert.ok(ticket.thread.every((m, i, all) => i === 0 || m.hoursAfter >= all[i - 1].hoursAfter), 'messages in time order');
      assert.ok(ticket.thread.filter((m) => m.from === 'customer').every((m) => m.public), 'a customer message is never an internal note');
    }
    assert.ok(a.some((ticket) => ticket.thread.some((m) => !m.public)), 'there are internal notes too');
    assert.equal(a.reduce((n, ticket) => n + 1 + ticket.thread.length, 0), 120);
  });

  await t.test('a dry run sends nothing; a load needs the sign-in settings', async () => {
    const vendor = await mockVendor(() => undefined);
    const logs: string[] = [];
    const dry = await loadZendesk({ env: {}, deps, apply: false, log: (line) => logs.push(line) });
    assert.equal(dry.tickets.created, 0);
    assert.equal(vendor.seen.length, 0);
    assert.match(logs[0], /Dry run\. Would load: 36 tickets \(13 solved, 10 open, 6 pending, 7 new\) from 32 customers/);
    await assert.rejects(loadZendesk({ env: { ZENDESK_SUBDOMAIN: 'x' }, deps, apply: true }), /ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET/);
    await vendor.close();
  });

  await t.test('a load imports each ticket with its dates and whole conversation (no e-mail, no trigger), makes the customers end users, and a second run creates nothing', async () => {
    const zd = desk();
    const vendor = await mockVendor(zd.answer);
    const logs: string[] = [];
    const first = await loadZendesk({ env: envFor(vendor.url), deps, apply: true, log: (line) => logs.push(line) });
    assert.deepEqual(first.tickets, { created: 36, existing: 0 });
    assert.equal(first.people, 32);
    assert.equal(first.messages, 120);
    assert.equal(zd.tickets.length, 36);
    assert.equal(vendor.seen.filter((request) => request.method === 'POST' && request.path === '/api/v2/tickets.json').length, 0, 'the import endpoint only: ordinary ticket creation would send e-mail and run triggers');
    assert.equal(zd.rejected.length, 0, 'every request was signed in');
    assert.ok([...zd.users.values()].every((user) => user.role === 'end-user' && user.verified === true && /@example\.test$/.test(user.email)), 'sample customers, never e-mailed to verify');
    const today = Date.parse(`${STORY_TODAY}T23:59:59Z`);
    for (const ticket of zd.tickets) {
      const [description, ...rest] = ticket.comments;
      assert.equal(description.author_id, ticket.requester_id, 'the customer wrote the first message');
      assert.ok(Date.parse(ticket.created_at) < today && Date.parse(ticket.created_at) === Date.parse(description.created_at));
      assert.ok(rest.every((message: Rec, i: number) => Date.parse(message.created_at) >= Date.parse(i ? rest[i - 1].created_at : description.created_at)), 'in time order');
      assert.ok(ticket.comments.every((message: Rec) => typeof message.public === 'boolean' && message.value));
      assert.equal(ticket.updated_at, ticket.comments.at(-1).created_at);
      if (ticket.status === 'solved') assert.equal(ticket.solved_at, ticket.updated_at);
      else assert.equal(ticket.solved_at, undefined);
      if (ticket.status === 'new') { assert.equal(ticket.assignee_id, undefined); assert.equal(ticket.comments.length, 1); } else assert.equal(ticket.assignee_id, 1);
    }
    assert.ok(!leaks(logs, TOKEN), 'the token is never in what is said');
    const before = vendor.seen.filter((request) => request.method === 'POST' && request.path.endsWith('/imports/tickets.json')).length;
    const again = await loadZendesk({ env: envFor(vendor.url), deps, apply: true });
    assert.deepEqual(again.tickets, { created: 0, existing: 36 });
    assert.equal(vendor.seen.filter((request) => request.method === 'POST' && request.path.endsWith('/imports/tickets.json')).length, before, 'nothing imported twice');
    assert.equal(zd.tickets.length, 36);
    await vendor.close();
  });

  await t.test('the loader signs in the same way as the connector: with an OAuth client it asks for a token, uses it as a Bearer credential, and loads the same tickets', async () => {
    const zd = desk();
    const vendor = await mockVendor(zd.answer);
    const logs: string[] = [];
    const summary = await loadZendesk({ env: oauthEnvFor(vendor.url), deps, apply: true, log: (line) => logs.push(line) });
    assert.deepEqual(summary.tickets, { created: 36, existing: 0 });
    assert.equal(zd.issued.length, 1, 'one token served the whole load');
    assert.equal(zd.rejected.length, 0);
    assert.ok(!leaks(logs, CLIENT_SECRET));
    await assert.rejects(loadZendesk({ env: { ZENDESK_SUBDOMAIN: 'x', ZENDESK_CLIENT_ID: CLIENT_ID }, deps, apply: true }), /ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET/);
    await vendor.close();
  });

  await t.test('a refusal from Zendesk during a load is said in plain words with no token in it', async () => {
    const zd = desk({ canned: (request) => (request.path.endsWith('/imports/tickets.json') ? { status: 403, json: { error: 'Forbidden', description: `You do not have access to this page ${TOKEN}` } } : undefined) });
    const vendor = await mockVendor(zd.answer);
    await assert.rejects(loadZendesk({ env: envFor(vendor.url), deps, apply: true }), (error: any) => {
      assert.match(String(error.message), /Zendesk does not allow this connection to do that/);
      assert.ok(!String(error.message).includes(TOKEN));
      return true;
    });
    await vendor.close();
  });

  t.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
