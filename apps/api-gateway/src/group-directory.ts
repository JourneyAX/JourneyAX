/**
 * Which staff groups a signed-in person belongs to, looked up by the gateway so the groups can be signed into the identity assertion.
 *
 * The browser never says which groups it is in; the gateway asks the project service (the member's `teams`) and keeps the answer for a
 * short while so a busy chat does not call it on every turn. The answer is only ever used to *narrow* what a person may reach, so every
 * failure is safe: an error, a timeout, a missing key or an unknown person all give no groups (and the person keeps what a member of staff
 * without a group gets). A failure is remembered only briefly so the service is not hammered while it is down.
 */
import { normaliseGroups } from '@journeyax/shared-types';

export interface GroupDirectoryOptions {
  /** The project service's address, or nothing when it is not configured. */
  baseUrl: () => string | undefined;
  /** Credentials for the call (the internal key, the cloud identity token). */
  headers: (baseUrl: string) => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  /** How long a found answer is kept (default 60 s). */
  ttlMs?: number;
  /** How long a failure is kept (default 10 s). */
  failureTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

interface Entry { groups: string[]; expiresAt: number }

export class GroupDirectory {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<string[]>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private warnedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: GroupDirectoryOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** The person's groups in this tenant, normalised; empty when unknown. Never throws. */
  async groupsFor(tenantId: string, email: string): Promise<string[]> {
    const tenant = String(tenantId || '').trim().toLowerCase();
    const person = String(email || '').trim().toLowerCase();
    if (!tenant || !person || !person.includes('@') || person === 'guest@anonymous') return [];
    const key = `${tenant}\u0000${person}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.groups;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lookup = this.fetchGroups(tenant, person).then(({ groups, ok }) => {
      this.remember(key, groups, ok ? this.ttlMs : this.failureTtlMs);
      return groups;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /** Forget everything (a test, or after a team change that should show at once). */
  clear(): void {
    this.cache.clear();
  }

  private remember(key: string, groups: string[], ttlMs: number): void {
    this.cache.delete(key);
    this.cache.set(key, { groups, expiresAt: this.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchGroups(tenant: string, email: string): Promise<{ groups: string[]; ok: boolean }> {
    const base = this.options.baseUrl();
    if (!base) return { groups: [], ok: false };
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${base}/api/v1/projects/${encodeURIComponent(tenant)}/verify-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenant, ...(await this.options.headers(base)) },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.warnOnce(`[GroupDirectory] membership lookup refused (${response.status}); staff groups are empty until it works`);
        return { groups: [], ok: false };
      }
      const data: any = await response.json().catch(() => ({}));
      if (!data || data.isMember !== true) return { groups: [], ok: true };
      return { groups: normaliseGroups(data.teams), ok: true };
    } catch (error) {
      this.warnOnce(`[GroupDirectory] membership lookup failed (${(error as Error)?.message || 'error'}); staff groups are empty until it works`);
      return { groups: [], ok: false };
    }
  }

  private warnOnce(message: string): void {
    const at = this.now();
    if (at - this.warnedAt < 60_000) return;
    this.warnedAt = at;
    this.warn(message);
  }
}
