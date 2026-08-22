import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSession, decodeSession, createStaffSession, createAnonymousSession,
  sessionFromRequest, isStaff, SESSION_COOKIE, cookieOptions,
} from './session';

function withCookie(token: string) {
  return new Request('https://x/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}

const now = () => Math.floor(Date.now() / 1000);

describe('encode/decode', () => {
  test('round-trips a staff session', () => {
    const token = encodeSession({ sub: 'alice', role: 'csr', iat: now(), exp: now() + 60 });
    const decoded = decodeSession(token);
    assert.equal(decoded?.sub, 'alice');
    assert.equal(decoded?.role, 'csr');
  });

  test('rejects a tampered payload', () => {
    // The whole point: change the role, keep the signature, get nothing.
    const token = encodeSession({ sub: 'alice', iat: now(), exp: now() + 60 });
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'alice', role: 'admin', iat: now(), exp: now() + 60 }))
      .toString('base64url');
    assert.equal(decodeSession(`${forged}.${sig}`), null);
  });

  test('rejects a tampered signature', () => {
    const token = encodeSession({ sub: 'alice', role: 'csr', iat: now(), exp: now() + 60 });
    const [body] = token.split('.');
    assert.equal(decodeSession(`${body}.notasignature`), null);
  });

  test('rejects an expired session', () => {
    const token = encodeSession({ sub: 'alice', role: 'csr', iat: now() - 120, exp: now() - 60 });
    assert.equal(decodeSession(token), null);
  });

  test('rejects an unknown role', () => {
    const token = encodeSession({ sub: 'x', role: 'superuser' as never, iat: now(), exp: now() + 60 });
    assert.equal(decodeSession(token), null);
  });

  test('rejects junk', () => {
    for (const junk of ['', 'abc', 'a.b', '.', undefined, null]) {
      assert.equal(decodeSession(junk as string), null, `should reject ${JSON.stringify(junk)}`);
    }
  });
});

describe('session kinds', () => {
  test('a staff session carries a role', () => {
    const { token } = createStaffSession('alice', 'admin');
    assert.equal(decodeSession(token)?.role, 'admin');
    assert.equal(isStaff(decodeSession(token)), true);
  });

  test('an anonymous session carries no role and is not staff', () => {
    // This is the load-bearing distinction: everyone gets a session, only
    // staff get a role, and only a role grants access.
    const { token } = createAnonymousSession();
    const decoded = decodeSession(token);
    assert.equal(decoded?.role, undefined);
    assert.equal(isStaff(decoded), false);
  });

  test('anonymous subjects are unique', () => {
    const a = decodeSession(createAnonymousSession().token)?.sub;
    const b = decodeSession(createAnonymousSession().token)?.sub;
    assert.notEqual(a, b);
  });
});

describe('sessionFromRequest', () => {
  test('reads the session cookie', () => {
    const { token } = createStaffSession('bob', 'csr');
    assert.equal(sessionFromRequest(withCookie(token))?.sub, 'bob');
  });

  test('returns null with no cookie header', () => {
    assert.equal(sessionFromRequest(new Request('https://x/')), null);
  });

  test('finds the session among other cookies', () => {
    const { token } = createStaffSession('bob', 'csr');
    const req = new Request('https://x/', {
      headers: { cookie: `theme=dark; ${SESSION_COOKIE}=${token}; other=1` },
    });
    assert.equal(sessionFromRequest(req)?.sub, 'bob');
  });

  test('returns null for a forged cookie', () => {
    assert.equal(sessionFromRequest(withCookie('made.up')), null);
  });
});

describe('cookieOptions', () => {
  test('is HttpOnly and SameSite=Lax', () => {
    const o = cookieOptions(60);
    assert.equal(o.httpOnly, true, 'must not be readable from JavaScript');
    assert.equal(o.sameSite, 'lax');
    assert.equal(o.path, '/');
  });
});
