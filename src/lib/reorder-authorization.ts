import { coachFromRequest } from './coach/session';

export type ReorderRole = 'coach' | 'school-admin' | 'dealer' | 'csr' | 'artist' | 'approver';

export type ReorderViewer = {
  id: string;
  email: string;
  name: string;
  role: ReorderRole;
  schools: string[];
  source: 'coach-link' | 'authenticated-header' | 'local-demo';
};

type AuthorizedUserConfig = Omit<ReorderViewer, 'source'>;

type ViewerOptions = {
  nodeEnv?: string;
  demoMode?: string;
  authorizedUsersJson?: string;
};

const LOCAL_DEMO_VIEWER: ReorderViewer = {
  id: 'demo-coach-ramirez',
  email: 'coach.ramirez@example.invalid',
  name: 'Coach Ramirez',
  role: 'coach',
  schools: ['Lakeshore Central High School'],
  source: 'local-demo',
};

const ROLES = new Set<ReorderRole>(['coach', 'school-admin', 'dealer', 'csr', 'artist', 'approver']);

function readAuthorizedUsers(value: string | undefined): AuthorizedUserConfig[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AuthorizedUserConfig => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<AuthorizedUserConfig>;
      return typeof candidate.id === 'string'
        && typeof candidate.email === 'string'
        && typeof candidate.name === 'string'
        && typeof candidate.role === 'string'
        && ROLES.has(candidate.role as ReorderRole)
        && Array.isArray(candidate.schools)
        && candidate.schools.length > 0
        && candidate.schools.every((school) => typeof school === 'string' && school.trim().length > 0);
    });
  } catch {
    return [];
  }
}

export function resolveReorderViewer(request: Request, options: ViewerOptions = {}): ReorderViewer | null {
  // ── 1. A coach who clicked their emailed link and confirmed the code ──
  //
  // Checked first, and the only source here that proves anything on its own:
  // the invite token proves Momentec sent the link, the six-digit code proves
  // the recipient controls the mailbox. The headers below are trusted only
  // because an upstream proxy is assumed to set them.
  //
  // Schools come from the directory via the coach record, never from the
  // cookie, so removing a school takes effect on the next request.
  const coach = coachFromRequest(request);
  if (coach) {
    return {
      id: coach.id,
      email: coach.email,
      name: coach.name,
      role: coach.role,
      schools: coach.schools,
      source: 'coach-link',
    };
  }

  const userId = request.headers.get('oai-authenticated-user-id')?.trim();
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  const users = readAuthorizedUsers(options.authorizedUsersJson ?? process.env.REORDER_AUTHORIZED_USERS_JSON);

  if (userId && email) {
    const configured = users.find((user) => user.id === userId || user.email.toLowerCase() === email);
    return configured ? { ...configured, source: 'authenticated-header' } : null;
  }

  // ── 3. Demo fallback — now opt-in, and deliberately so ───────────────
  //
  // This used to fire automatically whenever NODE_ENV was not 'production',
  // so every visitor in development silently became Coach Ramirez. Fine for
  // demoing the reorder screen, fatal for demoing the access control: signed
  // out and signed in looked identical, so nothing proved the scoping worked.
  //
  // Set REORDER_DEMO_MODE=true to restore the old behaviour.
  const demoMode = options.demoMode ?? process.env.REORDER_DEMO_MODE;
  if (demoMode === 'true') return LOCAL_DEMO_VIEWER;
  return null;
}

export function filterOrdersForViewer<T extends { school: string }>(records: T[], viewer: ReorderViewer) {
  const authorizedSchools = new Set(viewer.schools.map((school) => school.trim().toLowerCase()));
  return records.filter((record) => authorizedSchools.has(record.school.trim().toLowerCase()));
}
