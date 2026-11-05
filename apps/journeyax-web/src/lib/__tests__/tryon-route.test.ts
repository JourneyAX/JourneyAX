import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../../app/api/tryon/route';

test('try-on refuses foreign origins and unsigned requests before forwarding a photo', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Unexpected upstream request'); }) as typeof fetch;
  try {
    const foreign = new NextRequest('https://shop.invalid/api/tryon?project=tenant-a', { method: 'POST', headers: { origin: 'https://other.invalid', cookie: 'jxs_at=isolated' } });
    assert.equal((await POST(foreign)).status, 403);
    const unsigned = new NextRequest('https://shop.invalid/api/tryon?project=tenant-a', { method: 'POST', headers: { origin: 'https://shop.invalid' } });
    assert.equal((await POST(unsigned)).status, 401);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('try-on uses the selected tenant and forwards only the session credential through the gateway', async () => {
  const original = globalThis.fetch; const calls: any[] = [];
  globalThis.fetch = (async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    return Response.json({ imageDataUrl: 'data:image/png;base64,aW1hZ2U=', provider: 'isolated-fixture' });
  }) as typeof fetch;
  try {
    const req = new NextRequest('https://shop.invalid/api/tryon?project=tenant-a', { method: 'POST', headers: { origin: 'https://shop.invalid', cookie: 'jxs_at=isolated-session', 'content-type': 'application/json', 'x-user-role': 'admin', 'x-internal-key': 'forged' }, body: JSON.stringify({ personImage: 'data:image/png;base64,aW1hZ2U=', garmentImageUrl: 'https://catalogue.invalid/a.png' }) });
    assert.equal((await POST(req)).status, 200); assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/v1/tenant-a/products/tryon'));
    assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json', 'X-Tenant-ID': 'tenant-a', Authorization: 'Bearer isolated-session' });
  } finally { globalThis.fetch = original; }
});
