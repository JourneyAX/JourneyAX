import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { signGatewayAssertion } from '@journeyax/database';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { fetchTryOnGarment } from '../src/tryon-image';
import { TryOnAccessGuard } from '../src/tryon-access.guard';
import { ProductController } from '../src/product.controller';

function imageFixture(status = 200, mime = 'image/png', chunks = [Buffer.from('bounded-source-image')], length?: string) {
  const calls: any[] = [];
  const deps: any = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url: URL, options: any, callback: any) => {
      calls.push({ url, options });
      const req: any = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const response: any = Readable.from(chunks);
        response.statusCode = status;
        response.headers = { 'content-type': mime, ...(length ? { 'content-length': length } : {}) };
        callback(response);
      };
      return req;
    },
  };
  return { deps, calls };
}

test('try-on image URLs cannot reach private/loopback addresses or credential-bearing origins', async () => {
  const fixture = imageFixture();
  for (const url of ['http://example.com/a.png', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://169.254.169.254/a', 'https://10.0.0.1/a', 'https://localhost/a', 'https://host.internal/a', 'https://user:pass@example.com/a', 'https://example.com:8080/a']) {
    await assert.rejects(() => fetchTryOnGarment(url, fixture.deps), /public HTTPS/);
  }
  fixture.deps.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.1', family: 4 }];
  await assert.rejects(() => fetchTryOnGarment('https://catalogue.invalid/a.png', fixture.deps), /public HTTPS/);
  assert.equal(fixture.calls.length, 0);
});

test('try-on pins the checked DNS result and sends no caller credentials or redirect requests', async () => {
  const fixture = imageFixture();
  let lookups = 0;
  fixture.deps.lookup = async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }]; };
  const result = await fetchTryOnGarment('https://catalogue.invalid/garment.png', fixture.deps);
  assert.equal(result.mime, 'image/png'); assert.equal(lookups, 1); assert.equal(fixture.calls.length, 1);
  const opts = fixture.calls[0].options;
  assert.deepEqual(opts.headers, { accept: 'image/jpeg,image/png,image/webp' });
  assert.equal(opts.agent, false); assert.ok(opts.signal instanceof AbortSignal);
  opts.lookup('catalogue.invalid', { all: true }, (error: unknown, addresses: any) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
  const redirect = imageFixture(302);
  await assert.rejects(() => fetchTryOnGarment('https://catalogue.invalid/a.png', redirect.deps), /safely/);
  assert.equal(redirect.calls.length, 1);
});

test('try-on rejects non-images and oversized responses even without Content-Length', async () => {
  for (const fixture of [imageFixture(200, 'text/html'), imageFixture(200, 'image/png', [], String(8 * 1024 * 1024 + 1)), imageFixture(200, 'image/png', [Buffer.alloc(8 * 1024 * 1024), Buffer.from('x')]), imageFixture(200, 'image/png', [])]) {
    await assert.rejects(() => fetchTryOnGarment('https://catalogue.invalid/a.png', fixture.deps), /safely/);
  }
});

test('paid try-on route independently verifies identity and tenant before any image/model work', async () => {
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, ProductController.prototype.tryOn).includes(TryOnAccessGuard));
  const previous = process.env.GATEWAY_ASSERTION_SECRET;
  const secret = 'isolated-tryon-assertion-secret-'.repeat(2);
  process.env.GATEWAY_ASSERTION_SECRET = secret;
  const context = (headers: any, target = 'tenant-a') => ({ switchToHttp: () => ({ getRequest: () => ({ headers, params: { projectId: target } }) }) }) as any;
  try {
    const guard = new TryOnAccessGuard();
    await assert.rejects(() => guard.canActivate(context({ 'x-user-role': 'admin', 'x-internal-call': 'true' })), /Verified/);
    const assertion = signGatewayAssertion({ tenantId: 'tenant-a', environmentId: 'production', sub: 'owned-shopper', role: 'customer' }, secret);
    assert.equal(await guard.canActivate(context({ 'x-gateway-assertion': assertion })), true);
    await assert.rejects(() => guard.canActivate(context({ 'x-gateway-assertion': assertion }, 'tenant-b')), /Verified/);
    await assert.rejects(() => guard.canActivate(context({ 'x-gateway-assertion': assertion, 'x-tenant-id': 'tenant-b' })), /One try-on tenant/);
  } finally { if (previous === undefined) delete process.env.GATEWAY_ASSERTION_SECRET; else process.env.GATEWAY_ASSERTION_SECRET = previous; }
});
