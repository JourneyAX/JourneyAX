import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, clientKey, __resetRateLimits } from './rate-limit';

const rule = { windowMs: 1000, max: 3 };

describe('rateLimit', () => {
  beforeEach(() => __resetRateLimits());

  test('allows requests up to the limit', () => {
    for (let i = 0; i < rule.max; i++) {
      assert.equal(rateLimit('a', rule).ok, true, `request ${i + 1} should pass`);
    }
  });

  test('blocks the request after the limit', () => {
    for (let i = 0; i < rule.max; i++) rateLimit('a', rule);
    const blocked = rateLimit('a', rule);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfter > 0, 'must tell the caller when to come back');
  });

  test('counts each key separately', () => {
    for (let i = 0; i < rule.max; i++) rateLimit('a', rule);
    assert.equal(rateLimit('a', rule).ok, false);
    assert.equal(rateLimit('b', rule).ok, true, 'one caller must not block another');
  });

  test('reports a decreasing remaining count', () => {
    assert.equal(rateLimit('a', rule).remaining, 2);
    assert.equal(rateLimit('a', rule).remaining, 1);
    assert.equal(rateLimit('a', rule).remaining, 0);
  });

  test('frees up once the window passes', async () => {
    for (let i = 0; i < rule.max; i++) rateLimit('a', rule);
    assert.equal(rateLimit('a', rule).ok, false);
    await new Promise(r => setTimeout(r, rule.windowMs + 50));
    assert.equal(rateLimit('a', rule).ok, true, 'window should have slid past');
  });
});

describe('clientKey', () => {
  test('uses the first x-forwarded-for hop', () => {
    const req = new Request('https://x/', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
    assert.equal(clientKey(req, 'chat'), 'chat:1.2.3.4');
  });

  test('falls back to x-real-ip', () => {
    const req = new Request('https://x/', { headers: { 'x-real-ip': '9.9.9.9' } });
    assert.equal(clientKey(req, 'chat'), 'chat:9.9.9.9');
  });

  test('scopes keys per route so one endpoint cannot exhaust another', () => {
    const req = new Request('https://x/', { headers: { 'x-real-ip': '9.9.9.9' } });
    assert.notEqual(clientKey(req, 'chat'), clientKey(req, 'shop'));
  });

  test('degrades to a constant when no IP header is present', () => {
    assert.equal(clientKey(new Request('https://x/'), 'chat'), 'chat:unknown');
  });
});
