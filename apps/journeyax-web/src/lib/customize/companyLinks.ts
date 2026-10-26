/**
 * Which company each business customer's login belongs to, as the team sets it by hand in the back office. The browser never talks to the
 * project service itself: the web route calls these with the person's own token, and the project service checks the permission to change
 * the configuration (a person without it is told so, here, in plain words).
 *
 * A link is how the assistant knows, for a signed-in customer, whose deliveries, balance and prices to read. The team checks who the person
 * is before linking; nothing about it is self-service.
 */
export interface CompanyDeps {
  /** `<project api>/api/v1/projects/<tenant>` */
  base: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}
export interface CompanyResult { status: number; body: Record<string, unknown> }

export const COMPANY_ROLES = [
  { id: 'account_admin', label: 'Account administrator', hint: 'Runs the account: deliveries, prices and the balance.' },
  { id: 'accounts_payable', label: 'Accounts payable', hint: 'Pays the bills: deliveries, prices and the balance.' },
  { id: 'buyer', label: 'Buyer', hint: 'Orders for the company: deliveries and prices, not the balance.' },
  { id: 'job_viewer', label: 'Job viewer', hint: 'Follows jobs on site: deliveries and prices, not the balance.' },
] as const;
export type CompanyRoleId = (typeof COMPANY_ROLES)[number]['id'];
export const roleLabel = (id: string): string => COMPANY_ROLES.find((role) => role.id === id)?.label ?? id;

export interface CompanyLinkRow { email: string; companyId: string; companyName: string; role: CompanyRoleId; linkedBy: string; linkedAt: string }
export interface LinkOp { email: string; companyId: string; companyName: string; role: CompanyRoleId }
export interface UnlinkOp { email: string; companyId: string }

const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,100}$/;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const forbidden = (): CompanyResult => ({ status: 403, body: { error: 'Company links are for people who may change the configuration.' } });
const messageOf = async (res: Response, fallback: string): Promise<string> => {
  const detail: any = await res.json().catch(() => ({}));
  const message = Array.isArray(detail?.message) ? detail.message.join(' ') : detail?.message;
  return typeof message === 'string' && message ? message : fallback;
};

/** What the page asked to link, or why it cannot be linked. */
export function readLinkOp(body: unknown): LinkOp | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return { error: 'Give the login the person signs in with, such as name@company.' };
  const companyId = typeof b.companyId === 'string' ? b.companyId.trim() : '';
  if (!COMPANY_ID.test(companyId)) return { error: 'Give the company’s account id, as the accounts system has it (letters, digits and - _ . :).' };
  const companyName = typeof b.companyName === 'string' ? b.companyName.replace(/\s+/g, ' ').trim() : '';
  if (!companyName || companyName.length > 160) return { error: 'Give the company’s name (up to 160 characters).' };
  if (!COMPANY_ROLES.some((role) => role.id === b.role)) return { error: 'Choose the person’s role in the company.' };
  return { email, companyId, companyName, role: b.role as CompanyRoleId };
}

export function readUnlinkOp(body: unknown): UnlinkOp | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const companyId = typeof b.companyId === 'string' ? b.companyId.trim() : '';
  if (!EMAIL.test(email) || !COMPANY_ID.test(companyId)) return { error: 'Say which login and which company to unlink.' };
  return { email, companyId };
}

/** The links the project service sent, kept only if they are well formed. */
export function parseLinks(value: unknown): CompanyLinkRow[] {
  const rows = (value && typeof value === 'object' ? (value as any).links : undefined);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: any) => {
    if (!row || typeof row.email !== 'string' || typeof row.companyId !== 'string' || typeof row.companyName !== 'string' || !COMPANY_ROLES.some((role) => role.id === row.role)) return [];
    return [{ email: row.email, companyId: row.companyId, companyName: row.companyName, role: row.role, linkedBy: String(row.linkedBy ?? ''), linkedAt: String(row.linkedAt ?? '') }];
  });
}

export async function listLinks(deps: CompanyDeps): Promise<CompanyResult> {
  const call = deps.fetchImpl ?? fetch;
  let res: Response;
  try { res = await call(`${deps.base}/company-links`, { headers: deps.headers, signal: AbortSignal.timeout(8000), cache: 'no-store' }); }
  catch { return { status: 502, body: { error: 'The company links could not be read: the service did not answer.' } }; }
  if (res.status === 401 || res.status === 403) return forbidden();
  if (res.status === 404) return { status: 404, body: { error: await messageOf(res, 'This project does not exist.') } };
  if (!res.ok) return { status: 502, body: { error: 'The company links could not be read just now.' } };
  return { status: 200, body: { links: parseLinks(await res.json().catch(() => null)) } };
}

export async function saveLink(deps: CompanyDeps, op: LinkOp): Promise<CompanyResult> {
  const call = deps.fetchImpl ?? fetch;
  let res: Response;
  try { res = await call(`${deps.base}/company-links`, { method: 'PUT', headers: { ...deps.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(op), signal: AbortSignal.timeout(8000) }); }
  catch { return { status: 502, body: { error: 'The link could not be saved: the service did not answer.' } }; }
  if (res.status === 401 || res.status === 403) return { status: 403, body: { error: 'Linking a login to a company needs permission to change the configuration.' } };
  if (res.status === 400 || res.status === 404) return { status: res.status, body: { error: await messageOf(res, 'The link could not be saved.') } };
  if (!res.ok) return { status: 502, body: { error: 'The link could not be saved just now.' } };
  return { status: 200, body: { ok: true } };
}

export async function removeLink(deps: CompanyDeps, op: UnlinkOp): Promise<CompanyResult> {
  const call = deps.fetchImpl ?? fetch;
  let res: Response;
  try { res = await call(`${deps.base}/company-links`, { method: 'DELETE', headers: { ...deps.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(op), signal: AbortSignal.timeout(8000) }); }
  catch { return { status: 502, body: { error: 'The link could not be removed: the service did not answer.' } }; }
  if (res.status === 401 || res.status === 403) return { status: 403, body: { error: 'Removing a link needs permission to change the configuration.' } };
  if (res.status === 400 || res.status === 404) return { status: res.status, body: { error: await messageOf(res, 'The link could not be removed.') } };
  if (!res.ok) return { status: 502, body: { error: 'The link could not be removed just now.' } };
  const done: any = await res.json().catch(() => ({}));
  return { status: 200, body: { ok: true, removed: done?.removed === true } };
}
