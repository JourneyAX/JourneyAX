/**
 * Coach session revocation.
 *
 * Without this, "sign out" only clears the cookie: a token copied beforehand
 * keeps working for its full twelve hours. That is a realistic problem rather
 * than a theoretical one — coaches use school computers, and a session that
 * survives signing out is exactly the one a next user inherits.
 *
 * Each session carries a `jti`. Signing out records that id as dead until the
 * token would have expired anyway, at which point the entry is swept.
 *
 * In-process: revocations are lost on restart (which also invalidates nothing
 * important, since restarting does not resurrect a cookie's usefulness to an
 * attacker who already had it) and are not shared between instances. Move to
 * Redis alongside the code store before running more than one.
 */

const revoked = new Map<string, number>();

let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const nowSec = Math.floor(now / 1000);
  for (const [jti, exp] of revoked) {
    if (exp <= nowSec) revoked.delete(jti);
  }
}

export function revoke(jti: string, expiresAt: number) {
  sweep();
  revoked.set(jti, expiresAt);
}

export function isRevoked(jti: string | undefined): boolean {
  // Fails closed: a session minted before revocation existed has no id, and
  // must not be able to dodge the check by lacking one.
  if (!jti) return true;
  sweep();
  const exp = revoked.get(jti);
  if (exp === undefined) return false;
  if (exp <= Math.floor(Date.now() / 1000)) {
    revoked.delete(jti);
    return false;
  }
  return true;
}

export function __resetRevocations() {
  revoked.clear();
  lastSweep = Date.now();
}
