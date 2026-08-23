import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { guard, isFailure, validateMessages, validateCommand, MAX_BODY_BYTES, MAX_MESSAGE_CHARS, MAX_MESSAGES } from './api-guard';
import { __resetRateLimits } from './rate-limit';

const rule = { windowMs: 60_000, max: 100 };

function post(body: string, headers: Record<string, string> = {}) {
  return new Request('https://x/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '1.1.1.1', ...headers },
    body,
  });
}

describe('guard', () => {
  beforeEach(() => __resetRateLimits());

  test('parses a valid object body', async () => {
    const r = await guard<{ a: number }>(post('{"a":1}'), { scope: 't', rule });
    assert.equal(isFailure(r), false);
    if (!isFailure(r)) assert.equal(r.body.a, 1);
  });

  test('rejects malformed JSON with 400 rather than throwing', async () => {
    const r = await guard(post('{not json'), { scope: 't', rule });
    assert.ok(isFailure(r));
    if (isFailure(r)) assert.equal(r.response.status, 400);
  });

  test('rejects a top-level array', async () => {
    // The routes destructure the body; an array would silently yield undefined.
    const r = await guard(post('[1,2,3]'), { scope: 't', rule });
    assert.ok(isFailure(r));
    if (isFailure(r)) assert.equal(r.response.status, 400);
  });

  test('rejects null', async () => {
    const r = await guard(post('null'), { scope: 't', rule });
    assert.ok(isFailure(r));
  });

  test('rejects an oversized body even when content-length lies', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(MAX_BODY_BYTES + 10) });
    const r = await guard(post(big, { 'content-length': '10' }), { scope: 't', rule });
    assert.ok(isFailure(r));
    if (isFailure(r)) assert.equal(r.response.status, 413);
  });

  test('returns 429 with Retry-After once over the limit', async () => {
    const tight = { windowMs: 60_000, max: 1 };
    await guard(post('{}'), { scope: 'tight', rule: tight });
    const r = await guard(post('{}'), { scope: 'tight', rule: tight });
    assert.ok(isFailure(r));
    if (isFailure(r)) {
      assert.equal(r.response.status, 429);
      assert.ok(r.response.headers.get('Retry-After'));
    }
  });
});

describe('validateMessages', () => {
  test('treats a missing array as an empty conversation', () => {
    const r = validateMessages(undefined);
    assert.ok(r.ok && r.messages.length === 0);
  });

  test('rejects a non-array', () => {
    assert.equal(validateMessages('hello').ok, false);
  });

  test('rejects a message without a role', () => {
    assert.equal(validateMessages([{ content: 'hi' }]).ok, false);
  });

  test('rejects an over-long message', () => {
    const r = validateMessages([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }]);
    assert.equal(r.ok, false);
  });

  test('rejects too many messages', () => {
    const many = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'hi' }));
    assert.equal(validateMessages(many).ok, false);
  });

  test('coerces null content instead of failing the turn', () => {
    // Tool-call entries legitimately carry null content.
    const r = validateMessages([{ role: 'assistant', content: null }]);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.messages[0].content, '');
  });
});

describe('validateCommand', () => {
  test('accepts a normal command', () => {
    const r = validateCommand('find order S12345');
    assert.ok(r.ok && r.command === 'find order S12345');
  });

  test('rejects a non-string', () => {
    assert.equal(validateCommand({ evil: true }).ok, false);
  });

  test('rejects an over-long command', () => {
    assert.equal(validateCommand('x'.repeat(MAX_MESSAGE_CHARS + 1)).ok, false);
  });
});
