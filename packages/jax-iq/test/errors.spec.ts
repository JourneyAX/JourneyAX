import './setup/no-world';
import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import {
  EnvSecretResolver, HttpMcpTransport, InProcessMcpTransport, McpClient, McpClientPool, StaticMcpServerDirectory, assertSafeMcpUrl, assertSecretRefInScope,
  type McpRequestMeta,
} from '@journeyax/capability-sdk';
import type { ReleaseVerificationFailureReason } from '@journeyax/business-pack';
import { errorFor } from '../../connectors-real/src/http';
import { RealConnectorServer } from '../../connectors-real/src/server';
import { ToolError, type RealConnector } from '../../connectors-real/src/types';
import { SampleConnectorServer } from '../../connectors-sample/src/server';
import * as errorsModule from '../src/errors';
import * as portsModule from '../src/ports';
import { JAX_IQ_ERROR_CODES, JAX_IQ_ERROR_TABLE, classifyConnectorFailure, isJaxIqErrorCode } from '../src/errors';
import type { JaxIqErrorCode } from '../src/errors';
import { isReleaseFailure } from '../src/ports';
import type { ConnectorOutcome, LoadedRelease, ReleaseFailure, ReleaseFailureReason, ReleaseSource } from '../src/ports';
import { connectorsFixture } from './fixtures/connectors.fixture';
import { minimalDictionary } from './fixtures/minimal.dictionary';

/**
 * The error taxonomy and the shared ports. The texts that are classified here are the real ones: the connector servers answer in the same
 * process through the real MCP client, and the transport and directory failures are thrown by the real SDK code. Everything here is made
 * up (TEST FIXTURE ONLY): the system name, the details and the made-up hosts, none of which is ever reached.
 */
const suite = createSuite('jax-iq: the error taxonomy, the connector failure classifier and the shared ports');

// The code list and the type agree both ways. `tsc:jax-iq` fails here when they drift.
type Agree<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type SpecCodes =
  | 'invalid_request' | 'principal_missing' | 'service_unauthorised' | 'scope_mismatch' | 'release_unavailable' | 'release_mismatch' | 'not_configured'
  | 'refused_by_rule' | 'no_match' | 'ambiguous' | 'key_table_unavailable' | 'deadline_exceeded' | 'source_not_connected' | 'source_not_authorised'
  | 'source_not_found' | 'source_rate_limited' | 'source_timeout' | 'source_unavailable' | 'source_rejected' | 'source_bad_arguments' | 'source_internal'
  | 'source_shape_mismatch' | 'source_truncated' | 'signal_input_unavailable' | 'signal_setting_missing' | 'signal_divisor_zero' | 'internal_error';
export type CodesAgree = [
  Assert<Agree<JaxIqErrorCode, SpecCodes | 'not_read_only' | 'principal_not_staff' | 'source_not_set_up'>>,
  Assert<Agree<ReleaseFailure['code'], 'release_unavailable' | 'release_mismatch'>>,
  Assert<Agree<ReleaseVerificationFailureReason extends ReleaseFailureReason ? true : false, true>>,
];

type FailedKind = Extract<ConnectorOutcome, { ok: false }>['kind'];

const meta: McpRequestMeta = { tenantId: 'test-tenant', environmentId: 'dev', correlationId: 'corr-errors-spec' };

/** The twenty-seven codes of the specification's table, in its order. */
const SPEC_CODES: string[] = [
  'invalid_request', 'principal_missing', 'service_unauthorised', 'scope_mismatch', 'release_unavailable', 'release_mismatch', 'not_configured',
  'refused_by_rule', 'no_match', 'ambiguous', 'key_table_unavailable', 'deadline_exceeded', 'source_not_connected', 'source_not_authorised',
  'source_not_found', 'source_rate_limited', 'source_timeout', 'source_unavailable', 'source_rejected', 'source_bad_arguments', 'source_internal',
  'source_shape_mismatch', 'source_truncated', 'signal_input_unavailable', 'signal_setting_missing', 'signal_divisor_zero', 'internal_error',
];

