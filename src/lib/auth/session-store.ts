/**
 * Session revocation.
 *
 * Sessions are stateless signed tokens, which is why "sign out" previously
 * only cleared the cookie: a token already copied off the machine stayed
 * valid for its full eight hours, and nothing could stop it. That is the gap
 * this closes.
 *
 * Two mechanisms, because they answer different questions:
 *
 *   revokeToken(jti)     — this one session. Ordinary sign-out.
 *   revokeAllFor(user)   — every session that user currently holds. What you
 *                          reach for after a password change, or when someone
 *                          says "I think my laptop was stolen".
 *
 * The second is implemented as a per-user cutoff timestamp rather than a list
 * of ids, so it revokes sessions this process has never seen — including ones
 * issued before a restart.
 *
 * In-process by default. Both maps must move to a shared store before running
 * more than one instance, or a revoked session stays alive on every other
 * instance. `setSessionStore` is the seam.
 */

import { logger } from '@/lib/logger';

const log = logger('auth/session-store');

export interface SessionStore {
  /** Mark one session id revoked until `expiresAt` (Unix seconds). */
  revokeToken(jti: string, expiresAt: number): void;
  isTokenRevoked(jti: string): boolean;
  /**
   * Revoke everything issued to this user at or before `cutoff`, except one
   * session id. The exemption exists because the common caller — a password
   * change — must not sign the user out of the tab they are standing in, and
   * timestamps alone cannot distinguish the replacement session from an
   * intruder's session issued in the same second.
   */
  revokeAllFor(username: string, cutoff: number, exceptJti?: string): void;
  cutoffFor(username: string): { cutoff: number; exceptJti?: string } | undefined;
  clear(): void;
}

function createMemoryStore(): SessionStore {
  /** jti -> expiry. Entries are dropped once the token would expire anyway. */
  const revoked = new Map<string, number>();
  /** username -> "any session issued at or before this is dead, bar one". */
  const cutoffs = new Map<string, { cutoff: number; exceptJti?: string }>();

  let lastSweep = Date.now();
  function sweep() {
    const now = Date.now();
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    const nowSec = Math.floor(now / 1000);
    for (const [jti, exp] of revoked) {
      // Once the token has expired on its own, the entry is dead weight.
      if (exp <= nowSec) revoked.delete(jti);
    }
  }

  return {
    revokeToken(jti, expiresAt) {
      sweep();
      revoked.set(jti, expiresAt);
    },
    isTokenRevoked(jti) {
      sweep();
      const exp = revoked.get(jti);
      if (exp === undefined) return false;
      if (exp <= Math.floor(Date.now() / 1000)) {
        revoked.delete(jti);
        return false;
      }
      return true;
    },
    revokeAllFor(username, cutoff, exceptJti) {
      cutoffs.set(username.toLowerCase(), { cutoff, exceptJti });
      log.info(`all sessions revoked for ${username}`);
    },
    cutoffFor(username) {
      return cutoffs.get(username.toLowerCase());
    },
    clear() {
      revoked.clear();
      cutoffs.clear();
    },
  };
}

let store: SessionStore = createMemoryStore();

/** Install a shared (e.g. Redis-backed) store at startup. */
export function setSessionStore(next: SessionStore) {
  store = next;
}

export function revokeToken(jti: string, expiresAt: number) {
  store.revokeToken(jti, expiresAt);
}

export function revokeAllFor(
  username: string,
  options: { cutoff?: number; exceptJti?: string } = {},
) {
  store.revokeAllFor(
    username,
    options.cutoff ?? Math.floor(Date.now() / 1000),
    options.exceptJti,
  );
}

/**
 * Is this session still good?
 *
 * Fails closed: a session with no `jti` predates revocation support and is
 * treated as revoked, so old tokens cannot dodge the check.
 */
export function isRevoked(payload: { sub: string; jti?: string; iat: number }): boolean {
  if (!payload.jti) return true;
  if (store.isTokenRevoked(payload.jti)) return true;

  const entry = store.cutoffFor(payload.sub);
  if (entry) {
    // The explicitly exempted session survives regardless of its timestamp.
    if (entry.exceptJti && payload.jti === entry.exceptJti) return false;
    // `<=` so a session issued in the same second as the revocation dies too.
    if (payload.iat <= entry.cutoff) return true;
  }

  return false;
}

/** Test seam. */
export function __resetSessionStore() {
  store.clear();
}
