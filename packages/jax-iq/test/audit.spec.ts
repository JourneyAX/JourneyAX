import './setup/no-world';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ZodType } from 'zod';
import { createSuite } from '@journeyax/test-support';
import { UNATTRIBUTED_PRINCIPAL } from '@journeyax/shared-types';
import * as auditModule from '../src/audit';
import { AUDIT_CALL_CAP, AUDIT_FACT_NAME_CAP, MemoryAuditSink, buildAuditLine } from '../src/audit';
import type { AuditSink, JaxIqAuditLine, JaxIqAuditLineInput } from '../src/audit';
import { JAX_IQ_ERROR_CODES } from '../src/errors';
import { JaxOntologyReleaseSchema } from '../src/model';
import type { Clock } from '../src/ports';

/**
 * The audit line and its sink. The line is the record of one query for operators: it names what was asked and what answered, and it
 * never holds a value. Everything here is made up (TEST FIXTURE ONLY): the ids, the names, the durations and the "secrets", which are
 * not secrets and open nothing.
 */
const suite = createSuite('jax-iq: the audit line, its builder and the memory sink');

const clock: Clock = { now: () => new Date('2026-10-29T09:30:00.000Z') };

/** A line for a partly answered query about one account, with every field set. */
const full = (): JaxIqAuditLineInput => ({
  at: clock.now(), tenantId: 'test-tenant', environmentId: 'dev', correlationId: 'corr-test-1', queryId: 'query-test-1', op: 'get',
  principalId: 'user-test-1', audience: 'staff', groups: ['finance', 'sales'], thing: 'Account', canonicalId: 'ACC-TEST-1', resolvedBy: 'key',
  factsRead: ['Account.name', 'Account.tier'], factsUnavailable: ['Account.owner'], factsDenied: ['Account.balance', 'Account.creditLimit'],
  systems: [
    { system: 'ace-erp', tool: 'account_balance', outcome: 'success', durationMs: 12, attempts: 1 },
    { system: 'zendesk', tool: 'find_tickets', outcome: 'failed', errorType: 'source_timeout', durationMs: 3400, attempts: 2 },
  ],
  scopeJtis: [{ system: 'ace-erp', tool: 'account_balance', jti: 'jti-test-1' }, { system: 'zendesk', tool: 'find_tickets', jti: 'jti-test-2' }],
  outcome: 'partial', release: { version: 'test-release-1', checksum: 'test-checksum-1' }, durationMs: 3450,
});

/** Only what a line cannot do without. */
const bare = (): JaxIqAuditLineInput => ({
  at: clock.now(), tenantId: 'test-tenant', environmentId: 'dev', correlationId: 'corr-test-1', queryId: 'query-test-1', op: 'find', outcome: 'refused', durationMs: 3,
});

/** Hands a value of the wrong kind to a function that asks for the right one: this is what a careless caller does. */
const wrong = <T>(value: unknown): T => value as T;

const FIELDS = [
  'at', 'tenantId', 'environmentId', 'correlationId', 'queryId', 'op', 'principalId', 'audience', 'groups', 'thing', 'canonicalId', 'resolvedBy',
  'factsRead', 'factsUnavailable', 'factsDenied', 'systems', 'scopeJtis', 'outcome', 'release', 'durationMs',
];

/** A small deterministic generator, so a failing case can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return { next, pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)], chance: (p: number) => next() < p };
}

/** The most items the schema lets a list hold: the largest length at which a list of valid items is still refused for being too long. */
function capOf(schema: ZodType, item: unknown): number {
  const result = schema.safeParse(Array.from({ length: 6000 }, () => item));
  const issue = result.success ? undefined : result.error.issues.find((entry) => entry.code === 'too_big');
  return Number((issue as { maximum?: unknown } | undefined)?.maximum);
}

