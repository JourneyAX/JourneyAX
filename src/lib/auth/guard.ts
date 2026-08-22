/**
 * Authorisation for route handlers.
 *
 * `proxy.ts` performs an optimistic cookie check to keep unauthenticated
 * people out of the staff pages, but the Next docs are explicit that the
 * proxy is not the security boundary — it runs on prefetches and can be
 * bypassed by calling an API route directly. This module is the real check,
 * and it lives next to the data.
 *
 * Every staff-only route handler must call `requireStaff` before doing work.
 */

import { sessionFromRequest, type SessionPayload, type Role } from './session';
import { errorResponse } from '@/lib/api-guard';

export interface Authorised {
  session: SessionPayload;
}
export interface Unauthorised {
  response: Response;
}
export type AuthResult = Authorised | Unauthorised;

export function isUnauthorised(r: AuthResult): r is Unauthorised {
  return 'response' in r;
}

/**
 * Require an authenticated staff session, optionally of a specific role.
 *
 * Returns either the session or a finished 401/403 to hand straight back.
 */
export function requireStaff(req: Request, roles?: Role[]): AuthResult {
  const session = sessionFromRequest(req);

  // An anonymous session has no role and must never pass. This is why the
  // check is on `role` and not merely on the session existing.
  if (!session?.role) {
    return { response: errorResponse(401, 'not_authenticated', 'Sign in to continue.') };
  }

  if (roles && !roles.includes(session.role)) {
    return { response: errorResponse(403, 'forbidden', 'Your account cannot perform this action.') };
  }

  return { session };
}

/**
 * Identify the caller for rate limiting.
 *
 * Prefers the session subject over the IP address. A school, a call centre
 * and an office all share one public IP, so IP-keyed limits punish the second
 * person through the door; a per-browser session does not.
 */
export function rateLimitSubject(req: Request): string | null {
  return sessionFromRequest(req)?.sub ?? null;
}
