import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireStaff, isUnauthorised, rateLimitSubject } from './guard';
import { createStaffSession, createAnonymousSession, SESSION_COOKIE } from './session';

function req(token?: string) {
  return new Request('https://x/api/csr', {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
}

describe('requireStaff', () => {
  test('401s with no session', () => {
    const r = requireStaff(req());
    assert.ok(isUnauthorised(r));
    if (isUnauthorised(r)) assert.equal(r.response.status, 401);
  });

  test('401s for an anonymous session', () => {
    // The critical case: everyone gets a session cookie from the proxy, so
    // "has a session" must never be mistaken for "is signed in".
    const { token } = createAnonymousSession();
    const r = requireStaff(req(token));
    assert.ok(isUnauthorised(r));
    if (isUnauthorised(r)) assert.equal(r.response.status, 401);
  });

  test('401s for a forged cookie', () => {
    const r = requireStaff(req('forged.token'));
    assert.ok(isUnauthorised(r));
  });

  test('admits a staff session', () => {
    const { token } = createStaffSession('alice', 'csr');
    const r = requireStaff(req(token));
    assert.equal(isUnauthorised(r), false);
    if (!isUnauthorised(r)) assert.equal(r.session.sub, 'alice');
  });

  test('403s when the role is not permitted', () => {
    const { token } = createStaffSession('alice', 'csr');
    const r = requireStaff(req(token), ['admin']);
    assert.ok(isUnauthorised(r));
    if (isUnauthorised(r)) assert.equal(r.response.status, 403);
  });

  test('admits a permitted role', () => {
    const { token } = createStaffSession('root', 'admin');
    assert.equal(isUnauthorised(requireStaff(req(token), ['admin'])), false);
  });
});

describe('rateLimitSubject', () => {
  test('returns the session subject when there is one', () => {
    const { token } = createAnonymousSession();
    assert.ok(rateLimitSubject(req(token))?.startsWith('anon-'));
  });

  test('returns null without a session so the caller falls back to IP', () => {
    assert.equal(rateLimitSubject(req()), null);
  });
});