/** The specification's table, one row per code: layer, retry, HTTP status. `null`: the code never fails a call by itself. */
const EXPECTED: Array<[JaxIqErrorCode, string, string, number | null]> = [
  ['invalid_request', 'request', 'no', 400],
  ['principal_missing', 'request', 'no', 401],
  ['service_unauthorised', 'request', 'no', 401],
  ['scope_mismatch', 'request', 'no', 403],
  ['release_unavailable', 'request', 'later', 503],
  ['release_mismatch', 'request', 'later', 409],
  ['not_configured', 'request', 'no', 503],
  ['refused_by_rule', 'request', 'no', 200],
  ['no_match', 'resolve', 'no', 200],
  ['ambiguous', 'resolve', 'no', 200],
  ['key_table_unavailable', 'request', 'yes', 503],
  ['deadline_exceeded', 'request', 'yes', 504],
  ['source_not_connected', 'system', 'no', null],
  ['source_not_authorised', 'system', 'no', null],
  ['source_not_found', 'system', 'no', null],
  ['source_rate_limited', 'system', 'cool_down', null],
  ['source_timeout', 'system', 'yes', null],
  ['source_unavailable', 'system', 'yes', null],
  ['source_rejected', 'system', 'no', null],
  ['source_bad_arguments', 'system', 'no', null],
  ['source_internal', 'system', 'no', null],
  ['source_shape_mismatch', 'system', 'no', null],
  ['source_truncated', 'system', 'no', null],
  ['signal_input_unavailable', 'signal', 'no', null],
  ['signal_setting_missing', 'signal', 'no', null],
  ['signal_divisor_zero', 'signal', 'no', null],
  ['internal_error', 'request', 'yes', 500],
  // Added by the build plan.
  ['not_read_only', 'system', 'no', null],
  ['principal_not_staff', 'request', 'no', 403],
  ['source_not_set_up', 'system', 'no', null],
];

/** A made-up system that fails the way the real connectors do: through the same server, the same `ToolError` and the same status mapping. */
const fakeConnector = (missing: string[] = []): RealConnector => ({
  connectorId: 'fake', title: 'Fake', description: 'A made-up system.', required: ['FAKE_SETTING'], missing: () => missing,
  tools: [
    { name: 'echo', description: 'Echoes.', readOnly: true, inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, run: async (args) => ({ echoed: args.text }) },
    {
      name: 'fail_status', description: 'Fails as the vendor client does for an HTTP status.', readOnly: true,
      inputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'integer' } } },
      run: async (args) => { throw errorFor('Test system', args.status, 'made-up detail'); },
    },
    {
      name: 'fail_code', description: 'Fails with the named connector code.', readOnly: true,
      inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
      run: async (args) => { throw new ToolError(args.code, 'Made-up words.'); },
    },
    { name: 'crash', description: 'Fails with an error nobody named.', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: async () => { throw new Error('boom at a made-up place'); } },
  ],
});

const through = (handle: (message: any) => unknown) => new McpClient(new InProcessMcpTransport((message) => handle(message) as any), 'fake');

/** What the real client hands back for a tool that answered with an error. */
async function answerOf(server: RealConnectorServer, tool: string, args: Record<string, unknown>) {
  const client = through((message) => server.handle('fake', message));
  try {
    const out = await client.callTool(tool, args, meta);
    assert.equal(out.isError, true, `${tool} should have answered with an error`);
    return out;
  } finally {
    await client.close();
  }
}

const connectorCodeOf = (text: string): string => JSON.parse(text).error.code;

/** Runs an action through the real client over a fake `fetch` and returns what it threw. */
async function thrownBy(fetchImpl: typeof fetch, timeoutMs?: number): Promise<Error> {
  const client = new McpClient(new HttpMcpTransport({ url: 'http://connector.invalid/mcp/fake', fetchImpl }), 'fake');
  try {
    await client.callTool('echo', { text: 'hi' }, meta, timeoutMs ? { timeoutMs } : {});
  } catch (error) {
    return error as Error;
  } finally {
    await client.close();
  }
  throw new Error('the call should have failed');
}

const reply = (status: number, body: string, type = 'text/plain') => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

