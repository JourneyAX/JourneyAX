import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { revokeToken, revokeAllFor, isRevoked, __resetSessionStore } from './session-store';
import { createStaffSession, decodeSession, verifySession, sessionFromRequest, SESSION_COOKIE } from './session';

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('token revocation', () => {
  beforeEach(() => __resetSessionStore());

  test('a fresh session is not revoked', () => {
    assert.equal(isRevoked({ sub: 'alice', jti: 'j1', iat: Math.floor(Date.now() / 1000) }), false);
  });

  test('a revoked id is rejected', () => {
    revokeToken('j1', future());
    assert.equal(isRevoked({ sub: 'alice', jti: 'j1', iat: Math.floor(Date.now() / 1000) }), true);
  });

  test('revoking one id leaves others alone', () => {
    revokeToken('j1', future());
    assert.equal(isRevoked({ sub: 'alice', jti: 'j2', iat: Math.floor(Date.now() / 1000) }), false);
  });

  test('a session with no id fails closed', () => {
    // Tokens issued before revocation existed must not bypass the check.
    assert.equal(isRevoked({ sub: 'alice', iat: Math.floor(Date.now() / 1000) }), true);
  });
});

describe('revoke everything for a user', () => {
  beforeEach(() => __resetSessionStore());

  test('kills sessions issued before the cutoff', () => {
    const iat = Math.floor(Date.now() / 1000) - 100;
    revokeAllFor('alice');
    assert.equal(isRevoked({ sub: 'alice', jti: 'j1', iat }), true);
  });

  test('does not touch a different user', () => {
    revokeAllFor('alice');
    const iat = Math.floor(Date.now() / 1000) - 100;
    assert.equal(isRevoked({ sub: 'bob', jti: 'j1', iat }), false);
  });

  test('is case-insensitive on the username', () => {
    revokeAllFor('Alice');
    assert.equal(isRevoked({ sub: 'alice', jti: 'j1', iat: Math.floor(Date.now() / 1000) - 10 }), true);
  });

  test('spares an explicitly exempted session', () => {
    // This is what stops a password change signing you out of your own tab.
    const now = Math.floor(Date.now() / 1000);
    revokeAllFor('alice', { exceptJti: 'keep-me' });
    assert.equal(isRevoked({ sub: 'alice', jti: 'keep-me', iat: now }), false);
    assert.equal(isRevoked({ sub: 'alice', jti: 'other', iat: now }), true);
  });

  test('kills a session issued in the same second as the revocation', () => {
    const now = Math.floor(Date.now() / 1000);
    revokeAllFor('alice', { cutoff: now });
    assert.equal(isRevoked({ sub: 'alice', jti: 'j1', iat: now }), true);
  });
});

describe('integration with session verification', () => {
  beforeEach(() => __resetSessionStore());

  test('verifySession rejects a revoked token that still has a valid signature', () => {
    const { token, jti } = createStaffSession('alice', 'csr');
    assert.ok(verifySession(token), 'valid before revocation');

    revokeToken(jti, future());

    // The signature is still good and it has not expired — only revocation
    // rejects it. decodeSession is deliberately unaware.
    assert.ok(decodeSession(token), 'signature still verifies');
    assert.equal(verifySession(token), null, 'but the session is dead');
  });

  test('sessionFromRequest honours revocation', () => {
    const { token, jti } = createStaffSession('alice', 'csr');
    const req = () => new Request('https://x/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });

    assert.ok(sessionFromRequest(req()));
    revokeToken(jti, future());
    assert.equal(sessionFromRequest(req()), null);
  });

  test('anonymous sessions are unaffected by revocation state', () => {
    const { token } = createStaffSession('alice', 'csr');
    revokeAllFor('alice');
    assert.equal(verifySession(token), null);
    // An anonymous session for a different subject stays usable.
    assert.ok(verifySession(createStaffSession('bob', 'csr').token));
  });
});
