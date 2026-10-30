import './setup/no-world';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createSuite } from '@journeyax/test-support';
import { HttpMcpTransport, McpClient, type McpRequestMeta } from '@journeyax/capability-sdk';
import * as scopeModule from '../src/scope';
import { CallScopeSchema, MemoryJtiStore, SCOPE_HEADER, hashScopeArguments, signScope, verifyScope } from '../src/scope';
import type { CallScope, ScopeRefusal, ScopeVerdict, VerifyScopeOptions } from '../src/scope';

/**
 * The caller scope: a signed statement of who is asking, which tool the call is for and that the tool state was `allow`, with a hash of the
 * arguments and the names of the fields the person may see. The reference verifier is what a connector service could run later; this spec
 * proves each refusal it makes, and that the one header a client sends on all three messages of a call is read the way section 10 says.
 */
const suite = createSuite('jax-iq: the caller scope, its signature and the reference verifier');

// TEST FIXTURE ONLY: every value below is made up for this spec. None is a business value, a real secret or a real id.
const SECRET = 'testfixture.scope-secret-0001';
const OTHER_SECRET = 'testfixture.scope-secret-0002';
const TENANT = 'test-tenant';
const ENVIRONMENT = 'test-env';
const CONNECTOR = 'test-erp';
/** A second connector that has a tool of the same name as one of the first, as two real connectors can. */
const OTHER_CONNECTOR = 'test-crm';
const SHARED_TOOL = 'find_account';
const TOOL = 'account_balance';
const ARGS = { accountId: 'ACC-0001', filter: { status: 'open', limit: 5 } };
const ISSUED = Date.parse('2026-10-29T09:00:00Z') / 1000;
/** TEST FIXTURE ONLY: the real lifetime is a setting of the service that nobody has set. */
const LIFETIME_SECONDS = 120;
const SRC = path.resolve(__dirname, '../src/scope');

/** A time `seconds` after the scope was issued. */
const at = (seconds: number) => new Date((ISSUED + seconds) * 1000);
const NOW = at(10);

const scopeFixture = (over: Partial<CallScope> = {}): CallScope => ({
  v: 1,
  tenantId: TENANT,
  environmentId: ENVIRONMENT,
  queryId: 'query-0001',
  correlationId: 'corr-0001',
  principal: { id: 'person-0001', audience: 'staff', groups: ['test-team'] },
  connectorId: CONNECTOR,
  tool: TOOL,
  toolState: 'allow',
  toolStateVia: 'tool',
  capRuleIds: ['rule-test-see'],
  argsHash: hashScopeArguments(ARGS),
  fields: ['record.balance', 'record.overdue'],
  release: { version: 'test-1', checksum: 'testchecksum0001' },
  iat: ISSUED,
  exp: ISSUED + LIFETIME_SECONDS,
  jti: 'jti-0001',
  ...over,
});

// The scope type and its schema agree both ways. `tsc:jax-iq` fails here when they drift.
type Agree<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ScopeTypesAgree = [Assert<Agree<z.infer<typeof CallScopeSchema>, CallScope>>];

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
/** A header made here with node:crypto alone, from any payload: the way to test what the verifier does with a body the signer would never write. */
const forge = (payload: unknown, secret: string = SECRET): string => {
  const part = b64(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `${part}.${createHmac('sha256', secret).update(part).digest('base64url')}`;
};
const payloadOf = (header: string): any => JSON.parse(Buffer.from(header.split('.')[0], 'base64url').toString('utf8'));
const reverseKeys = (value: any): any => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]))
  : value);

const clockAt = (date: Date) => ({ now: () => date });
const check = (header: string | undefined | null, over: Partial<VerifyScopeOptions> = {}): ScopeVerdict => verifyScope(header, {
  secret: SECRET,
  now: NOW,
  method: 'tools/call',
  tenantHeader: TENANT,
  environmentHeader: ENVIRONMENT,
  connectorId: CONNECTOR,
  toolName: TOOL,
  argsHash: hashScopeArguments(ARGS),
  seen: new MemoryJtiStore(clockAt(NOW)),
  ...over,
});
const accepted = (verdict: ScopeVerdict): CallScope => {
  assert.equal(verdict.ok, true, verdict.ok ? '' : `${verdict.reason}: ${verdict.message}`);
  return (verdict as { ok: true; scope: CallScope }).scope;
};
const refused = (verdict: ScopeVerdict, reason: ScopeRefusal) => {
  assert.equal(verdict.ok, false, `should be refused as ${reason}`);
  if (!verdict.ok) {
    assert.equal(verdict.reason, reason);
    assert.ok(verdict.message.length > 0, 'a refusal carries a message');
  }
};
const thrownMessage = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error: any) {
    return String(error?.message ?? error);
  }
  return assert.fail('should have thrown');
};