async function main() {
  await suite.test('there are thirty codes: the specification\'s twenty-seven in its order, then the three the plan added, each once', () => {
    assert.equal(JAX_IQ_ERROR_CODES.length, 30);
    assert.deepEqual(JAX_IQ_ERROR_CODES.slice(0, 27), SPEC_CODES);
    assert.deepEqual(JAX_IQ_ERROR_CODES.slice(27), ['not_read_only', 'principal_not_staff', 'source_not_set_up']);
    assert.equal(new Set(JAX_IQ_ERROR_CODES).size, 30);
    for (const code of JAX_IQ_ERROR_CODES) assert.equal(isJaxIqErrorCode(code), true, code);
    for (const other of ['', 'source', 'SOURCE_TIMEOUT', 'constructor', '__proto__', undefined, null, 7, {}]) assert.equal(isJaxIqErrorCode(other), false, String(other));
  });

  await suite.test('the table has a row for every code with the layer, retry rule and HTTP status of the specification', () => {
    assert.deepEqual(Object.keys(JAX_IQ_ERROR_TABLE).sort(), [...JAX_IQ_ERROR_CODES].sort());
    assert.deepEqual(EXPECTED.map(([code]) => code), [...JAX_IQ_ERROR_CODES], 'the expectations below cover every code, in the same order');
    for (const [code, layer, retry, httpStatus] of EXPECTED) {
      const row = JAX_IQ_ERROR_TABLE[code];
      assert.equal(row.layer, layer, `${code} layer`);
      assert.equal(row.retry, retry, `${code} retry`);
      assert.equal(row.httpStatus, httpStatus, `${code} HTTP status`);
    }
    assert.equal(JAX_IQ_ERROR_TABLE.deadline_exceeded.partialHttpStatus, 200, 'a deadline that passed after something answered is a partial answer');
    assert.deepEqual(Object.entries(JAX_IQ_ERROR_TABLE).filter(([, row]) => row.partialHttpStatus !== undefined).map(([code]) => code), ['deadline_exceeded']);
  });

  await suite.test('a system or signal code never fails a call by itself, and every request code names a status', () => {
    for (const [code, row] of Object.entries(JAX_IQ_ERROR_TABLE)) {
      if (row.layer === 'system' || row.layer === 'signal') assert.equal(row.httpStatus, null, code);
      else assert.equal(typeof row.httpStatus, 'number', code);
    }
    assert.equal(JAX_IQ_ERROR_TABLE.source_rate_limited.retry, 'cool_down');
    assert.deepEqual(
      Object.entries(JAX_IQ_ERROR_TABLE).filter(([, row]) => row.layer === 'system' && row.retry === 'yes').map(([code]) => code).sort(),
      ['source_timeout', 'source_unavailable'],
      'only a timeout and an unavailable system are worth another try',
    );
  });

  await suite.test('the two defect codes are flagged as alerts, and so is a sign-in the vendor refuses; nothing else is', () => {
    const flagged = (flag: 'defect' | 'alert') => Object.entries(JAX_IQ_ERROR_TABLE).filter(([, row]) => row[flag]).map(([code]) => code).sort();
    assert.deepEqual(flagged('defect'), ['source_bad_arguments', 'source_shape_mismatch']);
    assert.deepEqual(flagged('alert'), ['source_bad_arguments', 'source_not_authorised', 'source_shape_mismatch']);
    for (const defect of flagged('defect')) assert.equal(JAX_IQ_ERROR_TABLE[defect as JaxIqErrorCode].alert, true, defect);
  });

  await suite.test('what the assistant is told is plain: nothing for a caller\'s identity, a sentence for the rest, and no address, path or number in any of them', () => {
    const silent = Object.entries(JAX_IQ_ERROR_TABLE).filter(([, row]) => row.said === null).map(([code]) => code).sort();
    assert.deepEqual(silent, ['principal_missing', 'principal_not_staff', 'scope_mismatch', 'service_unauthorised']);
    for (const [code, row] of Object.entries(JAX_IQ_ERROR_TABLE)) {
      if (row.said === null) continue;
      assert.match(row.said, /^[A-Z<].*[.?]$/, code);
      assert.doesNotMatch(row.said, /https?:|[\d/\\@]/i, `${code} says "${row.said}"`);
    }
    for (const code of ['source_not_connected', 'source_not_authorised', 'source_not_found', 'source_rate_limited', 'source_timeout', 'source_unavailable']) {
      assert.match(JAX_IQ_ERROR_TABLE[code as JaxIqErrorCode].said!, /<System>/, `${code} names the system`);
    }
  });

  await suite.test('each connector code the servers send, read from the real answer text, maps to the intended JAX IQ code, with or without the kind and the code read first', async () => {
    const statuses: Array<[number, JaxIqErrorCode]> = [
      [400, 'source_rejected'], [401, 'source_not_authorised'], [403, 'source_not_authorised'], [404, 'source_not_found'], [409, 'source_rejected'],
      [422, 'source_rejected'], [429, 'source_rate_limited'], [500, 'source_unavailable'], [503, 'source_unavailable'],
    ];
    const server = new RealConnectorServer({ connectors: [fakeConnector()], warn: () => undefined });
    const cases: Array<{ answer: Awaited<ReturnType<typeof answerOf>>; expected: JaxIqErrorCode }> = [];
    for (const [status, expected] of statuses) cases.push({ answer: await answerOf(server, 'fail_status', { status }), expected });
    for (const [code, expected] of [['timeout', 'source_timeout'], ['not_set_up', 'source_not_set_up']] as const) cases.push({ answer: await answerOf(server, 'fail_code', { code }), expected });
    cases.push({ answer: await answerOf(server, 'echo', {}), expected: 'source_bad_arguments' });
    cases.push({ answer: await answerOf(server, 'crash', {}), expected: 'source_internal' });
    const offline = new RealConnectorServer({ connectors: [fakeConnector(['FAKE_SETTING'])], warn: () => undefined });
    cases.push({ answer: await answerOf(offline, 'echo', { text: 'hi' }), expected: 'source_not_connected' });

    const seen = new Set(cases.map(({ answer }) => connectorCodeOf(answer.text)));
    assert.deepEqual([...seen].sort(), ['conflict', 'internal_error', 'invalid_arguments', 'not_authorised', 'not_connected', 'not_found', 'not_set_up', 'rate_limited', 'rejected', 'timeout', 'unavailable'],
      'the cases cover all eleven codes the servers send');
    for (const { answer, expected } of cases) {
      const code = connectorCodeOf(answer.text);
      assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: answer.text }), expected, `${code}, kind and text`);
      assert.equal(classifyConnectorFailure({ message: answer.text }), expected, `${code}, text only`);
      assert.equal(classifyConnectorFailure({ kind: 'tool_error', code, message: 'words that say nothing' }), expected, `${code}, code read first`);
      assert.equal(classifyConnectorFailure({ code, message: '' }), expected, `${code}, code only`);
    }
  });

  await suite.test('the sample connectors\' own error answer is read the same way', async () => {
    const server = new SampleConnectorServer({ tenants: ['test-tenant'], now: () => new Date('2026-09-01T10:00:00Z') });
    const client = through((message) => server.handle('ace-erp', 'test-tenant', message));
    try {
      const out = await client.callTool('account_balance', {}, meta);
      assert.equal(out.isError, true);
      assert.equal(connectorCodeOf(out.text), 'invalid_arguments');
      assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: out.text }), 'source_bad_arguments');
    } finally {
      await client.close();
    }
  });

  await suite.test('an answer cut at the size cap, or quoted inside the dispatcher\'s message, still gives its code', async () => {
    const server = new RealConnectorServer({ connectors: [fakeConnector()], warn: () => undefined });
    const { text } = await answerOf(server, 'fail_status', { status: 429 });
    const cut = text.slice(0, text.indexOf('"message"') + 12);
    assert.throws(() => JSON.parse(cut), 'the cut text is no longer JSON');
    assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: cut }), 'source_rate_limited');
    // The wording of the dispatcher in the SDK when a tool answers with an error: the tool's text follows the colon, capped at 400 characters.
    const quoted = `The tool 'fail_status' on 'fake' reported an error: ${text}`.slice(0, 400);
    assert.equal(classifyConnectorFailure({ message: quoted }), 'source_rate_limited');
    assert.equal(classifyConnectorFailure({ message: "The tool 'echo' on 'fake' reported an error: no detail given" }), 'source_internal');
  });

  await suite.test('a code nobody named, a text with no code and a code that is a built-in property name are a failure the system did not explain', () => {
    assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: JSON.stringify({ ok: false, error: { code: 'brand_new_code', message: 'Words.' } }) }), 'source_internal');
    assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: JSON.stringify({ ok: false, error: 'a plain string' }) }), 'source_internal');
    assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: 'plain words' }), 'source_internal');
    assert.equal(classifyConnectorFailure({ message: '' }), 'source_internal');
    for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(classifyConnectorFailure({ kind: 'tool_error', code, message: '' }), 'source_internal', code);
    assert.equal(classifyConnectorFailure({ kind: 'tool_error', message: '{"ok":false,"error":{"code":"unavailable","message":"Zendesk answered HTTP 404"}}' }), 'source_unavailable',
      'words in a vendor message do not change a code the connector sent');
  });

  await suite.test('each message the MCP client and transport throw maps to the intended code, whether the kind is given or not', async () => {
    // A call that never answers. The client's own timeout timer does not keep the process alive, so this one does until the abort comes.
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => undefined, 5000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal!.reason); });
    })) as unknown as typeof fetch;
    const unreachable = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
    const server = new RealConnectorServer({ connectors: [fakeConnector()], warn: () => undefined });
    const protocol = await (async () => {
      const client = through((message) => server.handle('fake', message));
      try { await client.callTool('no_such_tool', {}, meta); } catch (error) { return error as Error; } finally { await client.close(); }
      throw new Error('an unknown tool should have failed');
    })();

    const cases: Array<[string, Error, FailedKind, JaxIqErrorCode]> = [
      ['no answer in time', await thrownBy(hang, 20), 'timeout', 'source_timeout'],
      ['HTTP 502', await thrownBy(reply(502, 'upstream down')), 'transport', 'source_unavailable'],
      ['HTTP 503', await thrownBy(reply(503, 'busy')), 'transport', 'source_unavailable'],
      ['HTTP 401', await thrownBy(reply(401, 'no')), 'transport', 'source_rejected'],
      ['HTTP 404', await thrownBy(reply(404, 'no such connector')), 'transport', 'source_rejected'],
      ['could not reach', await thrownBy(unreachable), 'transport', 'source_unavailable'],
      ['an empty event stream', await thrownBy(reply(200, '', 'text/event-stream')), 'transport', 'source_unavailable'],
      ['an answer that is not JSON', await thrownBy(reply(200, 'not json')), 'transport', 'source_unavailable'],
      ['a JSON-RPC error', protocol, 'protocol', 'source_internal'],
    ];
    for (const [name, error, kind, expected] of cases) {
      assert.equal(classifyConnectorFailure({ kind, message: error.message }), expected, `${name}, with the kind`);
      assert.equal(classifyConnectorFailure({ message: error.message }), expected, `${name}, message only: "${error.message}"`);
    }
  });

  await suite.test('a server that is not configured, a secret that is not set and an address the SDK refuses are all `not_configured`', async () => {
    const pool = new McpClientPool({ directory: new StaticMcpServerDirectory({}) });
    const noServer = await pool.getClient('ghost', { tenantId: 'test-tenant', environmentId: 'dev' }).then(() => undefined, (error: Error) => error);
    const noSecret = await new EnvSecretResolver({}).resolve('connectors/some-name').then(() => undefined, (error: Error) => error);
    const messages = [
      noServer?.message, noSecret?.message,
      (() => { try { assertSafeMcpUrl('ftp://connector.invalid/mcp'); } catch (error) { return (error as Error).message; } })(),
      (() => { try { assertSafeMcpUrl('http://user:pass@connector.invalid/mcp'); } catch (error) { return (error as Error).message; } })(),
      (() => { try { assertSecretRefInScope('not-a-reference', { tenantId: 'test-tenant', environmentId: 'dev' }); } catch (error) { return (error as Error).message; } })(),
    ];
    assert.ok(messages.every((message) => typeof message === 'string'), `every message was thrown: ${JSON.stringify(messages)}`);
    for (const message of messages as string[]) {
      assert.equal(classifyConnectorFailure({ kind: 'not_configured', message }), 'not_configured', message);
      assert.equal(classifyConnectorFailure({ message }), 'not_configured', message);
    }
  });

  await suite.test('a status is read before the words in a response body, and a kind that says enough is not overruled by the words', () => {
    assert.equal(classifyConnectorFailure({ kind: 'transport', message: 'The MCP server answered HTTP 502: the connector is not configured' }), 'source_unavailable');
    assert.equal(classifyConnectorFailure({ message: 'The MCP server answered HTTP 404: it did not answer within the hour' }), 'source_rejected');
    assert.equal(classifyConnectorFailure({ message: 'The MCP server answered HTTP 200: fine' }), 'source_internal', 'a good status is not a failure to read');
    assert.equal(classifyConnectorFailure({ kind: 'transport', message: 'something nobody has seen' }), 'source_unavailable');
    assert.equal(classifyConnectorFailure({ kind: 'timeout', message: 'no words about time' }), 'source_timeout');
    assert.equal(classifyConnectorFailure({ kind: 'not_configured', message: 'HTTP 503' }), 'not_configured');
    assert.equal(classifyConnectorFailure({ kind: 'not_read_only', message: 'The tool is not marked read only.' }), 'not_read_only');
    assert.equal(classifyConnectorFailure({ kind: 'protocol', code: '-32602', message: 'Unknown tool: x' }), 'source_internal');
  });

  await suite.test('a failed ConnectorOutcome goes straight in', () => {
    const failed: ConnectorOutcome = { ok: false, kind: 'tool_error', code: 'rate_limited', message: 'Made-up words.' };
    if (failed.ok) assert.fail('the outcome is a failure');
    else assert.equal(classifyConnectorFailure(failed), 'source_rate_limited');
  });

  await suite.test('the retry rule the table gives is what the classifier\'s codes need: a timeout and an unavailable system are tried again, a rate limit is cooled down', () => {
    const retryable = (code: JaxIqErrorCode) => JAX_IQ_ERROR_TABLE[code].retry;
    assert.equal(retryable(classifyConnectorFailure({ kind: 'timeout', message: '' })), 'yes');
    assert.equal(retryable(classifyConnectorFailure({ code: 'unavailable', message: '' })), 'yes');
    assert.equal(retryable(classifyConnectorFailure({ code: 'rate_limited', message: '' })), 'cool_down');
    for (const code of ['not_authorised', 'not_found', 'not_connected', 'rejected', 'invalid_arguments', 'conflict', 'not_set_up', 'internal_error']) {
      assert.equal(retryable(classifyConnectorFailure({ code, message: '' })), 'no', code);
    }
  });

  await suite.test('a release source answers with a release or a failure, and the failure is told apart without reading its fields', async () => {
    const loaded: LoadedRelease = { version: 'test-release-1', checksum: 'test-checksum-1', ontology: minimalDictionary, connectors: connectorsFixture };
    const failure: ReleaseFailure = { ok: false, code: 'release_unavailable', reason: 'ontology_disabled', message: 'The release has no dictionary.' };
    const source: ReleaseSource = {
      async load(tenantId, environmentId, pin) {
        if (tenantId === 'test-tenant' && environmentId === 'dev' && (!pin || (pin.version === loaded.version && pin.checksum === loaded.checksum))) return loaded;
        return failure;
      },
    };
    const first = await source.load('test-tenant', 'dev');
    assert.equal(isReleaseFailure(first), false);
    if (!isReleaseFailure(first)) assert.equal(first.ontology.ontologyId, minimalDictionary.ontologyId);
    const second = await source.load('test-tenant', 'dev', { version: 'test-release-1', checksum: 'another' });
    assert.equal(isReleaseFailure(second), true);
    if (isReleaseFailure(second)) {
      assert.equal(second.code, 'release_unavailable');
      assert.equal(JAX_IQ_ERROR_TABLE[second.code].httpStatus, 503);
    }
    const mismatch: ReleaseFailure = { ok: false, code: 'release_mismatch', reason: 'checksum_mismatch', message: 'The pinned release differs.' };
    assert.equal(JAX_IQ_ERROR_TABLE[mismatch.code].httpStatus, 409);
    const reasons: ReleaseFailureReason[] = ['malformed_envelope', 'withdrawn', 'incomplete_content', 'unsupported_checksum_version', 'semantic_invalid', 'missing_checksum', 'checksum_mismatch',
      'pointer_checksum_mismatch', 'identity_mismatch', 'scope_mismatch', 'ontology_disabled', 'ontology_invalid', 'no_active_release'];
    assert.equal(new Set(reasons).size, 13);
  });

  await suite.test('the errors and ports modules export the names the plan gives them and nothing else that could collide with a sibling module', () => {
    assert.deepEqual(Object.keys(errorsModule).sort(), ['JAX_IQ_ERROR_CODES', 'JAX_IQ_ERROR_TABLE', 'classifyConnectorFailure', 'isJaxIqErrorCode']);
    assert.deepEqual(Object.keys(portsModule).sort(), ['isReleaseFailure']);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
