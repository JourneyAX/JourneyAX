import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, directoryIsEmpty, __resetUserCache } from './users';
import { hashPassword } from './passwords';

const original = process.env.JOURNEYAX_USERS;
after(() => { process.env.JOURNEYAX_USERS = original; });

async function provision(entries: string) {
  process.env.JOURNEYAX_USERS = entries;
  __resetUserCache();
}

describe('authenticate', () => {
  beforeEach(() => __resetUserCache());

  test('accepts a correct password', async () => {
    const hash = await hashPassword('a-good-long-password');
    await provision(`alice:csr:${hash}`);
    const user = await authenticate('alice', 'a-good-long-password');
    assert.equal(user?.username, 'alice');
    assert.equal(user?.role, 'csr');
  });

  test('rejects a wrong password', async () => {
    const hash = await hashPassword('a-good-long-password');
    await provision(`alice:csr:${hash}`);
    assert.equal(await authenticate('alice', 'wrong'), null);
  });

  test('rejects an unknown user', async () => {
    const hash = await hashPassword('a-good-long-password');
    await provision(`alice:csr:${hash}`);
    assert.equal(await authenticate('mallory', 'a-good-long-password'), null);
  });

  test('is case-insensitive on the username', async () => {
    const hash = await hashPassword('a-good-long-password');
    await provision(`alice:csr:${hash}`);
    assert.ok(await authenticate('ALICE', 'a-good-long-password'));
  });

  test('supports multiple users', async () => {
    const [h1, h2] = await Promise.all([hashPassword('pw-one-is-long'), hashPassword('pw-two-is-long')]);
    await provision(`alice:csr:${h1},bob:admin:${h2}`);
    assert.equal((await authenticate('bob', 'pw-two-is-long'))?.role, 'admin');
    assert.equal(await authenticate('bob', 'pw-one-is-long'), null);
  });

  test('skips entries with an invalid role rather than admitting them', async () => {
    const hash = await hashPassword('a-good-long-password');
    await provision(`mallory:superuser:${hash}`);
    assert.equal(await authenticate('mallory', 'a-good-long-password'), null);
  });

  test('authenticates nobody when the directory is empty', async () => {
    await provision('');
    assert.equal(await authenticate('alice', 'anything'), null);
  });
});

describe('directoryIsEmpty', () => {
  test('true when unset', async () => {
    await provision('');
    assert.equal(await directoryIsEmpty(), true);
  });

  test('false once a user exists', async () => {
    await provision(`alice:csr:${await hashPassword('a-good-long-password')}`);
    assert.equal(await directoryIsEmpty(), false);
  });
});
