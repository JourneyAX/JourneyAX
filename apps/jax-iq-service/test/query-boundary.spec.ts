import './setup/no-world';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSuite } from '@journeyax/test-support';
import { signIqRequest, verifyIqRequest, type IqContext, type IqQuery } from '@journeyax/jax-iq';
import { IqController } from '../src/iq.controller';

const suite = createSuite('IQ authenticated query boundary');
const secret = 'fixture-only-signing-key-32-characters';
const ctx: IqContext = { tenantId: 'tenant-a', environmentId: 'test', queryId: 'q-1', correlationId: 'c-1', release: { version: '1', checksum: 'abc' }, principal: { id: 'staff', audience: 'staff', groups: ['sales'], subjects: [] } };
const body: IqQuery = { operation: 'find', thing: 'Account', query: 'Hartley' };
async function main() {
  await suite.test('signature binds identity, exact request, tenant, environment, release and lifetime', () => {
    const at = Date.parse('2026-11-01T00:00:00Z');
    const token = signIqRequest(ctx, body, secret, at);
    assert.deepEqual(verifyIqRequest(token, body, secret, { tenantId: 'tenant-a', environmentId: 'test' }, at).context, ctx);
    for (const attempt of [
      () => verifyIqRequest(token, { ...body, query: 'Other' }, secret, { tenantId: 'tenant-a', environmentId: 'test' }, at),
      () => verifyIqRequest(token, body, secret, { tenantId: 'tenant-b', environmentId: 'test' }, at),
      () => verifyIqRequest(token, body, secret, { tenantId: 'tenant-a', environmentId: 'production' }, at),
      () => verifyIqRequest(token, body, secret, { tenantId: 'tenant-a', environmentId: 'test' }, at + 61_000),
      () => verifyIqRequest(token, body, 'a-different-fixture-signing-key-xxxx', { tenantId: 'tenant-a', environmentId: 'test' }, at),
    ]) assert.throws(attempt);
  });
  await suite.test('missing/forged callers and replay never reach the query engine', async () => {
    const previous = process.env.JAX_IQ_SIGNING_SECRET; process.env.JAX_IQ_SIGNING_SECRET = secret;
    const seen = new Set<string>(); let calls = 0;
    const controller = new IqController({ store: { claim: async (jti: string) => { if (seen.has(jti)) return false; seen.add(jti); return true; } }, query: async () => { calls++; return { ok: false, code: 'not_configured', queryId: 'q-1' }; } } as any);
    try {
      for (const assertion of [undefined, 'forged']) await assert.rejects(() => controller.query('tenant-a', 'test', assertion, body, new EventEmitter()), /Verified IQ caller/);
      const token = signIqRequest(ctx, body, secret);
      await controller.query('tenant-a', 'test', token, body, new EventEmitter());
      await assert.rejects(() => controller.query('tenant-a', 'test', token, body, new EventEmitter()), /already used/);
      assert.equal(calls, 1);
    } finally { if (previous === undefined) delete process.env.JAX_IQ_SIGNING_SECRET; else process.env.JAX_IQ_SIGNING_SECRET = previous; }
  });
  await suite.test('replay storage failure is closed and does not execute a read', async () => {
    const previous = process.env.JAX_IQ_SIGNING_SECRET; process.env.JAX_IQ_SIGNING_SECRET = secret;
    let calls = 0;
    const controller = new IqController({ store: { claim: async () => { throw new Error('store down'); } }, query: async () => { calls++; } } as any);
    try { await assert.rejects(() => controller.query('tenant-a', 'test', signIqRequest(ctx, body, secret), body, new EventEmitter()), /replay protection/); assert.equal(calls, 0); }
    finally { if (previous === undefined) delete process.env.JAX_IQ_SIGNING_SECRET; else process.env.JAX_IQ_SIGNING_SECRET = previous; }
  });
  suite.finish();
}
main().catch(error => { console.error(error); process.exit(1); });