async function main() {
  await suite.test('a line holds everything design section 16 asks for: the person, the tenant, the thing, the fields read, the systems used, the outcome, and the scope ids', () => {
    const line = buildAuditLine(full());
    assert.deepEqual(line, {
      at: '2026-10-29T09:30:00.000Z', tenantId: 'test-tenant', environmentId: 'dev', correlationId: 'corr-test-1', queryId: 'query-test-1', op: 'get',
      principalId: 'user-test-1', audience: 'staff', groups: ['finance', 'sales'],
      thing: 'Account', canonicalId: 'ACC-TEST-1', resolvedBy: 'key',
      factsRead: ['Account.name', 'Account.tier'], factsUnavailable: ['Account.owner'], factsDenied: ['Account.balance', 'Account.creditLimit'],
      systems: [
        { system: 'ace-erp', tool: 'account_balance', outcome: 'success', durationMs: 12, attempts: 1 },
        { system: 'zendesk', tool: 'find_tickets', outcome: 'failed', errorType: 'source_timeout', durationMs: 3400, attempts: 2 },
      ],
      scopeJtis: [{ system: 'ace-erp', tool: 'account_balance', jti: 'jti-test-1' }, { system: 'zendesk', tool: 'find_tickets', jti: 'jti-test-2' }],
      outcome: 'partial', release: { version: 'test-release-1', checksum: 'test-checksum-1' }, durationMs: 3450,
    });
    assert.deepEqual(Object.keys(line), FIELDS, 'the fields come in a fixed order');
  });

  await suite.test('a line with only the required fields has no optional key at all, and every line survives JSON unchanged', () => {
    const line = buildAuditLine(bare());
    assert.deepEqual(Object.keys(line), ['at', 'tenantId', 'environmentId', 'correlationId', 'queryId', 'op', 'principalId', 'groups', 'resolvedBy', 'factsRead', 'factsUnavailable', 'factsDenied', 'systems', 'scopeJtis', 'outcome', 'durationMs']);
    assert.equal(line.resolvedBy, 'none');
    assert.deepEqual(JSON.parse(JSON.stringify(line)), line, 'no key is set to undefined');
    const complete = buildAuditLine(full());
    assert.deepEqual(JSON.parse(JSON.stringify(complete)), complete);
  });

  await suite.test('a call with no person is written under the platform\'s unattributed name, and a person id that is not an id is not mistaken for it', () => {
    const none = buildAuditLine(bare());
    assert.equal(none.principalId, UNATTRIBUTED_PRINCIPAL);
    assert.equal('audience' in none, false);
    assert.deepEqual(none.groups, []);
    assert.equal(buildAuditLine({ ...bare(), principalId: 'Ana Smith' }).principalId, 'invalid');
    assert.equal(buildAuditLine({ ...bare(), principalId: wrong(null) }).principalId, 'invalid');
    assert.equal(buildAuditLine({ ...bare(), audience: 'shopper' }).audience, 'shopper', 'a refused shopper is written down as one');
    assert.equal('audience' in buildAuditLine({ ...bare(), audience: wrong('admin') }), false);
  });

  await suite.test('every operation and every outcome, refused and partial included, is accepted; anything else is refused without echoing it', () => {
    for (const op of ['find', 'get', 'related', 'explain'] as const) assert.equal(buildAuditLine({ ...bare(), op }).op, op);
    for (const outcome of ['answered', 'partial', 'refused', 'ambiguous', 'none', 'error'] as const) assert.equal(buildAuditLine({ ...bare(), outcome }).outcome, outcome);
    assert.throws(() => buildAuditLine({ ...bare(), op: wrong('delete-everything-test-only') }), (error: Error) => error instanceof TypeError && !error.message.includes('delete-everything'));
    assert.throws(() => buildAuditLine({ ...bare(), outcome: wrong('fine-test-only') }), (error: Error) => error instanceof TypeError && !error.message.includes('fine-test-only'));
    assert.throws(() => buildAuditLine({ ...bare(), at: new Date('not a time') }), RangeError);
  });

  await suite.test('the error on a line is one of the codes, whichever system or request it came from', () => {
    for (const code of JAX_IQ_ERROR_CODES) {
      const line = buildAuditLine({ ...bare(), outcome: 'error', errorType: code, systems: [{ system: 'ace-erp', tool: 'account_balance', outcome: 'failed', errorType: code, durationMs: 1, attempts: 1 }] });
      assert.equal(line.errorType, code);
      assert.equal(line.systems[0].errorType, code);
    }
    const stray = buildAuditLine({ ...bare(), errorType: wrong('The ERP could not be reached (host.invalid).'), systems: [{ system: 'ace-erp', tool: 'account_balance', outcome: 'failed', errorType: wrong('rate_limited '), durationMs: 1, attempts: 1 }] });
    assert.equal('errorType' in stray, false);
    assert.equal('errorType' in stray.systems[0], false);
  });

  await suite.test('fact names are listed once each, in a fixed order, and a name that is denied is removed from the read and unavailable lists', () => {
    const line = buildAuditLine({
      ...bare(), op: 'get', outcome: 'partial',
      factsRead: ['Account.tier', 'Account.name', 'Account.tier', 'Account.balance'],
      factsUnavailable: ['Account.owner', 'Account.creditLimit', 'Account.owner'],
      factsDenied: ['Account.creditLimit', 'Account.balance', 'Account.balance'],
    });
    assert.deepEqual(line.factsRead, ['Account.name', 'Account.tier']);
    assert.deepEqual(line.factsUnavailable, ['Account.owner']);
    assert.deepEqual(line.factsDenied, ['Account.balance', 'Account.creditLimit']);
    assert.deepEqual(buildAuditLine({ ...bare(), factsRead: ['Account.tier', 'Account.name'] }).factsRead, ['Account.name', 'Account.tier'], 'the same set in another order gives the same line');
  });

  await suite.test('a name that is not a name is left out: a value, a sentence or a number put where a name belongs never reaches the line', () => {
    const line = buildAuditLine({
      ...bare(), thing: wrong('Talbot & Nguyen'), canonicalId: wrong('Talbot & Nguyen'), groups: wrong(['finance', 'the finance team', 'Finance', '']),
      factsRead: wrong(['Account.name', 'Account.balance=9500.25', 'Account.balance: 9500.25', '9500.25', 'Talbot & Nguyen', 'account.balance', 'Account.', '.balance', '', 7, null, {}, ['Account.tier']]),
      factsUnavailable: wrong('Account.owner'),
      systems: wrong([
        { system: 'ace-erp', tool: 'account_balance', outcome: 'success', durationMs: 1, attempts: 1 },
        { system: 'ERP (sample)', tool: 'account_balance', outcome: 'success', durationMs: 1, attempts: 1 },
        { system: 'ace-erp', tool: 'account balance', outcome: 'success', durationMs: 1, attempts: 1 },
        { system: 'ace-erp', tool: 'account_balance', outcome: 'worked', durationMs: 1, attempts: 1 },
        'ace-erp', null, 7,
      ]),
    });
    assert.equal('thing' in line, false);
    assert.equal('canonicalId' in line, false);
    assert.deepEqual(line.groups, ['finance']);
    assert.deepEqual(line.factsRead, ['Account.name']);
    assert.deepEqual(line.factsUnavailable, [], 'a string is not a list');
    assert.deepEqual(line.systems, [{ system: 'ace-erp', tool: 'account_balance', outcome: 'success', durationMs: 1, attempts: 1 }]);
  });

  await suite.test('an identifier with a space or a control character in it is not written; the line says `invalid` instead of echoing it', () => {
    const line = buildAuditLine({
      ...bare(), tenantId: 'Talbot & Nguyen', environmentId: 'dev ', correlationId: 'corr\nforged-line', queryId: '', canonicalId: 'ACC 0001',
      release: { version: 'release 1', checksum: 'test-checksum-1' },
      scopeJtis: wrong([{ system: 'ace-erp', tool: 'account_balance', jti: 'jti with spaces' }, { system: 'ace-erp', tool: 'account_balance', jti: '' }, { system: 'ace-erp', tool: 'account_balance' }]),
    });
    assert.deepEqual([line.tenantId, line.environmentId, line.correlationId, line.queryId], ['invalid', 'invalid', 'invalid', 'invalid']);
    assert.equal('canonicalId' in line, false);
    assert.equal('release' in line, false, 'a release needs both its version and its checksum');
    assert.deepEqual(line.scopeJtis, []);
  });

  await suite.test('a system entry keeps the names, the outcome and the counts, and nothing a connector said', () => {
    const outcome = { ok: false, kind: 'transport', code: 'unavailable', message: 'Zendesk could not be reached (connector.invalid).' };
    const line = buildAuditLine({
      ...bare(), outcome: 'partial',
      systems: [{ system: 'zendesk', tool: 'find_tickets', outcome: 'failed', errorType: 'source_unavailable', durationMs: 20.6, attempts: 3, ...outcome, args: { accountId: 'ACC-TEST-1' }, result: { balance: '9500.25' } } as never],
    });
    assert.deepEqual(line.systems, [{ system: 'zendesk', tool: 'find_tickets', outcome: 'failed', errorType: 'source_unavailable', durationMs: 21, attempts: 3 }]);
    const counts = buildAuditLine({
      ...bare(), durationMs: wrong(Number.NaN),
      systems: wrong([{ system: 'zendesk', tool: 'find_tickets', outcome: 'skipped', durationMs: -5, attempts: '2' }, { system: 'zendesk', tool: 'find_tickets', outcome: 'cached', durationMs: Infinity, attempts: 1.4 }]),
    });
    assert.equal(counts.durationMs, 0);
    assert.deepEqual(counts.systems.map((entry) => [entry.durationMs, entry.attempts]), [[0, 0], [0, 1]]);
  });

  await suite.test('there is one scope id per call, so two calls to one system give two, and each is joined to its system and tool', () => {
    const line = buildAuditLine({
      ...bare(), op: 'get', outcome: 'answered',
      systems: [
        { system: 'commercetools', tool: 'order_history', outcome: 'success', durationMs: 5, attempts: 1 },
        { system: 'commercetools', tool: 'order_history', outcome: 'success', durationMs: 6, attempts: 1 },
      ],
      scopeJtis: [{ system: 'commercetools', tool: 'order_history', jti: 'jti-test-a' }, { system: 'commercetools', tool: 'order_history', jti: 'jti-test-b' }],
    });
    assert.equal(line.systems.length, 2);
    assert.deepEqual(line.scopeJtis.map((entry) => entry.jti), ['jti-test-a', 'jti-test-b']);
    assert.deepEqual(line.scopeJtis.map(({ system, tool }) => `${system}.${tool}`), ['commercetools.order_history', 'commercetools.order_history']);
  });

  await suite.test('denied fact names exist only in the internal field of the line', () => {
    const denied = ['Account.balance', 'Account.creditLimit', 'Account.overdue'];
    const line = buildAuditLine({
      ...full(), factsDenied: denied,
      factsRead: ['Account.name', 'Account.balance', 'Account.tier'], factsUnavailable: ['Account.owner', 'Account.overdue'],
    });
    assert.deepEqual(line.factsDenied, [...denied].sort());
    const { factsDenied: _internal, ...everythingElse } = line;
    const outside = JSON.stringify(everythingElse);
    for (const name of denied) assert.equal(outside.includes(name), false, `${name} is outside factsDenied`);
    assert.ok(outside.includes('Account.name') && outside.includes('Account.owner'), 'the names that were read or unavailable are still there');
    // A line with nothing denied has an empty internal field, not a missing one.
    assert.deepEqual(buildAuditLine({ ...full(), factsDenied: [] }).factsDenied, []);
  });

  await suite.test('property: secrets, fact values, arguments, vendor words and addresses fed in every place a careless caller might put them never appear in a line', () => {
    const random = generator(20261029);
    let checked = 0;
    for (let round = 0; round < 300; round++) {
      // `spaced` could only be an identifier by mistake, `unnameable` could not be a name, and `plain` could be either: a token like that is kept
      // out of the slots whose pattern would accept it, because a secret that looks exactly like a system name cannot be told from one.
      const spaced = [`Bearer test-only-secret-${round}-a`, `Talbot & Nguyen ${round}`, `${1000 + round}.75 NZD`, `could not reach host-${round}.connector.invalid`];
      const unnameable = [...spaced, `/private/path/${round}/file`, `owner-${round}@example.test`];
      const plain = [`test-only-secret-${round}-b`, `${2000 + round}.50`, `host-${round}.connector.invalid`, `sk-test-only-${round}`];
      const poison = [...unnameable, ...plain];
      const anywhere = (): string => random.pick(poison);
      const inWord = (): string => random.pick(spaced);
      const inName = (): string => random.pick(unnameable);
      const garbageName = (): string => random.pick([`Account.balance=${anywhere()}`, `Account.${anywhere()}`, anywhere(), `${anywhere()}.${anywhere()}`, `Account.name ${anywhere()}`]);
      const legit = ['Account.name', 'Account.tier', 'Account.owner', 'Order.status'].filter(() => random.chance(0.6));
      const many = (make: () => unknown) => Array.from({ length: Math.floor(random.next() * 5) }, make);
      const input: Record<string, unknown> = {
        ...bare(),
        tenantId: random.chance(0.5) ? 'test-tenant' : inWord(), environmentId: random.chance(0.5) ? 'dev' : inWord(),
        correlationId: random.chance(0.5) ? `corr-${round}` : inWord(), queryId: `query-${round}`,
        principalId: random.chance(0.7) ? `user-${round}` : inWord(),
        groups: [...many(inName), 'finance'],
        thing: random.chance(0.5) ? 'Account' : anywhere(), canonicalId: random.chance(0.5) ? `ACC-${round}` : inWord(),
        factsRead: [...legit, ...many(garbageName)], factsUnavailable: [...many(garbageName), 'Account.owner'], factsDenied: [...many(garbageName), 'Account.balance'],
        systems: [
          ...many(() => ({
            system: random.chance(0.5) ? 'ace-erp' : inName(), tool: random.chance(0.5) ? 'account_balance' : inName(), outcome: random.pick(['success', 'failed', anywhere()]),
            errorType: random.pick(['source_timeout', anywhere(), `source_timeout ${anywhere()}`]), durationMs: random.pick([5, anywhere(), 12.4]), attempts: random.pick([1, anywhere()]),
            message: anywhere(), args: { accountId: anywhere() }, result: { balance: anywhere() }, code: anywhere(), kind: anywhere(), headers: { authorization: anywhere() },
          })),
          { system: 'ace-erp', tool: 'account_balance', outcome: 'success', durationMs: 4, attempts: 1 },
        ],
        scopeJtis: [...many(() => ({ system: random.pick(['ace-erp', inName()]), tool: 'account_balance', jti: inWord() })), { system: 'ace-erp', tool: 'account_balance', jti: `jti-${round}` }],
        errorType: random.pick([undefined, 'internal_error', anywhere()]), release: random.chance(0.5) ? { version: `release-${round}`, checksum: `checksum-${round}` } : { version: inWord(), checksum: inWord() },
        // Fields the line has no place for.
        args: { accountId: anywhere() }, values: { 'Account.balance': anywhere() }, result: { record: { balance: anywhere() } }, error: anywhere(), message: anywhere(),
        headers: { authorization: anywhere() }, secret: anywhere(), email: anywhere(), url: anywhere(), path: anywhere(),
      };
      const line = buildAuditLine(input as never);
      const text = JSON.stringify(line);
      for (const token of poison) {
        assert.equal(text.includes(token), false, `round ${round}: "${token}" reached the line: ${text}`);
        checked++;
      }
      for (const key of Object.keys(line)) assert.ok([...FIELDS, 'errorType'].includes(key), `round ${round}: unexpected field ${key}`);
      assert.deepEqual(line.factsRead.filter((name) => name === 'Account.balance'), [], 'a denied name never shows as read');
      assert.ok(legit.every((name) => line.factsRead.includes(name)), `round ${round}: a name that is a name was dropped`);
      assert.ok(line.systems.some((entry) => entry.tool === 'account_balance'), `round ${round}: the good entry was dropped`);
    }
    assert.equal(checked, 300 * 10);
  });

  await suite.test('the caps on the lists of a line are the caps the model schema puts on facts and bindings, and a longer list is cut at them', () => {
    const golden = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/golden-v1.block.json'), 'utf8'));
    assert.equal(AUDIT_FACT_NAME_CAP, capOf(JaxOntologyReleaseSchema.shape.facts, golden.facts[0]));
    assert.equal(AUDIT_CALL_CAP, capOf(JaxOntologyReleaseSchema.shape.bindings, golden.bindings[0]));
    const names = Array.from({ length: AUDIT_FACT_NAME_CAP + 100 }, (_, index) => `Account.f${String(index).padStart(5, '0')}`);
    const calls = Array.from({ length: AUDIT_CALL_CAP + 100 }, (_, index) => ({ system: 'ace-erp', tool: 'account_balance', outcome: 'success' as const, durationMs: index, attempts: 1 }));
    const line = buildAuditLine({
      ...bare(), factsRead: names, factsUnavailable: names, factsDenied: names, systems: calls,
      scopeJtis: calls.map((_, index) => ({ system: 'ace-erp', tool: 'account_balance', jti: `jti-test-${index}` })),
    });
    assert.equal(line.factsDenied.length, AUDIT_FACT_NAME_CAP);
    assert.equal(line.factsRead.length, 0, 'every name was denied, so none is read');
    assert.equal(line.factsUnavailable.length, 0);
    assert.equal(line.systems.length, AUDIT_CALL_CAP);
    assert.equal(line.scopeJtis.length, AUDIT_CALL_CAP);
    assert.equal(buildAuditLine({ ...bare(), factsRead: names }).factsRead.length, AUDIT_FACT_NAME_CAP);
  });

  await suite.test('the memory sink appends in order, keeps its own copy of each line and hands out copies, and has no way to change or remove one', async () => {
    const sink: AuditSink = new MemoryAuditSink();
    const first = buildAuditLine(full());
    const second = buildAuditLine({ ...bare(), queryId: 'query-test-2' });
    assert.equal(await sink.write(first), undefined);
    await sink.write(second);
    first.factsRead.push('Account.changedAfterWrite');
    const memory = sink as MemoryAuditSink;
    const lines = memory.lines();
    assert.deepEqual(lines.map((line) => line.queryId), ['query-test-1', 'query-test-2']);
    assert.deepEqual(lines[0].factsRead, ['Account.name', 'Account.tier'], 'a change to the written line after the write is not seen');
    lines[0].factsRead.push('Account.changedAfterRead');
    lines.pop();
    assert.equal(memory.lines().length, 2, 'a change to what was handed out is not seen');
    assert.deepEqual(memory.lines()[0].factsRead, ['Account.name', 'Account.tier']);
    assert.deepEqual(Object.getOwnPropertyNames(MemoryAuditSink.prototype).sort(), ['constructor', 'lines', 'write']);
    assert.deepEqual(new MemoryAuditSink().lines(), []);
  });

  await suite.test('a sink written for the port takes the lines the builder gives', async () => {
    const written: JaxIqAuditLine[] = [];
    const sink: AuditSink = { write: async (line) => { written.push(line); } };
    await sink.write(buildAuditLine(full()));
    assert.equal(written.length, 1);
    assert.equal(written[0].outcome, 'partial');
  });

  await suite.test('the audit module exports the builder, the sink and the two caps, and nothing else that could collide with a sibling module', () => {
    assert.deepEqual(Object.keys(auditModule).sort(), ['AUDIT_CALL_CAP', 'AUDIT_FACT_NAME_CAP', 'MemoryAuditSink', 'buildAuditLine']);
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
