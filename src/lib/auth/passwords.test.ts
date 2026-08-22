import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './passwords';

describe('hashPassword', () => {
  test('never returns the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.ok(!hash.includes('correct horse'));
    assert.ok(hash.startsWith('scrypt.'));
  });

  test('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b, 'identical hashes would reveal shared passwords');
  });
});

describe('verifyPassword', () => {
  test('accepts the right password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    assert.equal(await verifyPassword('s3cret-passphrase', hash), true);
  });

  test('rejects the wrong password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    assert.equal(await verifyPassword('s3cret-passphras', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('fails closed on a malformed hash rather than throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt.1.2.3', 'bcrypt.a.b.c.d.e', 'scrypt.a.b.c.d.e']) {
      assert.equal(await verifyPassword('anything', bad), false, `should reject ${bad}`);
    }
  });

  test('rejects a hash of the wrong length', async () => {
    assert.equal(await verifyPassword('x', 'scrypt.32768.8.1.AAAA.AAAA'), false);
  });
});
