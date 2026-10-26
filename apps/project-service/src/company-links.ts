/**
 * Which company a signed-in trade customer belongs to, as the team set it by hand in the back office.
 *
 * One row per login (an e-mail) and company: the company's account id (the one the accounts system uses), its name, and the person's role in
 * it. The team checks who the person is out of band and links their login; nothing here is self-service, and a login that is not linked is an
 * ordinary shopper. The runtime asks `lookup` with the identity the gateway verified, never with anything the browser or the model said.
 *
 * It is customer data for the project, not part of the published pack: saving a link needs no publication and changes no wording.
 */
import { z } from 'zod';

export const COMPANY_LINK_COLLECTION = 'project_company_links';
export const COMPANY_ROLES = ['account_admin', 'accounts_payable', 'buyer', 'job_viewer'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
export const MAX_LINKS_PER_PROJECT = 1000;
export const MAX_COMPANIES_PER_LOGIN = 3;

const Email = z.string().trim().toLowerCase().min(3).max(200).regex(/^[^\s@]+@[^\s@]+$/, 'a login looks like name@company');
export const CompanyLinkInput = z.object({
  email: Email,
  companyId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'a company id uses letters, digits and _ . : -'),
  companyName: z.string().trim().min(1).max(160),
  role: z.enum(COMPANY_ROLES),
});

export interface CompanyLink {
  projectId: string;
  email: string;
  companyId: string;
  companyName: string;
  role: CompanyRole;
  linkedBy: string;
  linkedAt: string;
}

/** A company as the runtime sees it for a person: only what a customer tool needs. */
export interface PersonCompany { id: string; name: string; role: CompanyRole }

export class CompanyLinkError extends Error {
  constructor(public readonly code: 'invalid' | 'limit', message: string) { super(message); this.name = 'CompanyLinkError'; }
}

interface CollectionLike {
  find(filter: any, options?: any): { toArray(): Promise<any[]>; sort?: (spec: any) => any } | any;
  countDocuments?(filter: any): Promise<number>;
  updateOne(filter: any, update: any, options?: any): Promise<any>;
  deleteOne?(filter: any): Promise<{ deletedCount?: number }>;
  deleteMany?(filter: any): Promise<{ deletedCount?: number }>;
  createIndex?(spec: any, options?: any): Promise<any>;
}

const strip = (doc: any): CompanyLink => { const { _id: _ignored, ...rest } = doc; return rest as CompanyLink; };

export class CompanyLinkStore {
  private indexed = false;
  constructor(private readonly collection: CollectionLike, private readonly now: () => Date = () => new Date()) {}

  private async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    this.indexed = true;
    try { await this.collection.createIndex?.({ projectId: 1, email: 1, companyId: 1 }, { unique: true }); } catch { /* a guard, not a requirement */ }
  }

  async list(projectId: string): Promise<CompanyLink[]> {
    const rows: any[] = await this.collection.find({ projectId }).toArray();
    return rows.map(strip).sort((a, b) => a.companyName.localeCompare(b.companyName) || a.email.localeCompare(b.email));
  }

  /** Links a login to a company (or changes the person's role in it). A login may belong to a few companies, not many. */
  async link(projectId: string, input: unknown, by: string): Promise<CompanyLink> {
    const parsed = CompanyLinkInput.safeParse(input);
    if (!parsed.success) throw new CompanyLinkError('invalid', `The link was not valid: ${parsed.error.issues[0]?.path.join('.') || 'value'}: ${parsed.error.issues[0]?.message ?? 'check the fields'}.`);
    await this.ensureIndex();
    const all = await this.list(projectId);
    const already = all.some((row) => row.email === parsed.data.email && row.companyId === parsed.data.companyId);
    if (!already && all.length >= MAX_LINKS_PER_PROJECT) throw new CompanyLinkError('limit', `A project holds at most ${MAX_LINKS_PER_PROJECT} company links.`);
    if (!already && all.filter((row) => row.email === parsed.data.email).length >= MAX_COMPANIES_PER_LOGIN) throw new CompanyLinkError('limit', `One login may belong to at most ${MAX_COMPANIES_PER_LOGIN} companies.`);
    const row: CompanyLink = { projectId, ...parsed.data, linkedBy: by || 'unknown', linkedAt: this.now().toISOString() };
    await this.collection.updateOne({ projectId, email: row.email, companyId: row.companyId }, { $set: row }, { upsert: true });
    return row;
  }

  /** Removes one link. Returns whether there was one. */
  async unlink(projectId: string, email: unknown, companyId: unknown): Promise<boolean> {
    const parsedEmail = Email.safeParse(email);
    const id = typeof companyId === 'string' ? companyId.trim() : '';
    if (!parsedEmail.success || !id) throw new CompanyLinkError('invalid', 'Say which login and which company to unlink.');
    const filter = { projectId, email: parsedEmail.data, companyId: id };
    const done = this.collection.deleteOne ? await this.collection.deleteOne(filter) : await this.collection.deleteMany?.(filter);
    return (done?.deletedCount ?? 0) > 0;
  }

  /** The companies a login is linked to (for the runtime, with the identity the gateway verified). Nothing when the login is unknown or the address is not one. */
  async lookup(projectId: string, email: unknown): Promise<PersonCompany[]> {
    const parsed = Email.safeParse(email);
    if (!parsed.success) return [];
    const rows: any[] = await this.collection.find({ projectId, email: parsed.data }).toArray();
    return rows.map(strip)
      .sort((a, b) => a.companyId.localeCompare(b.companyId))
      .slice(0, MAX_COMPANIES_PER_LOGIN)
      .map((row) => ({ id: row.companyId, name: row.companyName, role: row.role }));
  }
}
