/**
 * A writable, file-backed user directory.
 *
 * The environment-variable directory is read-only, which is why password
 * changes, MFA enrolment and recovery codes could not exist: all three need
 * somewhere to write. This is the smallest thing that closes that gap without
 * standing up a database.
 *
 * Set `JOURNEYAX_USER_STORE=./data/users.json` to use it. The file holds
 * password hashes and TOTP secrets — **it is credential material.** Keep it
 * outside the repo, restrict its permissions, and back it up with the same
 * care as a database.
 *
 * Not suitable for more than one app instance: two processes writing the same
 * file will clobber each other. At that point, implement `UserDirectory`
 * against your database — every caller is already written against the
 * interface, so nothing else changes.
 */

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UserDirectory, UserRecord, UserPatch } from './types';
import { logger } from '@/lib/logger';

const log = logger('auth/file-store');

interface StoreShape {
  version: 1;
  users: UserRecord[];
}

function isRole(v: unknown): v is UserRecord['role'] {
  return v === 'csr' || v === 'admin';
}

/** Discard anything that is not a well-formed record rather than trusting the file. */
function parseStore(raw: string): StoreShape {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('user store is not an object');

  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users)) throw new Error('user store has no users array');

  const clean: UserRecord[] = [];
  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    const rec = u as Partial<UserRecord>;
    if (typeof rec.username !== 'string' || !rec.username) continue;
    if (!isRole(rec.role)) continue;
    if (typeof rec.passwordHash !== 'string' || !rec.passwordHash) continue;
    clean.push({ ...rec, username: rec.username.toLowerCase() } as UserRecord);
  }

  return { version: 1, users: clean };
}

export function createFileDirectory(path: string): UserDirectory {
  const file = resolve(path);

  // Serialise every write. Read-modify-write on a shared file is otherwise a
  // lost-update race the moment two requests arrive together.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    // Keep the chain alive even when one operation rejects.
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<StoreShape> {
    try {
      return parseStore(await readFile(file, 'utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { version: 1, users: [] };
      // A corrupt store must not silently become an empty one — that would
      // delete every account on the next write.
      log.error('user store is unreadable or corrupt; refusing to continue', err);
      throw new Error(`User store at ${file} could not be read.`);
    }
  }

  async function save(store: StoreShape): Promise<void> {
    await mkdir(dirname(file), { recursive: true });

    // Write to a sibling then rename: a crash mid-write must not truncate the
    // only copy of every credential in the system.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Best effort — Windows does not honour POSIX modes.
    }
    await rename(tmp, file);
  }

  return {
    writable: true,

    async find(username) {
      const store = await load();
      return store.users.find(u => u.username === username.trim().toLowerCase()) ?? null;
    },

    async list() {
      return (await load()).users;
    },

    async update(username, patch: UserPatch) {
      const key = username.trim().toLowerCase();
      return exclusive(async () => {
        const store = await load();
        const idx = store.users.findIndex(u => u.username === key);
        if (idx === -1) return null;

        // Username and role are not patchable — the type forbids it, and this
        // spread order means a stray property cannot override them either.
        const updated: UserRecord = {
          ...store.users[idx],
          ...patch,
          username: store.users[idx].username,
          role: store.users[idx].role,
        };

        store.users[idx] = updated;
        await save(store);
        return updated;
      });
    },
  };
}

/** Create or replace an account. Used by the provisioning script, not by routes. */
export async function upsertUser(path: string, record: UserRecord): Promise<void> {
  const dir = createFileDirectory(path);
  const existing = await dir.find(record.username);

  if (existing && dir.update) {
    await dir.update(record.username, record);
    return;
  }

  // No update path for a brand-new user — append directly.
  const file = resolve(path);
  let store: StoreShape = { version: 1, users: [] };
  try {
    store = parseStore(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }

  store.users.push({ ...record, username: record.username.toLowerCase() });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), 'utf8');
  try {
    await chmod(file, 0o600);
  } catch {
    // Best effort on Windows.
  }
}
