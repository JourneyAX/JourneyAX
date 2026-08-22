/**
 * Who is allowed in.
 *
 * Two directory implementations ship:
 *
 *   env  (default)  — `JOURNEYAX_USERS`, read-only. Fine for a fixed set of
 *                     pilot accounts. Password changes, MFA enrolment and
 *                     recovery codes are impossible because there is nowhere
 *                     to write.
 *   file            — `JOURNEYAX_USER_STORE=./data/users.json`, writable.
 *                     Enables everything above.
 *
 * Both satisfy `UserDirectory`, so swapping in a database later means writing
 * one object; no route handler changes.
 *
 * Format of `JOURNEYAX_USERS` — comma-separated, one record per user:
 *
 *   username:role:scrypt.N.r.p.salt.hash
 *
 * Provision an account with:
 *
 *   npx tsx src/scripts/make-user.ts <username> <csr|admin>
 *
 * Passwords are never stored in plaintext, in this file or in the env var.
 */

import { verifyPassword } from './passwords';
import { createFileDirectory } from './file-store';
import type { Role, UserDirectory, UserRecord, UserPatch } from './types';
import { logger } from '@/lib/logger';

const log = logger('auth/users');

export type { Role, UserRecord, UserDirectory, UserPatch };

function parseUsers(raw: string | undefined): Map<string, UserRecord> {
  const users = new Map<string, UserRecord>();
  if (!raw) return users;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Only split the first two separators — the hash contains none today,
    // but splitting unbounded would break if that ever changed.
    const first = trimmed.indexOf(':');
    const second = trimmed.indexOf(':', first + 1);
    if (first === -1 || second === -1) {
      log.warn('skipping malformed JOURNEYAX_USERS entry');
      continue;
    }

    const username = trimmed.slice(0, first).trim().toLowerCase();
    const role = trimmed.slice(first + 1, second).trim();
    const passwordHash = trimmed.slice(second + 1).trim();

    if (!username || (role !== 'csr' && role !== 'admin') || !passwordHash) {
      log.warn('skipping JOURNEYAX_USERS entry with an invalid username or role');
      continue;
    }

    users.set(username, { username, role, passwordHash });
  }

  return users;
}

/** Parsed once per process; the env var does not change at runtime. */
let cached: Map<string, UserRecord> | null = null;

export const envDirectory: UserDirectory = {
  writable: false,
  async find(username) {
    if (!cached) {
      cached = parseUsers(process.env.JOURNEYAX_USERS);
      log.info(`env user directory loaded: ${cached.size} user(s)`);
    }
    return cached.get(username.trim().toLowerCase()) ?? null;
  },
  async list() {
    if (!cached) cached = parseUsers(process.env.JOURNEYAX_USERS);
    return [...cached.values()];
  },
};

/** Resolved lazily so tests can change the environment between cases. */
let directory: UserDirectory | null = null;
let explicit = false;

function resolveDirectory(): UserDirectory {
  if (directory) return directory;

  const storePath = process.env.JOURNEYAX_USER_STORE;
  if (storePath) {
    log.info(`using writable file user store: ${storePath}`);
    directory = createFileDirectory(storePath);
  } else {
    directory = envDirectory;
  }
  return directory;
}

/** Swap in a real directory (database, LDAP, SSO) at startup. */
export function setUserDirectory(next: UserDirectory) {
  directory = next;
  explicit = true;
}

/** Test seam — clears the env cache and any resolved directory. */
export function __resetUserCache() {
  cached = null;
  if (!explicit) directory = null;
}

/** Test seam — forget an explicitly installed directory too. */
export function __resetUserDirectory() {
  cached = null;
  directory = null;
  explicit = false;
}

export function currentDirectory(): UserDirectory {
  return resolveDirectory();
}

/** True when self-service password and MFA changes are possible. */
export function directoryIsWritable(): boolean {
  return resolveDirectory().writable;
}

export async function findUser(username: string): Promise<UserRecord | null> {
  return resolveDirectory().find(username);
}

/**
 * Persist a change to an account.
 *
 * Returns null when the directory is read-only, so callers report an honest
 * "not supported here" rather than claiming success and silently discarding
 * a new password.
 */
export async function updateUser(username: string, patch: UserPatch): Promise<UserRecord | null> {
  const dir = resolveDirectory();
  if (!dir.writable || !dir.update) {
    log.warn('update attempted against a read-only user directory');
    return null;
  }
  return dir.update(username, patch);
}

/**
 * Authenticate a username and password.
 *
 * Runs the password comparison even when the user does not exist, so the
 * response time does not reveal which usernames are real.
 */
export async function authenticate(username: string, password: string): Promise<UserRecord | null> {
  const user = await findUser(username);

  // A syntactically valid hash of a value nobody knows. Keeps the work
  // comparable between the "no such user" and "wrong password" paths.
  const hash = user?.passwordHash
    ?? 'scrypt.32768.8.1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const ok = await verifyPassword(password, hash);
  if (!ok || !user) return null;

  // A disabled account must fail exactly like a wrong password — telling the
  // caller "that account is disabled" confirms the username exists.
  if (user.disabled) {
    log.warn(`sign-in refused for disabled account: ${user.username}`);
    return null;
  }

  return user;
}

/** True when nobody has been provisioned — used to warn rather than lock out. */
export async function directoryIsEmpty(): Promise<boolean> {
  const dir = resolveDirectory();
  if (!dir.list) return false;
  return (await dir.list()).length === 0;
}
