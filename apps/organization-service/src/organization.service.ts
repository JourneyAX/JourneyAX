import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';
import { Collection, Db } from 'mongodb';
import { Organization, CreateOrgDto, OrgPlan } from './organization.types';

/**
 * OrganizationService
 *
 * Minimal billing & naming container service.
 *
 * Organization owns:
 *   - name, domain, plan, billing info, SSO settings
 *   - list of projectIds (refs only — project-service owns the real config)
 *
 * Organization does NOT own:
 *   - product data (→ project-service + product-service, scoped by projectId)
 *   - member roles (→ project-service, scoped by projectId)
 *   - AI config (→ project-service)
 *   - quotes or knowledge (→ all scoped by projectId in their own services)
 */
@Injectable()
export class OrganizationService {
  private db!: Db;
  private orgsCol!: Collection<Organization>;

  async onModuleInit() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.warn('[OrgService] MONGODB_URI not set.'); return; }

    const { db } = await connectToDatabase(uri, 'journeyax');
    this.db     = db;
    this.orgsCol = db.collection<Organization>('organizations');
    await this.ensureIndexes();
    console.log('[OrgService] Connected. Organizations are billing containers — data lives in Projects.');
  }

  async ensureIndexes() {
    await this.orgsCol.createIndex({ orgId: 1 },  { unique: true });
    await this.orgsCol.createIndex({ domain: 1 }, { unique: true, sparse: true });
    await this.orgsCol.createIndex({ status: 1 });
  }

  private now() { return new Date().toISOString(); }
  private clean<T extends { _id?: any }>(doc: T): T {
    if (doc._id) doc._id = doc._id.toString();
    return doc;
  }
  private generateOrgId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
    return `org-${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async createOrganization(dto: CreateOrgDto): Promise<{ success: boolean; orgId?: string; message?: string }> {
    const existing = await this.orgsCol.findOne({ domain: dto.domain });
    if (existing) return { success: false, message: `Domain '${dto.domain}' already registered.` };

    const orgId = this.generateOrgId(dto.name);
    const now   = this.now();
    const org: Organization = {
      orgId,
      name: dto.name,
      domain: dto.domain,
      status: 'trial',
      plan: (dto.plan || 'starter') as OrgPlan,
      projectIds: [],    // projects are created separately in project-service
      billing: { ...dto.billing, currentPeriodStart: now },
      settings: {
        ssoEnabled: false,
        mfaRequired: false,
        sessionDurationHours: 8,
        allowedDomains: [dto.domain],
      },
      createdAt: now,
      updatedAt: now,
    };

    await this.orgsCol.insertOne(org as any);
    return { success: true, orgId };
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    const doc = await this.orgsCol.findOne({ orgId });
    return doc ? this.clean({ ...doc }) : null;
  }

  async listOrganizations(status?: string): Promise<Organization[]> {
    const filter: any = {};
    if (status) filter.status = status;
    const docs = await this.orgsCol.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    return docs.map(d => this.clean({ ...d }));
  }

  /** Link a newly created project to this org */
  async addProject(orgId: string, projectId: string): Promise<{ success: boolean }> {
    const result = await this.orgsCol.updateOne(
      { orgId },
      { $addToSet: { projectIds: projectId }, $set: { updatedAt: this.now() } }
    );
    return { success: result.matchedCount > 0 };
  }

  /** Unlink a project (does not delete project data — that's project-service's job) */
  async removeProject(orgId: string, projectId: string): Promise<{ success: boolean }> {
    const result = await this.orgsCol.updateOne(
      { orgId },
      { $pull: { projectIds: projectId } as any, $set: { updatedAt: this.now() } }
    );
    return { success: result.matchedCount > 0 };
  }

  async updateStatus(orgId: string, status: string): Promise<{ success: boolean; message?: string }> {
    const allowed = ['active', 'suspended', 'trial', 'inactive'];
    if (!allowed.includes(status)) {
      return { success: false, message: `Invalid status. Allowed: ${allowed.join(', ')}` };
    }
    // Validated above, so this narrowing cast is safe — the typed Mongo update
    // needs the OrgStatus union, not a plain string (this was breaking the build).
    const result = await this.orgsCol.updateOne(
      { orgId },
      { $set: { status: status as Organization['status'], updatedAt: this.now() } }
    );
    return { success: result.matchedCount > 0 };
  }

  async updateSettings(orgId: string, settings: Partial<Organization['settings']>): Promise<{ success: boolean }> {
    const update: any = { updatedAt: this.now() };
    for (const [k, v] of Object.entries(settings)) update[`settings.${k}`] = v;
    const result = await this.orgsCol.updateOne({ orgId }, { $set: update });
    return { success: result.matchedCount > 0 };
  }
}
