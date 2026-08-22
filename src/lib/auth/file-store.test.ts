import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDirectory, upsertUser } from './file-store';
import type { UserRecord } from './types';

let dir: string;
let file: string;

const alice: UserRecord = {
  username: 'alice',
  role: 'csr',
  passwordHash: 'scrypt.32768.8.1.AAAA.BBBB',
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jax-users-'));
  file = join(dir, 'users.json');
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('createFileDirectory', () => {
  test('is writable', () => {
    assert.equal(createFileDirectory(file).writable, true);
  });

  test('a missing file reads as empty rather than throwing', async () => {
    assert.equal(await createFileDirectory(file).find('alice'), null);
  });

  test('round-trips a user', async () => {
    await upsertUser(file, alice);
    const found = await createFileDirectory(file).find('alice');
    assert.equal(found?.username, 'alice');
    assert.equal(found?.role, 'csr');
  });

  test('lookup is case-insensitive', async () => {
    await upsertUser(file, alice);
    assert.ok(await createFileDirectory(file).find('ALICE'));
  });

  test('persists an update', async () => {
    await upsertUser(file, alice);
    const d = createFileDirectory(file);
    await d.update!('alice', { totpSecret: 'SECRET', mustChangePassword: true });

    const reread = await createFileDirectory(file).find('alice');
    assert.equal(reread?.totpSecret, 'SECRET');
    assert.equal(reread?.mustChangePassword, true);
  });

  test('refuses to change username or role', async () => {
    await upsertUser(file, alice);
    const d = createFileDirectory(file);
    // Cast past the type guard — the runtime must refuse too.
    await d.update!('alice', { username: 'mallory', role: 'admin' } as never);

    const reread = await createFileDirectory(file).find('alice');
    assert.equal(reread?.username, 'alice');
    assert.equal(reread?.role, 'csr', 'privilege escalation via patch must fail');
  });

  test('updating an unknown user returns null', async () => {
    await upsertUser(file, alice);
    assert.equal(await createFileDirectory(file).update!('nobody', { disabled: true }), null);
  });

  test('serialises concurrent updates without losing one', async () => {
    await upsertUser(file, alice);
    const d = createFileDirectory(file);

    // Read-modify-write on a shared file is a lost-update race without the
    // internal queue.
    await Promise.all([
      d.update!('alice', { totpSecret: 'S1' }),
      d.update!('alice', { mustChangePassword: true }),
      d.update!('alice', { disabled: false }),
    ]);

    const reread = await createFileDirectory(file).find('alice');
    assert.equal(reread?.totpSecret, 'S1');
    assert.equal(reread?.mustChangePassword, true);
  });

  test('drops malformed records instead of trusting the file', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      users: [
        alice,
        { username: 'norole', passwordHash: 'x' },
        { username: 'badrole', role: 'wizard', passwordHash: 'x' },
        { role: 'csr', passwordHash: 'x' },
        null,
      ],
    }), 'utf8');

    const d = createFileDirectory(file);
    assert.ok(await d.find('alice'));
    assert.equal(await d.find('norole'), null);
    assert.equal(await d.find('badrole'), null, 'an invalid role must not be admitted');
  });

  test('a corrupt file throws rather than silently emptying the directory', async () => {
    await writeFile(file, 'not json at all', 'utf8');
    // Reading as "empty" would delete every account on the next write.
    await assert.rejects(() => createFileDirectory(file).find('alice'));
  });

  test('writes valid JSON', async () => {
    await upsertUser(file, alice);
    await createFileDirectory(file).update!('alice', { disabled: true });
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.users.length, 1);
  });

  test('upsert replaces rather than duplicating', async () => {
    await upsertUser(file, alice);
    await upsertUser(file, { ...alice, passwordHash: 'scrypt.32768.8.1.CCCC.DDDD' });
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.users.length, 1, 'must not create a second alice');
  });
});
