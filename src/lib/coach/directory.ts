/**
 * Who may be invited, and which schools they may see.
 *
 * Deliberately reuses `REORDER_AUTHORIZED_USERS_JSON` — the variable
 * `reorder-authorization.ts` already reads — rather than inventing a second
 * roster. Two lists of who-may-see-what drift apart, and the day they do,
 * one of them is wrong about a coach's school.
 *
 * A coach's schools are ALWAYS read from here, never from the session cookie.
 * That means removing a school from this list takes effect on the coach's
 * very next request, instead of whenever their session happens to expire.
 */

import type { ReorderRole } from '../reorder-authorization';

export interface CoachRecord {
  id: string;
  email: string;
  name: string;
  role: ReorderRole;
  schools: string[];
}

const ROLES = new Set<ReorderRole>(['coach', 'school-admin', 'dealer', 'csr', 'artist', 'approver']);

/**
 * Seeded so the flow is demonstrable out of the box. These are
 * `.invalid` addresses, which by RFC 2606 can never receive mail — nobody can
 * be phished through a seeded record, and a real deployment overrides this
 * wholesale via REORDER_AUTHORIZED_USERS_JSON.
 */
const DEMO_COACHES: CoachRecord[] = [
  {
    id: 'demo-coach-ramirez',
    email: 'coach.ramirez@example.invalid',
    name: 'Coach Ramirez',
    role: 'coach',
    schools: ['Lakeshore Central High School'],
  },
];

function parse(value: string | undefined): CoachRecord[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is CoachRecord => {
      if (!entry || typeof entry !== 'object') return false;
      const c = entry as Partial<CoachRecord>;
      return typeof c.id === 'string' && c.id.length > 0
        && typeof c.email === 'string' && c.email.includes('@')
        && typeof c.name === 'string' && c.name.length > 0
        && typeof c.role === 'string' && ROLES.has(c.role as ReorderRole)
        && Array.isArray(c.schools)
        && c.schools.length > 0
        && c.schools.every(s => typeof s === 'string' && s.trim().length > 0);
    });
  } catch {
    console.error('[coach] REORDER_AUTHORIZED_USERS_JSON is not valid JSON — no coaches loaded');
    return [];
  }
}

/**
 * Configured coaches, falling back to the demo roster only outside
 * production. In production an unparseable or missing list yields nobody,
 * which locks everyone out — the correct direction to fail.
 */
export function allCoaches(): CoachRecord[] {
  const configured = parse(process.env.REORDER_AUTHORIZED_USERS_JSON);
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === 'production') return [];
  return DEMO_COACHES;
}

export function findCoachById(id: string): CoachRecord | null {
  if (!id) return null;
  return allCoaches().find(c => c.id === id) ?? null;
}

export function findCoachByEmail(email: string): CoachRecord | null {
  if (!email) return null;
  const needle = email.trim().toLowerCase();
  return allCoaches().find(c => c.email.trim().toLowerCase() === needle) ?? null;
}

/**
 * Show enough of an address for the coach to recognise their own mailbox,
 * and not enough for someone holding a stolen link to learn a new one.
 * `coach.ramirez@example.invalid` → `co••••••••@example.invalid`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'•'.repeat(Math.max(3, local.length - shown.length))}${domain}`;
}
