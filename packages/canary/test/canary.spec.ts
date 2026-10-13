import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSuite } from '@journeyax/test-support';
import { CanarySpecSchema, parseSse, readSse, renderCanaryMarkdown, runCanary, sanitizeText } from '../src';

const suite = createSuite('canary: public-path invariants');

const sse = (events: Array<[string, unknown]>) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const productsCard = (over: Record<string, unknown> = {}) => ({
  id: 'c1', cardType: 'products', state: { heading: 'Matching Products', products: [{ sku: '1000101', title: 'Vanity unit', price: 499, currency: 'NZD', ...over }] },
});
const good = (reply = 'Here are options', extra: Array<[string, unknown]> = []) => sse([
  ['session', { sessionId: 's' }], ...extra,
  ['uiAction', { name: 'presentCard', arguments: { card: productsCard() }, card: { cardType: 'products', state: {} } }],
  ['token', { token: reply, delta: reply }],
  ['done', { sessionId: 's', message: { role: 'assistant', content: reply }, response: reply, assistantMessage: reply }],
]);

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
async function withServer<T>(handler: Handler, run: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/stream`); } finally { server.close(); }
}
const stream = (body: string, headers: Record<string, string> = {}): Handler => (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
  response.end(body);
};
const spec = (turn: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  tenantId: 'placemakers', version: '1.0.0', expectedCurrency: 'NZD',
  scenarios: [{ id: 'vanities', description: 'vanities show products', turns: [{ message: 'vanities', expect: { cards: { require: ['products'] }, ...turn } }] }], ...over,
});
const run = async (handler: Handler, turn: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  withServer(handler, (url) => runCanary({ url, headers: { Cookie: 'jxs_at=SECRETTOKEN' } }, spec(turn, over)));
const ids = (report: Awaited<ReturnType<typeof run>>) => report.scenarios.flatMap((s) => s.turns.flatMap((t) => t.violations.map((v) => v.id)));

async function main() {
  await suite.test('a well-formed customer-facing stream passes every invariant', async () => {
    const report = await run(stream(good()));
    assert.deepEqual(ids(report), []);
    assert.equal(report.passed, true);
    assert.deepEqual(report.scenarios[0].turns[0].events, ['session', 'uiAction', 'token', 'done']);
    assert.deepEqual(report.scenarios[0].turns[0].cardTypes, ['products']);
    assert.equal(report.scenarios[0].turns[0].reply, 'Here are options');
  });

  await suite.test('the browser must not receive the trace, the decision or the knowledge decision', async () => {
    const leaky = sse([
      ['session', { sessionId: 's' }],
      ['trace', { knowledgeGate: { conceptId: 'concept://placemakers/vanities', releaseId: 'okf-1' }, modelRoute: { provider: 'anthropic' } }],
      ['done', { sessionId: 's', message: { role: 'assistant', content: 'Hi' }, decision: { type: 'x' }, trace: { knowledgeGate: {} } }],
    ]);
    const found = ids(await run(stream(leaky), { cards: { require: [] } }));
    for (const id of ['event_not_public', 'leak:internal_concept_id', 'leak:knowledge_trace', 'leak:release_reference', 'leak:model_route']) assert.ok(found.includes(id), id);
  });

  await suite.test('a reply that describes how the platform works, or repeats itself, is a defect', async () => {
    const internal = ids(await run(stream(good("I was unable to complete that action safely. No capability execution outcome provided for validation. No verified source is linked to this concept in the pinned knowledge release."))));
    for (const id of ['reply_internal_wording']) assert.ok(internal.includes(id), id);
    const repeated = ids(await run(stream(good('I cannot give verified safety guidance for this. Please contact a qualified professional.\nI cannot give verified safety guidance for this.'))));
    assert.ok(repeated.includes('reply_repeats'), 'the same sentence twice');
    const clean = ids(await run(stream(good('I cannot give verified safety guidance for this. Please contact a qualified professional.'))));
    assert.deepEqual(clean.filter((id) => id.startsWith('reply_')), []);
  });

  await suite.test('credentials, datastore details and stack traces in a reply or an error are caught', async () => {
    const reply = 'Failed: MongoServerError at mongodb://user:pw@db.internal/prod\n    at Object.<anonymous> (/app/server.js:10:5) Bearer abcdefghijklmnop1234';
    const found = ids(await run(stream(good(reply))));
    for (const id of ['leak:datastore', 'leak:stack_trace', 'leak:credential']) assert.ok(found.includes(id), id);
    const errorBody = await run((_request, response) => { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"message":"MongoServerError: auth failed\\n    at x (/a.js:1:1)"}'); });
    assert.ok(ids(errorBody).includes('http_status') && ids(errorBody).includes('leak:error_body'));
  });

  await suite.test('transport rules: content type, caching, framework headers, truncation, empty streams', async () => {
    assert.ok(ids(await run(stream(good(), { 'Content-Type': 'text/plain' }))).includes('content_type'));
    assert.ok(ids(await run((_r, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(good()); })).includes('cache_control'));
    assert.ok(ids(await run(stream(good(), { 'X-Powered-By': 'Express' }))).includes('header_leak'));
    assert.ok(ids(await run(stream(good().slice(0, -3)))).includes('truncated'));
    assert.ok(ids(await run(stream(''))).includes('empty_stream'));
  });

  await suite.test('stream shape: exactly one terminal event, last; events must be JSON; no events after the end', async () => {
    const twoDone = good() + sse([['done', { sessionId: 's', message: { content: 'again' } }]]);
    assert.ok(ids(await run(stream(twoDone))).includes('terminal_event'));
    const noDone = sse([['session', { sessionId: 's' }], ['token', { token: 'x', delta: 'x' }]]);
    assert.ok(ids(await run(stream(noDone), { cards: { require: [] } })).includes('terminal_event'));
    assert.ok(ids(await run(stream('event: session\ndata: {oops\n\n' + good()))).includes('data_not_json'));
    assert.ok(ids(await run(stream(sse([['token', { token: 'a', delta: 'a' }], ['done', { message: { content: 'a' } }]])), { cards: { require: [] } })).includes('first_event'));
  });

  await suite.test('cards must be real platform cards with valid state and the shop\'s currency', async () => {
    const withCard = (card: unknown, tail: Array<[string, unknown]> = []) => sse([['session', { sessionId: 's' }], ['uiAction', { name: 'presentCard', arguments: { card } }], ...tail, ['token', { token: 'x', delta: 'x' }], ['done', { message: { content: 'x' } }]]);
    assert.ok(ids(await run(stream(withCard({ id: 'c', cardType: 'not_a_card', state: {} })), { cards: { require: [] } })).includes('card_unknown'));
    assert.ok(ids(await run(stream(withCard({ id: 'c', cardType: 'products', state: { heading: 1 } })), { cards: { require: [] } })).includes('card_invalid'));
    assert.ok(ids(await run(stream(withCard(productsCard({ currency: 'AUD' }))))).includes('currency'));
    assert.ok(ids(await run(stream(withCard(productsCard({ currency: undefined }))))).includes('price_without_currency'));
    assert.ok(ids(await run(stream(withCard({ id: 'o', cardType: 'order_confirmation', state: {} })), { cards: { require: [] } })).includes('card_forbidden'));
  });

  await suite.test('a canary never buys: a purchase step fails the run, whatever the scenario asked', async () => {
    const found = ids(await run(stream(good('ok', [['capability', { toolId: 'order.commit', status: 'success' }]]))));
    assert.ok(found.includes('mutation'));
    assert.ok(ids(await run(stream(good('ok', [['capability', { toolId: 'my.custom.write', status: 'success' }]])), {}, { forbiddenCapabilities: ['my.custom.write'] })).includes('mutation'));
  });

  await suite.test('what a scenario expects: required and forbidden cards, reply wording, steps and a latency budget', async () => {
    const found = ids(await run(stream(good('Sorry, nothing here')), {
      cards: { require: ['accessories'], forbid: ['products'] }, text: { matchesAny: ['professional|tradesperson'], mustNotMatch: ['sorry'] },
      capabilities: { require: ['catalog.search'] }, maxLatencyMs: 1,
    }));
    for (const id of ['expected_card', 'forbidden_card', 'reply_text', 'reply_forbidden', 'expected_capability']) assert.ok(found.includes(id), id);
    const slow = await run((request, response) => setTimeout(() => stream(good())(request, response), 40), { maxLatencyMs: 5 });
    assert.ok(ids(slow).includes('latency'));
  });

  await suite.test('an unreachable service is a failure with a clear id, not a crash', async () => {
    const report = await runCanary({ url: 'http://127.0.0.1:1/api/chat/stream', timeoutMs: 500 }, spec());
    assert.equal(report.passed, false);
    assert.ok(report.scenarios[0].turns[0].violations.some((violation) => violation.id === 'unreachable'));
  });

  await suite.test('the report is sanitised: no credentials, contact details or raw session ids; text is bounded', async () => {
    const reply = 'Contact me at jane.doe@example.com or +64 21 555 0199. Token Bearer abcdefghijklmnop1234 cookie jxs_at=SECRETTOKEN';
    const report = await run(stream(good(reply, [['capability', { toolId: 'catalog.search', status: 'success' }]])));
    const text = JSON.stringify(report) + renderCanaryMarkdown(report);
    for (const secret of ['jane.doe@example.com', '555 0199', 'abcdefghijklmnop1234', 'SECRETTOKEN']) assert.ok(!text.includes(secret), `${secret} is not in the report`);
    assert.ok(/session-1/.test(text) && !/"sessionId":"s"/.test(JSON.stringify(report.scenarios[0].turns[0].transcript)));
    assert.match(sanitizeText('x'.repeat(5000)), /\[truncated 3500 characters\]/);
    assert.match(renderCanaryMarkdown(report), /public-path canary/);
  });

  await suite.test('the spec refuses what a read-only canary must not contain', () => {
    assert.throws(() => CanarySpecSchema.parse({ tenantId: 'x', version: '1', scenarios: [{ id: 'a', description: 'abc', turns: [{ message: 'hi', event: { type: 'approval' } }] }] }));
    assert.throws(() => CanarySpecSchema.parse({ tenantId: 'x', version: '1', scenarios: [] }));
    assert.equal(CanarySpecSchema.parse(spec()).scenarios[0].turns[0].expect.cards?.require[0], 'products');
  });

  await suite.test('SSE parsing follows the browser: comments and heartbeats ignored, multi-line data joined, frames split on blank lines', async () => {
    assert.deepEqual(parseSse(': ping\n\nevent: token\ndata: {"a":\ndata: 1}\n\n').map((frame) => [frame.event, frame.json]), [['token', { a: 1 }]]);
    const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('event: session\ndata: {"sessionId":"s"}\n'); setTimeout(() => response.end('\nevent: done\ndata: {}\n\n'), 20); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`).then((response) => readSse(response, Date.now()));
    server.close();
    assert.deepEqual(result.frames.map((frame) => frame.event), ['session', 'done']);
    assert.equal(result.truncated, false);
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
