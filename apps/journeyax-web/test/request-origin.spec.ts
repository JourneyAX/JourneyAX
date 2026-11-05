import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../src/lib/request-origin';

test('same-origin browser requests use the HTTP host when Next reconstructs localhost', () => {
  const request = new Request('http://localhost:57112/api/cart', { headers: { host: '127.0.0.1:57112', origin: 'http://127.0.0.1:57112' } });
  assert.equal(isSameOriginRequest(request, ''), true);
  assert.equal(isSameOriginRequest(new Request('http://localhost/api/cart'), ''), true);
});

test('cross-site, opaque and forged forwarded origins cannot authorize a cart mutation', () => {
  for (const origin of ['http://other.example', 'null', 'http://127.0.0.1:57113', 'https://127.0.0.1:57112', 'http://user:pass@127.0.0.1:57112', 'http://127.0.0.1:57112/path']) {
    assert.equal(isSameOriginRequest(new Request('http://localhost:57112/api/cart', { headers: { host: '127.0.0.1:57112', origin, 'x-forwarded-host': 'other.example' } }), ''), false, origin);
  }
  assert.equal(isSameOriginRequest(new Request('https://shop.example/api/cart', { headers: { host: 'shop.example,other.example', origin: 'https://shop.example' } }), ''), false);
});

test('an explicit deployment origin supports TLS termination without trusting forwarded headers', () => {
  const request = new Request('http://internal-service:3008/api/cart', { headers: { host: 'internal-service:3008', origin: 'https://shop.example' } });
  assert.equal(isSameOriginRequest(request, 'https://shop.example'), true);
  assert.equal(isSameOriginRequest(request, 'https://different.example'), false);
  assert.equal(isSameOriginRequest(request, 'https://shop.example/path'), false);
});
