/**
 * Password hashing.
 *
 * scrypt via `node:crypto` — no dependency, and deliberately slow so that a
 * leaked hash is expensive to attack. Plaintext passwords are never stored,
 * never logged, and never compared with `===`.
 *
 * Format: `scrypt.N.r.p.<salt>.<hash>`, base64url, dot-separated. Parameters
 * travel with the hash so they can be raised later without invalidating
 * existing passwords.
 *
 * The separator is `.` and not the conventional `$` on purpose. These hashes
 * live in environment variables, and `$` triggers variable expansion in
 * `.env` files, docker-compose and most shells — `scrypt$32768$8$1$…` silently
 * becomes `scrypt` followed by nothing, and every login fails with no clue
 * why. base64url for the same reason: no `+`, `/` or `=` to be quoted.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP-recommended floor for scrypt. Raise N, not r or p, to harden. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
/** Node's default maxmem (32 MB) is too small for N=2^15; give it headroom. */
const MAX_MEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('.');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt record
 * must fail closed, not crash the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('.');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, n, r, p, saltB64, hashB64] = parts;
    if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p)) return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    if (expected.length !== KEY_LEN) return false;

    const actual = await scrypt(password, salt, KEY_LEN, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEM,
    });

    // Constant-time: a plain === leaks how much of the hash matched.
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
