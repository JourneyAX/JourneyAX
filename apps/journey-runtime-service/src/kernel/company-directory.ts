/**
 * Which companies a signed-in business customer belongs to, as the team linked them in the back office.
 *
 * The runtime asks with the identity the gateway verified and signed (never with anything the browser or the model said), the project
 * service answers from its link table, and the answer is kept for a short while so a busy chat does not ask on every turn. Every failure
 * is safe: an error, a timeout, a missing key, an unknown login or a person who is not a customer all give no companies, and a person
 * with no company is an ordinary shopper. A failure is remembered only briefly so the service is not hammered while it is down.
 */
export type CompanyRole = 'account_admin' | 'accounts_payable' | 'buyer' | 'job_viewer';
export interface PersonCompany { id: string; name: string; role: CompanyRole }

const ROLES: readonly string[] = ['account_admin', 'accounts_payable', 'buyer', 'job_viewer'];
export const MAX_COMPANIES = 3;

export interface CompanyDirectoryOptions {
  /** The project service's address, or nothing when it is not configured. */
  baseUrl: () => string | undefined;
  /** Credentials for the call (the internal key, a cloud identity token). */
  headers: (baseUrl: string) => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

interface Entry { companies: PersonCompany[]; expiresAt: number }

/** What the project service sent, kept only if it is a well-formed company: anything else is dropped, so a strange answer can only give less. */
export function cleanCompanies(value: unknown): PersonCompany[] {
  if (!Array.isArray(value)) return [];
  const out: PersonCompany[] = [];
  for (const row of value) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!id || id.length > 64 || !name || name.length > 160 || !ROLES.includes(row?.role) || out.some((c) => c.id === id)) continue;
    out.push({ id, name, role: row.role });
    if (out.length >= MAX_COMPANIES) break;
  }
  return out;
}

export class CompanyDirectory {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<PersonCompany[]>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private warnedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: CompanyDirectoryOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** The person's companies in this tenant; empty when unknown. Never throws. */
  async companiesFor(tenantId: string, login: string): Promise<PersonCompany[]> {
    const tenant = String(tenantId || '').trim().toLowerCase();
    const person = String(login || '').trim().toLowerCase();
    if (!tenant || !person || !person.includes('@') || person === 'guest@anonymous') return [];
    const key = `${tenant}\u0000${person}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.companies;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lookup = this.fetchCompanies(tenant, person).then(({ companies, ok }) => {
      this.remember(key, companies, ok ? this.ttlMs : this.failureTtlMs);
      return companies;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /** Forget everything (a test, or after a link change that should show at once). */
  clear(): void {
    this.cache.clear();
  }

  private remember(key: string, companies: PersonCompany[], ttlMs: number): void {
    this.cache.delete(key);
    this.cache.set(key, { companies, expiresAt: this.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchCompanies(tenant: string, email: string): Promise<{ companies: PersonCompany[]; ok: boolean }> {
    const base = this.options.baseUrl();
    if (!base) return { companies: [], ok: false };
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${base}/api/v1/projects/${encodeURIComponent(tenant)}/company-links/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenant, ...(await this.options.headers(base)) },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.warnOnce(`[CompanyDirectory] company lookup refused (${response.status}); linked customers are treated as shoppers until it works`);
        return { companies: [], ok: false };
      }
      const data: any = await response.json().catch(() => ({}));
      return { companies: cleanCompanies(data?.companies), ok: true };
    } catch (error) {
      this.warnOnce(`[CompanyDirectory] company lookup failed (${(error as Error)?.message || 'error'}); linked customers are treated as shoppers until it works`);
      return { companies: [], ok: false };
    }
  }

  private warnOnce(message: string): void {
    const at = this.now();
    if (at - this.warnedAt < 60_000) return;
    this.warnedAt = at;
    this.warn(message);
  }
}

/** The directory the runtime uses by default: the project service named in the environment, with the internal key. Absent address: no companies, ever. */
export function defaultCompanyDirectory(): CompanyDirectory {
  return new CompanyDirectory({
    baseUrl: () => process.env.PROJECT_SERVICE_URL || undefined,
    headers: async () => (process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {}),
  });
}