async function main() {
  await suite.test('a signed scope verifies on tools/call and comes back exactly as it was signed', () => {
    const signed = signScope(scopeFixture(), SECRET);
    assert.deepEqual(signed.scope, scopeFixture());
    assert.deepEqual(accepted(check(signed.header)), scopeFixture());
    assert.equal(SCOPE_HEADER, 'X-Caller-Scope');
  });

  await suite.test('the header is two base64url parts: the scope as JSON, then the HMAC-SHA256 of the first part, worked out here with node:crypto', () => {
    const signed = signScope(scopeFixture(), SECRET);
    const parts = signed.header.split('.');
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^[A-Za-z0-9_-]+$/);
    assert.match(parts[1], /^[A-Za-z0-9_-]{43}$/, 'a SHA-256 digest in base64url, no padding');
    assert.deepEqual(payloadOf(signed.header), scopeFixture());
    assert.equal(parts[1], createHmac('sha256', SECRET).update(parts[0]).digest('base64url'));
    assert.equal(signed.header, forge(payloadOf(signed.header)), 'a header made by hand from the same JSON is the same header');
    assert.doesNotMatch(signed.header, /\s/, 'fit for an HTTP header value');
  });

  await suite.test('the same scope gives the same header whatever order its keys were written in, and a secret given as bytes works like the same text', () => {
    const plain = signScope(scopeFixture(), SECRET).header;
    assert.equal(signScope(reverseKeys(scopeFixture()), SECRET).header, plain);
    assert.equal(signScope(scopeFixture(), Buffer.from(SECRET, 'utf8')).header, plain);
    assert.notEqual(signScope(scopeFixture({ jti: 'jti-0002' }), SECRET).header, plain);
    assert.notEqual(signScope(scopeFixture(), OTHER_SECRET).header, plain);
    accepted(check(signScope(scopeFixture(), Buffer.from(SECRET, 'utf8')).header, { secret: Buffer.from(SECRET, 'utf8') }));
  });

  await suite.test('a wrong tool is refused, on tools/call a missing tool name too', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    refused(check(header, { toolName: 'list_account_balances' }), 'wrong_tool');
    refused(check(header, { toolName: 'ACCOUNT_BALANCE' }), 'wrong_tool');
    refused(check(header, { toolName: undefined }), 'wrong_tool');
  });

  await suite.test('a wrong tenant and a wrong environment are refused', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    refused(check(header, { tenantHeader: 'other-tenant' }), 'wrong_tenant');
    refused(check(header, { tenantHeader: '' }), 'wrong_tenant');
    refused(check(header, { environmentHeader: 'other-env' }), 'wrong_environment');
    refused(check(header, { environmentHeader: '' }), 'wrong_environment');
    accepted(check(header));
  });

  await suite.test('a scope made for one connector is refused by a verifier that serves another, even when tenant, environment and tool name match', () => {
    // Two connectors that both have a tool called find_account: only the connector tells the two scopes apart.
    const forOther = signScope(scopeFixture({ connectorId: OTHER_CONNECTOR, tool: SHARED_TOOL }), SECRET).header;
    const serving = (connectorId: string | undefined) => check(forOther, { toolName: SHARED_TOOL, connectorId });
    refused(serving(CONNECTOR), 'wrong_connector');
    refused(serving('Test-CRM'), 'wrong_connector');
    refused(serving(`${OTHER_CONNECTOR}-2`), 'wrong_connector');
    refused(serving('test'), 'wrong_connector');
    refused(serving(''), 'wrong_connector');
    assert.equal(accepted(serving(OTHER_CONNECTOR)).connectorId, OTHER_CONNECTOR);
    // The scope made for the first connector is refused the other way round.
    const forFirst = signScope(scopeFixture({ tool: SHARED_TOOL }), SECRET).header;
    refused(check(forFirst, { toolName: SHARED_TOOL, connectorId: OTHER_CONNECTOR }), 'wrong_connector');
    accepted(check(forFirst, { toolName: SHARED_TOOL, connectorId: CONNECTOR }));
    // A scope cannot be re-labelled for another connector: the body is signed.
    assert.equal(payloadOf(forFirst).connectorId, CONNECTOR);
    refused(check(`${b64(JSON.stringify({ ...payloadOf(forFirst), connectorId: OTHER_CONNECTOR }))}.${forFirst.split('.')[1]}`, { toolName: SHARED_TOOL, connectorId: OTHER_CONNECTOR }), 'bad_signature');
  });

  await suite.test('the connector is checked on the handshake messages too, so a header seen on initialize cannot be carried to another connector before the call', () => {
    const header = signScope(scopeFixture({ connectorId: OTHER_CONNECTOR, tool: SHARED_TOOL }), SECRET).header;
    const seen = new MemoryJtiStore(clockAt(NOW));
    for (const method of ['initialize', 'notifications/initialized']) {
      const handshake = (connectorId: string) => check(header, { seen, method, connectorId, toolName: undefined, argsHash: undefined });
      refused(handshake(CONNECTOR), 'wrong_connector');
      accepted(handshake(OTHER_CONNECTOR));
    }
    // The wrong connector's call is refused and leaves the jti alone, so the connector the scope was made for still accepts it once.
    refused(check(header, { seen, toolName: SHARED_TOOL, connectorId: CONNECTOR }), 'wrong_connector');
    assert.equal(seen.size, 0);
    accepted(check(header, { seen, toolName: SHARED_TOOL, connectorId: OTHER_CONNECTOR }));
    assert.equal(seen.size, 1);
    refused(check(header, { seen, toolName: SHARED_TOOL, connectorId: OTHER_CONNECTOR }), 'replayed');
    refused(check(header, { seen, toolName: SHARED_TOOL, connectorId: CONNECTOR }), 'wrong_connector');
  });

  await suite.test('without a connector id the connector check is skipped, as the arguments check is without a hash; a verifier that serves a connector gives it', () => {
    const forOther = signScope(scopeFixture({ connectorId: OTHER_CONNECTOR, tool: SHARED_TOOL }), SECRET).header;
    accepted(check(forOther, { toolName: SHARED_TOOL, connectorId: undefined }));
    accepted(check(signScope(scopeFixture(), SECRET).header, { connectorId: undefined }));
    // The test default gives the connector, so every other test here ran with the check on.
    refused(check(forOther, { toolName: SHARED_TOOL }), 'wrong_connector');
  });

  await suite.test('a toolState other than allow is refused by the verifier, and the signer will not write one', () => {
    for (const state of ['blocked', 'ask', 'deny', '', 'ALLOW']) {
      refused(check(forge({ ...scopeFixture(), toolState: state })), 'tool_state_not_allow');
    }
    const { toolState, ...without } = scopeFixture();
    assert.equal(toolState, 'allow');
    refused(check(forge(without)), 'tool_state_not_allow');
    for (const state of ['blocked', 'ask']) {
      assert.match(thrownMessage(() => signScope({ ...scopeFixture(), toolState: state } as unknown as CallScope, SECRET)), /toolState/);
    }
  });

  await suite.test('an expired scope is refused from the second it expires; one millisecond before is still good; a time that is not a time counts as expired', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const exp = ISSUED + LIFETIME_SECONDS;
    accepted(check(header, { now: new Date(exp * 1000 - 1) }));
    refused(check(header, { now: new Date(exp * 1000) }), 'expired');
    refused(check(header, { now: new Date(exp * 1000 + 1) }), 'expired');
    refused(check(header, { now: at(LIFETIME_SECONDS + 3600) }), 'expired');
    refused(check(header, { now: new Date(Number.NaN) }), 'expired');
    refused(check(header, { now: new Date('not a date') }), 'expired');
    refused(check(header, { now: new Date(Number.NaN), method: 'initialize', toolName: undefined, argsHash: undefined }), 'expired');
  });

  await suite.test('a tampered body, a tampered signature, another secret and a cut header are each refused', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const [payloadPart, signaturePart] = header.split('.');
    // The body changed to another tenant, the old signature kept.
    refused(check(`${b64(JSON.stringify({ ...scopeFixture(), tenantId: 'other-tenant' }))}.${signaturePart}`, { tenantHeader: 'other-tenant' }), 'bad_signature');
    // The fields widened.
    refused(check(`${b64(JSON.stringify({ ...scopeFixture(), fields: ['record'] }))}.${signaturePart}`), 'bad_signature');
    // One character of the body changed.
    const flip = (text: string) => `${text.slice(0, 5)}${text[5] === 'A' ? 'B' : 'A'}${text.slice(6)}`;
    refused(check(`${flip(payloadPart)}.${signaturePart}`), 'bad_signature');
    // One character of the signature changed, and the signature made for another secret.
    refused(check(`${payloadPart}.${flip(signaturePart)}`), 'bad_signature');
    refused(check(forge(scopeFixture(), OTHER_SECRET)), 'bad_signature');
    refused(check(header, { secret: OTHER_SECRET }), 'bad_signature');
    // A signature of the wrong length is a refusal, not an exception.
    refused(check(`${payloadPart}.${signaturePart.slice(0, 20)}`), 'bad_signature');
    refused(check(`${payloadPart}.${signaturePart}${signaturePart}`), 'bad_signature');
    refused(check(`${payloadPart}.A`), 'bad_signature');
    // A body signed by someone else cannot be moved under our signature either.
    const foreignBody = forge({ ...scopeFixture(), jti: 'jti-9' }, OTHER_SECRET).split('.')[0];
    refused(check(`${foreignBody}.${signaturePart}`), 'bad_signature');
  });

  await suite.test('a missing, empty or badly formed header is refused', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const [payloadPart, signaturePart] = header.split('.');
    refused(check(undefined), 'missing');
    refused(check(null), 'missing');
    refused(check(''), 'missing');
    refused(check(payloadPart), 'malformed');
    refused(check(`${payloadPart}.${signaturePart}.${signaturePart}`), 'malformed');
    refused(check(`${payloadPart}.`), 'malformed');
    refused(check(`.${signaturePart}`), 'malformed');
    refused(check(`${payloadPart} .${signaturePart}`), 'malformed');
    refused(check(`${payloadPart}.${signaturePart}\n`), 'malformed');
    refused(check(`Bearer ${header}`), 'malformed');
    refused(check(`${payloadPart}=.${signaturePart}`), 'malformed');
    refused(check(123 as unknown as string), 'missing');
  });

  await suite.test('a body the signer would never write is refused even with a good signature: other version, other shape, extra keys', () => {
    refused(check(forge({ ...scopeFixture(), v: 2 })), 'unsupported_version');
    refused(check(forge({ ...scopeFixture(), v: '1' })), 'unsupported_version');
    const { v, ...noVersion } = scopeFixture();
    assert.equal(v, 1);
    refused(check(forge(noVersion)), 'unsupported_version');
    refused(check(forge('this is not json')), 'malformed');
    refused(check(forge('[1,2,3]')), 'malformed');
    refused(check(forge('null')), 'malformed');
    refused(check(forge('"text"')), 'malformed');
    refused(check(forge({ ...scopeFixture(), arguments: ARGS })), 'malformed');
    refused(check(forge({ ...scopeFixture(), principal: { ...scopeFixture().principal, email: 'someone@example.test' } })), 'malformed');
    refused(check(forge({ ...scopeFixture(), principal: { ...scopeFixture().principal, audience: 'shopper' } })), 'malformed');
    refused(check(forge({ ...scopeFixture(), exp: undefined })), 'malformed');
    refused(check(forge({ ...scopeFixture(), exp: ISSUED })), 'malformed');
    refused(check(forge({ ...scopeFixture(), exp: 'soon' })), 'malformed');
    refused(check(forge({ ...scopeFixture(), argsHash: JSON.stringify(ARGS) })), 'malformed');
    refused(check(forge({ ...scopeFixture(), fields: ['record.balance', 'ACC-0001'] })), 'malformed');
    refused(check(forge({ ...scopeFixture(), fields: 'record.balance' })), 'malformed');
  });

  await suite.test('the same jti used on a second tools/call is refused', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const seen = new MemoryJtiStore(clockAt(NOW));
    accepted(check(header, { seen }));
    refused(check(header, { seen }), 'replayed');
    refused(check(header, { seen }), 'replayed');
    refused(check(header, { seen, now: at(60) }), 'replayed');
    // Another scope has another jti.
    accepted(check(signScope(scopeFixture({ jti: 'jti-0002' }), SECRET).header, { seen }));
  });

  await suite.test('the same jti on the two handshake messages is accepted, before and after the call, as often as they come; tools/call then uses it up once', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const seen = new MemoryJtiStore(clockAt(NOW));
    const handshake = (method: string, over: Partial<VerifyScopeOptions> = {}) => check(header, { seen, method, toolName: undefined, argsHash: undefined, ...over });
    accepted(handshake('initialize'));
    accepted(handshake('notifications/initialized'));
    accepted(check(header, { seen, method: 'tools/call' }));
    accepted(handshake('initialize'));
    accepted(handshake('notifications/initialized'));
    refused(check(header, { seen, method: 'tools/call' }), 'replayed');
    assert.equal(seen.size, 1, 'one jti is held, and only the call put it there');
    // The handshake alone does not use the jti up.
    const fresh = new MemoryJtiStore(clockAt(NOW));
    accepted(check(header, { seen: fresh, method: 'initialize', toolName: undefined, argsHash: undefined }));
    assert.equal(fresh.size, 0);
    accepted(check(header, { seen: fresh }));
  });

  await suite.test('a handshake message still needs a good, unexpired signature for this tenant, environment and connector, and a tool name it is given must match', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const handshake = (over: Partial<VerifyScopeOptions> = {}) => check(header, { method: 'initialize', toolName: undefined, argsHash: undefined, ...over });
    accepted(handshake());
    refused(handshake({ secret: OTHER_SECRET }), 'bad_signature');
    refused(handshake({ now: at(LIFETIME_SECONDS) }), 'expired');
    refused(handshake({ tenantHeader: 'other-tenant' }), 'wrong_tenant');
    refused(handshake({ environmentHeader: 'other-env' }), 'wrong_environment');
    refused(handshake({ connectorId: OTHER_CONNECTOR }), 'wrong_connector');
    refused(handshake({ toolName: 'list_account_balances' }), 'wrong_tool');
    refused(check(undefined, { method: 'notifications/initialized', toolName: undefined, argsHash: undefined }), 'missing');
    refused(check(forge({ ...scopeFixture(), toolState: 'blocked' }), { method: 'notifications/initialized', toolName: undefined, argsHash: undefined }), 'tool_state_not_allow');
  });

  await suite.test('a tools/call that is refused for another reason leaves its jti unused', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const seen = new MemoryJtiStore(clockAt(NOW));
    refused(check(header, { seen, toolName: 'list_account_balances' }), 'wrong_tool');
    refused(check(header, { seen, tenantHeader: 'other-tenant' }), 'wrong_tenant');
    refused(check(header, { seen, environmentHeader: 'other-env' }), 'wrong_environment');
    refused(check(header, { seen, connectorId: OTHER_CONNECTOR }), 'wrong_connector');
    refused(check(header, { seen, argsHash: hashScopeArguments({ accountId: 'ACC-0002' }) }), 'wrong_arguments');
    refused(check(header, { seen, now: at(LIFETIME_SECONDS) }), 'expired');
    assert.equal(seen.size, 0);
    accepted(check(header, { seen }));
    assert.equal(seen.size, 1);
  });

  await suite.test('the arguments must be the ones the scope was made for when the verifier gives their hash; without one the check is skipped', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    accepted(check(header, { argsHash: hashScopeArguments({ filter: { limit: 5, status: 'open' }, accountId: 'ACC-0001' }) }));
    refused(check(header, { argsHash: hashScopeArguments({ ...ARGS, accountId: 'ACC-0002' }) }), 'wrong_arguments');
    refused(check(header, { argsHash: hashScopeArguments({}) }), 'wrong_arguments');
    refused(check(header, { argsHash: '' }), 'wrong_arguments');
    accepted(check(header, { argsHash: undefined }));
  });

  await suite.test('a verifier with no secret refuses everything', () => {
    const { header } = signScope(scopeFixture(), SECRET);
    refused(check(header, { secret: '' }), 'no_secret');
    refused(check(header, { secret: new Uint8Array(0) }), 'no_secret');
    refused(check(header, { secret: undefined as unknown as string }), 'no_secret');
    refused(check(undefined, { secret: '' }), 'no_secret');
  });

  await suite.test('the scope holds an argument hash and field names, never argument values', () => {
    const signed = signScope(scopeFixture(), SECRET);
    const body = payloadOf(signed.header);
    assert.deepEqual(Object.keys(body).sort(), [
      'argsHash', 'capRuleIds', 'connectorId', 'correlationId', 'environmentId', 'exp', 'fields', 'iat', 'jti', 'principal', 'queryId', 'release', 'tenantId', 'tool', 'toolState', 'toolStateVia', 'v',
    ]);
    assert.equal(body.argsHash, hashScopeArguments(ARGS));
    assert.match(body.argsHash, /^[0-9a-f]{64}$/);
    const text = Buffer.from(signed.header.split('.')[0], 'base64url').toString('utf8');
    for (const value of ['ACC-0001', 'open', '"limit"', '"accountId"', '"filter"']) assert.ok(!text.includes(value), `${value} is not in the scope`);
    assert.ok(!signed.header.includes(b64('ACC-0001')), 'nor in the header');
    assert.deepEqual(body.fields, ['record.balance', 'record.overdue'], 'field names, as paths');
  });

  await suite.test('the argument hash is the same for the same arguments in any key order and differs for any other value', () => {
    const hash = hashScopeArguments(ARGS);
    assert.equal(hashScopeArguments({ filter: { limit: 5, status: 'open' }, accountId: 'ACC-0001' }), hash);
    assert.equal(hashScopeArguments(JSON.parse(JSON.stringify(ARGS))), hash);
    assert.equal(hashScopeArguments({ accountId: 'ACC-0001', filter: { status: 'open', limit: 5 }, skipped: undefined }), hash, 'a missing value is a missing key, as in JSON');
    assert.notEqual(hashScopeArguments({ ...ARGS, accountId: 'ACC-0002' }), hash);
    assert.notEqual(hashScopeArguments({ ...ARGS, filter: { status: 'open', limit: 6 } }), hash);
    assert.notEqual(hashScopeArguments({ accountId: 'ACC-0001', filter: { status: 'open', limit: '5' } }), hash, 'a number is not text');
    assert.notEqual(hashScopeArguments({ list: [1, 2] }), hashScopeArguments({ list: [2, 1] }), 'the order of a list matters');
    assert.notEqual(hashScopeArguments({}), hash);
    assert.match(hashScopeArguments({}), /^[0-9a-f]{64}$/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => hashScopeArguments(circular));
  });

  await suite.test('the signer refuses a scope that carries more than it should: arguments, free text as fields, wrong shapes, over-long lists', () => {
    const refuse = (over: Record<string, unknown>, mention: RegExp) => assert.match(thrownMessage(() => signScope({ ...scopeFixture(), ...over } as unknown as CallScope, SECRET)), mention);
    refuse({ args: ARGS }, /\bargs\b/);
    refuse({ arguments: ARGS }, /\barguments\b/);
    refuse({ argsHash: JSON.stringify(ARGS) }, /argsHash/);
    refuse({ argsHash: 'ABC' }, /argsHash/);
    refuse({ fields: ['ACC-0001'] }, /fields/);
    refuse({ fields: ['record.balance = 5'] }, /fields/);
    refuse({ fields: [''] }, /fields/);
    refuse({ fields: Array.from({ length: 101 }, (_, index) => `record.field${index}`) }, /fields/);
    refuse({ capRuleIds: Array.from({ length: 51 }, (_, index) => `rule-${index}`) }, /capRuleIds/);
    refuse({ principal: { id: 'person-0001', audience: 'staff', groups: Array.from({ length: 51 }, (_, index) => `team-${index}`) } }, /principal\.groups/);
    refuse({ principal: { id: 'person-0001', audience: 'shopper', groups: [] } }, /principal\.audience/);
    refuse({ principal: { id: '', audience: 'staff', groups: [] } }, /principal\.id/);
    refuse({ principal: { id: 'person-0001', audience: 'staff', groups: [], email: 'someone@example.test' } }, /principal\.email/);
    refuse({ v: 2 }, /\bv\b/);
    refuse({ toolStateVia: 'row' }, /toolStateVia/);
    refuse({ exp: ISSUED }, /\bexp\b/);
    refuse({ exp: ISSUED - 1 }, /\bexp\b/);
    refuse({ iat: ISSUED + 0.5 }, /\biat\b/);
    refuse({ iat: -1 }, /\biat\b/);
    refuse({ tenantId: '' }, /tenantId/);
    refuse({ connectorId: 'Test_Erp' }, /connectorId/);
    refuse({ tool: 'bad tool' }, /\btool\b/);
    refuse({ correlationId: 'line\nbreak' }, /correlationId/);
    refuse({ jti: '' }, /\bjti\b/);
    refuse({ release: { version: 'test-1' } }, /release/);
    assert.match(thrownMessage(() => signScope({ ...scopeFixture(), tenantId: '', jti: '' }, SECRET)), /tenantId.*jti|jti.*tenantId/, 'every problem is named');
    // What is allowed: an empty list of fields (the person may see none), an empty list of groups and rule ids, and the other two ways of reaching allow.
    signScope(scopeFixture({ fields: [], capRuleIds: [], principal: { id: 'person-0001', audience: 'staff', groups: [] } }), SECRET);
    signScope(scopeFixture({ toolStateVia: 'default' }), SECRET);
    signScope(scopeFixture({ fields: Array.from({ length: 100 }, (_, index) => `record.field${index}`) }), SECRET);
  });

  await suite.test('the signer refuses an empty secret, as text or as bytes', () => {
    for (const secret of ['', new Uint8Array(0), undefined as unknown as string, null as unknown as string]) {
      assert.match(thrownMessage(() => signScope(scopeFixture(), secret)), /without a secret/);
    }
  });

  await suite.test('no secret appears in any error text, any refusal, or any header', () => {
    const secrets = [SECRET, OTHER_SECRET];
    const leaks = (text: string) => secrets.some((secret) => text.includes(secret) || text.includes(b64(secret)) || text.includes(Buffer.from(secret).toString('hex')) || text.includes(Buffer.from(secret).toString('base64')));
    assert.equal(leaks(`x ${b64(SECRET)} y`), true, 'the check can see a leak');
    const texts: string[] = [];
    const { header } = signScope(scopeFixture(), SECRET);
    texts.push(header, JSON.stringify(signScope(scopeFixture(), SECRET)));
    const [payloadPart, signaturePart] = header.split('.');
    const refusals: Array<[string | undefined | null, Partial<VerifyScopeOptions>]> = [
      [header, { secret: OTHER_SECRET }], [header, { secret: '' }], [undefined, {}], [payloadPart, {}], [`${payloadPart}.${signaturePart.slice(1)}`, {}],
      [forge({ ...scopeFixture(), toolState: 'blocked' }), {}], [forge({ ...scopeFixture(), v: 2 }), {}], [forge('not json'), {}], [forge({ ...scopeFixture(), arguments: ARGS }), {}],
      [header, { toolName: 'other_tool' }], [header, { tenantHeader: 'other' }], [header, { environmentHeader: 'other' }], [header, { connectorId: 'other' }], [header, { now: at(LIFETIME_SECONDS) }], [header, { argsHash: 'x' }],
    ];
    for (const [value, over] of refusals) texts.push(JSON.stringify(check(value, over)));
    const seen = new MemoryJtiStore(clockAt(NOW));
    check(header, { seen });
    texts.push(JSON.stringify(check(header, { seen })));
    // Errors thrown while signing do not echo the values of the scope, even when a value is the secret.
    texts.push(thrownMessage(() => signScope({ ...scopeFixture(), principal: { id: SECRET, audience: 'shopper', groups: [SECRET] }, correlationId: SECRET, fields: [SECRET], toolState: 'blocked' } as unknown as CallScope, SECRET)));
    texts.push(thrownMessage(() => signScope(scopeFixture(), '')));
    for (const text of texts) assert.equal(leaks(text), false, `a secret is in: ${text.slice(0, 80)}`);
    // A verdict for an accepted scope holds the scope and nothing of the secret either.
    assert.equal(leaks(JSON.stringify(check(forge(scopeFixture()), { seen: new MemoryJtiStore(clockAt(NOW)) }))), false);
  });

  await suite.test('the memory jti store: first sight is false, the second is true, ids are independent, and an id is forgotten once its time has passed', () => {
    let now = at(0);
    const store = new MemoryJtiStore({ now: () => now });
    const exp = ISSUED + 60;
    assert.equal(store.seen('jti-a', exp), false);
    assert.equal(store.seen('jti-a', exp), true);
    assert.equal(store.seen('jti-b', exp + 30), false);
    assert.equal(store.seen('jti-a', exp), true);
    assert.equal(store.size, 2);
    now = at(61);
    assert.equal(store.seen('jti-b', exp + 30), true, 'jti-b is still held');
    assert.equal(store.size, 1, 'jti-a was forgotten');
    now = at(91);
    assert.equal(store.seen('jti-c', exp + 60), false);
    assert.equal(store.size, 1, 'jti-b was forgotten');
    // With no clock given the store uses the system clock; the time here is far ahead of any test run.
    const system = new MemoryJtiStore();
    const farFuture = Date.parse('2100-01-01T00:00:00Z') / 1000;
    assert.equal(system.seen('jti-a', farFuture), false);
    assert.equal(system.seen('jti-a', farFuture), true);
    assert.equal(new MemoryJtiStore().seen('jti-a', 1), false, 'an id that is already past is held for no time');
  });

  await suite.test('over the real MCP client and HTTP transport: the same header goes on initialize, initialized and tools/call, the call is accepted once, a second client with the same header is refused at the call, and a header made for another connector is refused at the first message', async () => {
    const { header } = signScope(scopeFixture(), SECRET);
    const seen = new MemoryJtiStore(clockAt(NOW));
    const log: Array<{ method: string; header: string | undefined; ok: boolean; reason?: string }> = [];
    // A server that runs in this process: no socket, the client's fetch is this function.
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const message = JSON.parse(init.body);
      const verdict = verifyScope(init.headers[SCOPE_HEADER], {
        secret: SECRET,
        now: NOW,
        method: message.method,
        tenantHeader: init.headers['X-Tenant-ID'],
        environmentHeader: init.headers['X-Environment-ID'],
        connectorId: CONNECTOR,
        toolName: message.method === 'tools/call' ? message.params?.name : undefined,
        argsHash: message.method === 'tools/call' ? hashScopeArguments(message.params?.arguments ?? {}) : undefined,
        seen,
      });
      log.push({ method: message.method, header: init.headers[SCOPE_HEADER], ok: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason }) });
      if (!verdict.ok) return new Response(JSON.stringify({ error: verdict.reason }), { status: 401 });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test-only', version: '0' } }
        : { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const meta: McpRequestMeta = { tenantId: TENANT, environmentId: ENVIRONMENT, correlationId: 'corr-0001', principalId: 'person-0001' };
    const clientFor = () => new McpClient(new HttpMcpTransport({ url: 'http://test-only.invalid/mcp/test-erp', headers: () => ({ [SCOPE_HEADER]: header }), fetchImpl }), 'test-erp');

    const first = clientFor();
    try {
      const out = await first.callTool(TOOL, ARGS, meta);
      assert.equal(out.isError, false);
      assert.deepEqual(out.data, { ok: true });
    } finally {
      await first.close();
    }
    assert.deepEqual(log.map((line) => [line.method, line.ok]), [['initialize', true], ['notifications/initialized', true], ['tools/call', true]]);
    assert.deepEqual([...new Set(log.map((line) => line.header))], [header], 'one header on all three messages');

    log.length = 0;
    const second = clientFor();
    try {
      await assert.rejects(() => second.callTool(TOOL, ARGS, meta), /401/);
    } finally {
      await second.close();
    }
    assert.deepEqual(log.map((line) => [line.method, line.ok, line.reason]), [['initialize', true, undefined], ['notifications/initialized', true, undefined], ['tools/call', false, 'replayed']]);

    log.length = 0;
    const third = new McpClient(new HttpMcpTransport({ url: 'http://test-only.invalid/mcp/test-erp', headers: () => ({ [SCOPE_HEADER]: signScope(scopeFixture({ jti: 'jti-0002' }), SECRET).header }), fetchImpl }), 'test-erp');
    try {
      await assert.rejects(() => third.callTool('list_account_balances', ARGS, meta), /401/);
    } finally {
      await third.close();
    }
    assert.deepEqual(log.map((line) => [line.method, line.ok, line.reason]), [['initialize', true, undefined], ['notifications/initialized', true, undefined], ['tools/call', false, 'wrong_tool']]);

    // A header made for another connector that has a tool of the same name is turned away at the first message, before any call.
    log.length = 0;
    const otherHeader = signScope(scopeFixture({ connectorId: OTHER_CONNECTOR, tool: SHARED_TOOL, jti: 'jti-0003' }), SECRET).header;
    const fourth = new McpClient(new HttpMcpTransport({ url: 'http://test-only.invalid/mcp/test-erp', headers: () => ({ [SCOPE_HEADER]: otherHeader }), fetchImpl }), 'test-erp');
    try {
      await assert.rejects(() => fourth.callTool(SHARED_TOOL, ARGS, meta), /401/);
    } finally {
      await fourth.close();
    }
    assert.deepEqual(log.map((line) => [line.method, line.ok, line.reason]), [['initialize', false, 'wrong_connector']]);
    assert.equal(seen.size, 1, 'the jti of that header was not used up: only the first call put one there');
  });

  await suite.test('the module reads no environment, compares signatures in constant time, and imports only node:crypto, zod and its own files', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts')).sort();
    assert.deepEqual(files, ['index.ts', 'jti.ts', 'sign.ts', 'types.ts', 'verify.ts']);
    for (const name of files) {
      const source = readFileSync(path.join(SRC, name), 'utf8');
      assert.ok(!/process\.env|process\.argv/.test(source), `${name} reads the environment`);
      assert.ok(!/\bfs\b|node:fs|node:net|node:http|\bfetch\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), `${name} touches files or the network`);
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        assert.ok(match[1].startsWith('./') || ['node:crypto', 'zod'].includes(match[1]), `${name} imports ${match[1]}`);
      }
    }
    const verify = readFileSync(path.join(SRC, 'verify.ts'), 'utf8');
    assert.match(verify, /timingSafeEqual/);
    assert.ok(!/signaturePart\s*[!=]==/.test(verify), 'the signature is not compared with ===');
  });

  await suite.test('the module index exports the scope names and nothing generic', () => {
    assert.deepEqual(Object.keys(scopeModule).sort(), ['CallScopeSchema', 'MemoryJtiStore', 'SCOPE_HEADER', 'hashScopeArguments', 'signScope', 'verifyScope']);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
