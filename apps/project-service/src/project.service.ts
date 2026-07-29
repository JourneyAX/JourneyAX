import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';
import { Db, Collection } from 'mongodb';
import {
  ProjectConfig, CreateProjectDto, UpdateProjectDto,
  ProjectIsolationContext, ProjectStatus, ProjectMember, MemberRole,
  BusinessRule, CreateBusinessRuleDto, UpdateBusinessRuleDto,
  ConfigVersion,
} from './project.types';

const DB_NAME   = 'journeyax';
const PROJECTS  = 'tenant_configs';    // existing collection — backwards compat
const MEMBERS   = 'project_members';
const RULES     = 'business_rules';    // back-office configurable agent rules
const VERSIONS  = 'config_versions';   // immutable published config snapshots (FR-CONFIG-002)

/**
 * ProjectService — Config Registry & Data Isolation Authority
 *
 * This is the single source of truth for:
 *   1. What data a project can access (scope, categories, finishes)
 *   2. How to price that data (currency, tax, discount)
 *   3. How the agent behaves (persona, system prompt)
 *   4. Who can access the project (members with roles)
 *
 * THE ISOLATION RULE — enforced here and in every downstream service:
 *   Every MongoDB query MUST include { projectId } in its filter.
 *   getIsolationContext() returns exactly this filter, ready to use.
 *
 * Cache: 5-minute in-memory TTL — project configs rarely change.
 */
@Injectable()
export class ProjectService {
  private db!: Db;
  private projectsCol!: Collection<ProjectConfig>;
  private membersCol!: Collection<ProjectMember & { projectId: string; orgId: string }>;
  private rulesCol!: Collection<BusinessRule>;
  private versionsCol!: Collection<ConfigVersion>;
  private isConnected = false;

  private cache = new Map<string, { config: ProjectConfig; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  // ── Seed data — upserted on startup ──────────────────────────
  private readonly SEEDS: ProjectConfig[] = [
    {
      projectId: 'caroma',
      orgId: 'org-gwa',
      name: 'Caroma Australia',
      companyName: 'Caroma Industries Ltd',
      slug: 'caroma-bathrooms',
      domain: 'caroma.journeyax.com',
      status: 'active',
      scope: {
        rooms: ['Bathroom', 'Ensuite', 'Powder Room', 'Laundry'],
        finishes: ['Chrome', 'Matte Black', 'Brushed Brass', 'Brushed Nickel', 'Gloss White'],
        categories: ['basin', 'toilet', 'tapware', 'shower', 'bath', 'accessories'],
        complianceTags: ['WELS', 'WaterMark', 'AS1428'],
        excludedSkus: [],
      },
      pricing: { currency: 'AUD', symbol: '$', taxRate: 0.10, discountRate: 0.12 },
      persona: {
        systemName: 'Caroma Stylist & Plumber',
        systemPromptOverrides:
          'You are the Caroma Stylist, a bathroom design and plumbing advisor. ' +
          'Ground ALL recommendations exclusively in Caroma product catalog data. ' +
          'Never hallucinate SKUs, prices, or product names.',
        greetingMessage: "Welcome to Caroma! I'll help you design your perfect bathroom.",
        escalationEmail: 'support@caroma.com.au',
      },
      theme: {
        primaryColor: '#FFD600',
        accentColor: '#0A0A0A',
        fontFamily: 'Space Grotesk, sans-serif',
        logoUrl: '/assets/caroma-logo.svg',
        visualizerEnabled: true,
      },
      channels: { web: true, mobile: true, email: true, whatsapp: false, voice: false, kiosk: true, partner: false, csr: true },
      createdAt: '2026-01-10T00:00:00Z',
      updatedAt: '2026-01-10T00:00:00Z',
      version: 1,
    },
    {
      projectId: 'caroma-nz',
      orgId: 'org-gwa',
      name: 'Caroma New Zealand',
      companyName: 'Caroma Industries Ltd',
      slug: 'caroma-nz',
      domain: 'caroma-nz.journeyax.com',
      status: 'draft',
      scope: {
        rooms: ['Bathroom', 'Ensuite', 'Powder Room'],
        finishes: ['Chrome', 'Matte Black', 'Brushed Nickel'],
        categories: ['basin', 'toilet', 'tapware', 'shower'],
        complianceTags: ['WELS'],
        excludedSkus: [],
      },
      pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0.10 },
      persona: {
        systemName: 'Caroma NZ Stylist',
        systemPromptOverrides:
          'You are the Caroma NZ Stylist. Only recommend products available in New Zealand. ' +
          'Apply NZD pricing and 15% GST.',
        greetingMessage: "Kia ora! Let's design your perfect bathroom.",
      },
      theme: {
        primaryColor: '#FFD600',
        accentColor: '#0A0A0A',
        fontFamily: 'Space Grotesk, sans-serif',
        visualizerEnabled: true,
      },
      channels: { web: true, mobile: false, email: true, whatsapp: false, voice: false, kiosk: false, partner: false, csr: false },
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      version: 1,
    },
  ];

  // ── Init ──────────────────────────────────────────────────────
  async onModuleInit() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn('[ProjectService] MONGODB_URI not set — seed config mode only.');
      return;
    }

    try {
      const { db } = await connectToDatabase(uri, DB_NAME);
      this.db          = db;
      this.projectsCol = db.collection<ProjectConfig>(PROJECTS);
      this.membersCol  = db.collection(MEMBERS);
      this.rulesCol    = db.collection<BusinessRule>(RULES);
      this.versionsCol = db.collection<ConfigVersion>(VERSIONS);
      this.isConnected = true;
      await this.ensureIndexes();
      await this.seedProjects();
      await this.seedRules();
      console.log('[ProjectService] Connected — indexes ready. Primary isolation key: projectId');
    } catch (err: any) {
      console.warn('[ProjectService] MongoDB unavailable:', err.message);
    }
  }

  async ensureIndexes() {
    if (!this.isConnected) return;
    // ── Projects collection ─────────────────────────────────────
    await this.projectsCol.createIndex({ projectId: 1 }, { unique: true }); // primary isolation
    await this.projectsCol.createIndex({ orgId: 1 });
    await this.projectsCol.createIndex({ status: 1 });
    await this.projectsCol.createIndex({ slug: 1 }, { sparse: true });

    // ── Members collection ──────────────────────────────────────
    await this.membersCol.createIndex({ projectId: 1, email: 1 }, { unique: true });
    await this.membersCol.createIndex({ projectId: 1 });
    await this.membersCol.createIndex({ email: 1 });

    // ── Business rules collection ───────────────────────────────
    await this.rulesCol.createIndex({ ruleId: 1 }, { unique: true });
    await this.rulesCol.createIndex({ projectId: 1, isActive: 1, priority: 1 });

    // Config versions: one immutable snapshot per (projectId, version)
    await this.versionsCol.createIndex({ projectId: 1, version: 1 }, { unique: true });
  }

  private async seedProjects() {
    for (const seed of this.SEEDS) {
      await this.projectsCol.updateOne(
        { projectId: seed.projectId },
        { $setOnInsert: seed },
        { upsert: true }
      );
    }
  }

  // Default business rules for Caroma — mirrors rules previously hardcoded in the
  // agent prompt, now data the back office owns. Upserted once (won't overwrite edits).
  private readonly SEED_RULES: BusinessRule[] = [
    {
      ruleId: 'caroma-room-scope',
      projectId: 'caroma',
      name: 'Room scope enforcement',
      scope: 'recommendation',
      condition: 'Customer is configuring a Kitchen or Laundry',
      action:
        'Recommend only kitchen/laundry products (sink mixers, kitchen sinks, laundry tubs). Do NOT recommend bathroom-specific products.',
      priority: 10,
      isActive: true,
    },
    {
      ruleId: 'caroma-max-3-questions',
      projectId: 'caroma',
      name: 'Max 3 clarifying questions',
      scope: 'conversation',
      condition: 'During discovery, before presenting a plan',
      action: 'Ask at most 3 clarifying questions, then present a plan even if info is partial.',
      priority: 20,
      isActive: true,
    },
    {
      ruleId: 'caroma-plumber-safety',
      projectId: 'caroma',
      name: 'Licensed plumber for plumbing work',
      scope: 'escalation',
      condition: 'Job involves plumbing, structural or water-supply work',
      action: 'Recommend a licensed plumber and offer to book an appointment before finalising.',
      priority: 30,
      isActive: true,
    },
  ];

  private async seedRules() {
    for (const r of this.SEED_RULES) {
      await this.rulesCol.updateOne(
        { ruleId: r.ruleId },
        { $setOnInsert: { ...r, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
    }
  }

  // ── Business Rules CRUD (back-office configurable) ─────────────
  async listRules(projectId: string): Promise<BusinessRule[]> {
    if (!this.isConnected) return [];
    return this.rulesCol
      .find({ projectId }, { projection: { _id: 0 } })
      .sort({ priority: 1 })
      .toArray();
  }

  /** Active rules only — this is what the agent loads each turn. */
  async getActiveRules(projectId: string): Promise<BusinessRule[]> {
    if (!this.isConnected) return [];
    return this.rulesCol
      .find({ projectId, isActive: true }, { projection: { _id: 0 } })
      .sort({ priority: 1 })
      .toArray();
  }

  async createRule(projectId: string, dto: CreateBusinessRuleDto): Promise<{ success: boolean; ruleId?: string; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database unavailable.' };
    const ruleId = `${projectId}-${dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const rule: BusinessRule = {
      ruleId,
      projectId,
      name: dto.name,
      scope: dto.scope,
      condition: dto.condition,
      action: dto.action,
      priority: dto.priority ?? 100,
      isActive: dto.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.rulesCol.insertOne(rule);
    return { success: true, ruleId };
  }

  async updateRule(projectId: string, ruleId: string, dto: UpdateBusinessRuleDto): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database unavailable.' };
    const res = await this.rulesCol.updateOne(
      { ruleId, projectId },
      { $set: { ...dto, updatedAt: new Date() } },
    );
    if (res.matchedCount === 0) return { success: false, message: `Rule '${ruleId}' not found.` };
    return { success: true };
  }

  async deleteRule(projectId: string, ruleId: string): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database unavailable.' };
    const res = await this.rulesCol.deleteOne({ ruleId, projectId });
    if (res.deletedCount === 0) return { success: false, message: `Rule '${ruleId}' not found.` };
    return { success: true };
  }

  // ── Cache ──────────────────────────────────────────────────────
  private getCached(projectId: string): ProjectConfig | null {
    const entry = this.cache.get(projectId);
    if (entry && Date.now() < entry.expiresAt) return entry.config;
    this.cache.delete(projectId);
    return null;
  }

  private setCached(c: ProjectConfig) {
    this.cache.set(c.projectId, { config: c, expiresAt: Date.now() + this.CACHE_TTL_MS });
  }

  private bust(projectId: string) {
    this.cache.delete(projectId);
  }

  // ── Core: Isolation Context ────────────────────────────────────

  /**
   * THE method every downstream service calls before any DB query.
   *
   * Returns the projectId + exact mongoFilter to scope queries.
   *
   * Usage in agent-service:
   *   const ctx = await projectService.getIsolationContext('caroma');
   *   // ctx.mongoFilter = { projectId: 'caroma' }
   *   // use ctx.mongoFilter in every MongoDB query
   *   const results = await productService.search(query, ctx);
   */
  async getIsolationContext(projectId: string): Promise<ProjectIsolationContext | null> {
    const config = await this.getProject(projectId);
    if (!config) return null;

    return {
      projectId: config.projectId,
      orgId: config.orgId,
      status: config.status,
      mongoFilter: { projectId: config.projectId },  // ← use this in ALL queries
      searchScope: config.scope,
      pricing: config.pricing,
      persona: config.persona,
    };
  }

  // ── Project CRUD ───────────────────────────────────────────────

  async getProject(projectId: string): Promise<ProjectConfig | null> {
    const pid = projectId.toLowerCase();

    const cached = this.getCached(pid);
    if (cached) return cached;

    if (this.isConnected) {
      try {
        const doc = await this.projectsCol.findOne({ projectId: pid });
        if (doc) {
          const c = this.clean(doc);
          this.setCached(c);
          return c;
        }
      } catch {}
    }

    // Fallback to seeds
    return this.SEEDS.find(s => s.projectId === pid) ?? null;
  }

  async listProjects(orgId?: string, status?: ProjectStatus): Promise<ProjectConfig[]> {
    if (!this.isConnected) {
      return this.SEEDS.filter(s =>
        (!orgId || s.orgId === orgId) &&
        (!status || s.status === status)
      );
    }

    const filter: any = {};
    if (orgId)  filter.orgId  = orgId;
    if (status) filter.status = status;

    const docs = await this.projectsCol.find(filter).sort({ createdAt: -1 }).toArray();
    return docs.map(d => this.clean(d));
  }

  async createProject(dto: CreateProjectDto): Promise<{ success: boolean; projectId?: string; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };

    const pid = dto.projectId.toLowerCase();
    const exists = await this.projectsCol.findOne({ projectId: pid });
    if (exists) {
      return { success: false, message: `Project '${pid}' already exists.` };
    }

    const now = new Date().toISOString();
    const config: ProjectConfig = {
      projectId: pid,
      orgId: dto.orgId,
      name: dto.name,
      companyName: dto.companyName,
      slug: dto.slug,
      domain: dto.domain,
      status: 'draft',
      scope: dto.scope,
      pricing: dto.pricing,
      persona: dto.persona,
      theme: dto.theme,
      channels: {
        web: true, email: true, mobile: false,
        whatsapp: false, voice: false, kiosk: false,
        partner: false, csr: false,
        ...(dto.channels || {}),
      },
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.4,
        embeddingModel: 'text-embedding-3-small',
        ...((dto as any).ai || {}),
      },
      integrations: (dto as any).integrations || {},
      // Onboarding can seed knowledge sources from the customer's own site, so a
      // new tenant is ready to ingest rather than starting empty. Optional —
      // omitted when the operator supplies none.
      ...((dto as any).knowledgeSource ? { knowledgeSource: (dto as any).knowledgeSource } : {}),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    await this.projectsCol.insertOne(config as any);
    this.bust(pid);
    return { success: true, projectId: pid };
  }

  /**
   * Resolve the tenant that owns a given WhatsApp phone number id. Used by the
   * WhatsApp webhook to route inbound messages (one webhook, many tenants) and to
   * fetch that tenant's send token. Internal service-to-service only.
   */
  async resolveByWhatsapp(phoneNumberId: string): Promise<
    { projectId: string; tenantId: string; accessToken?: string; verifyToken?: string } | null
  > {
    if (!this.isConnected) return null;
    const doc = await this.projectsCol.findOne({ 'integrations.whatsapp.phoneNumberId': phoneNumberId });
    if (!doc) return null;
    const wa = (doc as any).integrations?.whatsapp || {};
    return { projectId: doc.projectId, tenantId: doc.projectId, accessToken: wa.accessToken, verifyToken: wa.verifyToken };
  }

  /**
   * Resolve which project serves a storefront DOMAIN (multi-storefront routing).
   * Matches ProjectConfig.domain case-insensitively, ignoring port and www.
   */
  async resolveByDomain(domain: string): Promise<{ projectId: string } | null> {
    const d = domain.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (!d) return null;
    if (this.isConnected) {
      try {
        const doc = await this.projectsCol.findOne({
          domain: { $regex: `^(www\\.)?${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        });
        if (doc) return { projectId: doc.projectId };
      } catch {}
    }
    const seed = this.SEEDS.find((s) => s.domain?.toLowerCase().replace(/^www\./, '') === d);
    return seed ? { projectId: seed.projectId } : null;
  }

  async updateProject(
    projectId: string,
    dto: UpdateProjectDto
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };

    const pid = projectId.toLowerCase();
    const $set: any = { updatedAt: new Date().toISOString() };

    /* The stored project, needed to preserve secrets an edit did not resend.
     *  Read once and only when integrations are being written. */
    const current: any = (dto as any).integrations
      ? await this.projectsCol!.findOne({ projectId: pid })
      : null;

    // Top-level fields
    if (dto.name)        $set.name        = dto.name;
    if (dto.companyName) $set.companyName = dto.companyName;
    if (dto.formerNames) $set.formerNames = dto.formerNames;
    if (dto.domain)      $set.domain      = dto.domain;
    if (dto.status)      $set.status      = dto.status;
    if (Array.isArray((dto as any).capabilities)) $set.capabilities = (dto as any).capabilities;
    if (Array.isArray((dto as any).contextDimensions)) $set.contextDimensions = (dto as any).contextDimensions;
    if ((dto as any).console) $set.console = (dto as any).console;
    if ((dto as any).knowledgeSource) $set.knowledgeSource = (dto as any).knowledgeSource;
    // Business layer (BusinessPort): what kind of business this is and who its
    // customers buy for. Replaced wholesale, not merged — the entity model is a
    // coherent unit and a half-merged one would describe a business that isn't real.
    if ((dto as any).business) $set.business = (dto as any).business;
    if ((dto as any).notifications) $set.notifications = (dto as any).notifications;
    if ((dto as any).embed) $set.embed = (dto as any).embed;
    if ((dto as any).configurator) $set.configurator = (dto as any).configurator;
    // Storefront opening-screen copy (starters + input placeholder) — set per
    // tenant so the example is vertical-true, not a hardcoded generic one.
    if ((dto as any).intro) $set.intro = (dto as any).intro;
    for (const [k, v] of Object.entries((dto as any).labels || {})) $set[`labels.${k}`] = v;

    // Deep-merge sub-documents (only update provided keys)
    for (const [k, v] of Object.entries(dto.scope    || {})) $set[`scope.${k}`]    = v;
    for (const [k, v] of Object.entries(dto.pricing  || {})) $set[`pricing.${k}`]  = v;
    for (const [k, v] of Object.entries(dto.persona  || {})) $set[`persona.${k}`]  = v;
    for (const [k, v] of Object.entries(dto.theme    || {})) $set[`theme.${k}`]    = v;
    for (const [k, v] of Object.entries(dto.channels || {})) $set[`channels.${k}`] = v;
    for (const [k, v] of Object.entries((dto as any).ai || {})) {
      // Secret guard: never persist an empty or masked apiKey (the UI echoes the
      // masked hint when unchanged). Only overwrite when a real new key is typed.
      if (k === 'apiKey') {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s || s.startsWith('••••')) continue;
      }
      // These are read-only derived fields returned by redaction — never store them.
      if (k === 'apiKeyHint' || k === 'apiKeyConfigured') continue;
      $set[`ai.${k}`] = v;
    }
    /* integrations merge one level deep: each connector's full config object is
     * replaced. That makes a connector's SECRETS vulnerable to an ordinary edit.
     *
     * Reads are redacted (P0-01), so a UI that loads a project, edits one field
     * and saves sends the connector back with its secret missing or blanked —
     * `clientSecret: ct0.clientSecret || ""` in the integrations editor. The
     * replace then writes the empty value over a working credential. Nothing
     * errors; the tenant silently falls back to the platform key, which for
     * Stripe means payments settling to the wrong account.
     *
     * So an absent or masked secret means "unchanged", never "delete" — the same
     * rule already applied to ai.apiKey above, extended to every connector. */
    for (const [k, v] of Object.entries((dto as any).integrations || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const incoming: any = { ...(v as any) };
        const existing: any = (current as any)?.integrations?.[k] || {};
        for (const f of SECRET_FIELDS) {
          if (!(f in incoming)) continue;
          const val = incoming[f];
          const blank = typeof val !== 'string' || !val.trim() || val.startsWith('••••');
          // Keep what is stored rather than overwrite it with a blank or a mask.
          if (blank) {
            if (existing[f]) incoming[f] = existing[f];
            else delete incoming[f];
          }
        }
        // Derived read-only fields from redaction must never be persisted.
        for (const f of SECRET_FIELDS) { delete incoming[`${f}Hint`]; delete incoming[`${f}Configured`]; }
        $set[`integrations.${k}`] = incoming;
      } else {
        $set[`integrations.${k}`] = v;
      }
    }

    const result = await this.projectsCol.updateOne(
      { projectId: pid },
      { $set, $inc: { version: 1 } }
    );

    if (result.matchedCount === 0) {
      return { success: false, message: `Project '${pid}' not found.` };
    }

    this.bust(pid);
    return { success: true };
  }

  // ── Config versioning (FR-CONFIG-002: draft → publish → rollback) ──────────
  // The project doc is the mutable DRAFT. publishConfig() snapshots it into an
  // immutable ConfigVersion and points activeVersion at it; the runtime consumes
  // getPublishedConfig(), never the draft. rollbackConfig() re-points activeVersion
  // at an older snapshot — history is append-only, so the version list IS the audit.

  async publishConfig(
    projectId: string,
    opts: { note?: string; publishedBy?: string } = {},
  ): Promise<{ success: boolean; version?: number; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();

    const doc = await this.projectsCol.findOne({ projectId: pid });
    if (!doc) return { success: false, message: `Project '${pid}' not found.` };

    const last = await this.versionsCol
      .find({ projectId: pid }).sort({ version: -1 }).limit(1).toArray();
    const version = (last[0]?.version ?? 0) + 1;

    const snapshot = this.clean(doc);
    // The snapshot itself records which published version it is.
    (snapshot as any).activeVersion = version;
    // ONE timestamp for both writes — otherwise the draft's updatedAt lands a few ms
    // after publishedAt and the console shows "unpublished changes" right after publishing.
    const now = new Date().toISOString();
    await this.versionsCol.insertOne({
      projectId: pid,
      version,
      config: snapshot,
      publishedAt: now,
      publishedBy: opts.publishedBy,
      note: opts.note,
    });

    await this.projectsCol.updateOne(
      { projectId: pid },
      { $set: { activeVersion: version, status: 'active' as ProjectStatus, updatedAt: now } },
    );
    this.bust(pid);
    return { success: true, version };
  }

  /**
   * The config the RUNTIME consumes: the active published snapshot.
   * Falls back to the live draft when the project has never been published
   * (back-compat: existing projects keep working before their first publish).
   */
  async getPublishedConfig(projectId: string): Promise<(ProjectConfig & { published?: boolean }) | null> {
    const pid = projectId.toLowerCase();
    const draft = await this.getProject(pid);
    if (!draft) return null;
    const active = (draft as any).activeVersion;
    if (!active || !this.isConnected) return { ...draft, published: false };
    try {
      const snap = await this.versionsCol.findOne({ projectId: pid, version: active });
      if (snap) return { ...snap.config, published: true };
    } catch {}
    return { ...draft, published: false };
  }

  /** Version history (metadata only — the audit trail). */
  async listVersions(projectId: string): Promise<Array<Omit<ConfigVersion, 'config'> & { active: boolean }>> {
    if (!this.isConnected) return [];
    const pid = projectId.toLowerCase();
    const draft = await this.getProject(pid);
    const active = (draft as any)?.activeVersion;
    const versions = await this.versionsCol
      .find({ projectId: pid }, { projection: { config: 0, _id: 0 } })
      .sort({ version: -1 }).limit(50).toArray();
    return versions.map((v: any) => ({ ...v, active: v.version === active }));
  }

  /** Point the runtime at an older published snapshot. Append-only — nothing is deleted. */
  async rollbackConfig(projectId: string, version: number): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const snap = await this.versionsCol.findOne({ projectId: pid, version });
    if (!snap) return { success: false, message: `Version ${version} not found for '${pid}'.` };
    await this.projectsCol.updateOne(
      { projectId: pid },
      { $set: { activeVersion: version, updatedAt: new Date().toISOString() } },
    );
    this.bust(pid);
    return { success: true };
  }

  async publishProject(projectId: string): Promise<{ success: boolean; message?: string }> {
    // Back-compat alias: publishing now snapshots a config version (was: status flip only).
    return this.publishConfig(projectId);
  }

  async archiveProject(projectId: string): Promise<{ success: boolean; message?: string }> {
    return this.updateProject(projectId, { status: 'archived' });
  }

  // ── Member Management (project-scoped) ────────────────────────

  async addMember(
    projectId: string,
    orgId: string,
    email: string,
    fullName: string,
    role: MemberRole
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };

    const pid = projectId.toLowerCase();
    const exists = await this.membersCol.findOne({ projectId: pid, email });
    if (exists) {
      return { success: false, message: `'${email}' is already a member of project '${pid}'.` };
    }

    await this.membersCol.insertOne({
      projectId: pid,
      orgId,
      email,
      fullName,
      role,
      isActive: true,
      invitedAt: new Date().toISOString(),
    } as any);

    return { success: true };
  }

  async listMembers(projectId: string): Promise<any[]> {
    if (!this.isConnected) return [];
    const docs = await this.membersCol
      .find({ projectId: projectId.toLowerCase() })
      .sort({ invitedAt: -1 })
      .toArray();
    return docs.map(({ _id, ...rest }) => rest);
  }

  async updateMemberRole(
    projectId: string,
    email: string,
    role: MemberRole,
    isActive?: boolean
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };

    const update: any = { role };
    if (isActive !== undefined) update.isActive = isActive;

    const result = await this.membersCol.updateOne(
      { projectId: projectId.toLowerCase(), email },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return { success: false, message: `Member '${email}' not found in project '${projectId}'.` };
    }
    return { success: true };
  }

  async removeMember(projectId: string, email: string): Promise<{ success: boolean }> {
    if (!this.isConnected) return { success: false };
    const result = await this.membersCol.deleteOne({
      projectId: projectId.toLowerCase(), email,
    });
    return { success: result.deletedCount > 0 };
  }

  async verifyMembership(
    email: string,
    projectId: string
  ): Promise<{ isMember: boolean; role?: MemberRole; orgId?: string }> {
    if (!this.isConnected) return { isMember: false };
    const member = await this.membersCol.findOne({
      email,
      projectId: projectId.toLowerCase(),
      isActive: true,
    });
    if (!member) return { isMember: false };
    return { isMember: true, role: member.role, orgId: member.orgId };
  }

  // ── Utilities ─────────────────────────────────────────────────

  async listAllProjectIds(): Promise<string[]> {
    if (!this.isConnected) return this.SEEDS.map(s => s.projectId);
    return this.projectsCol.distinct('projectId');
  }

  /** Backwards-compat alias — agent-service calls this today */
  async getTenantConfig(tenantId: string): Promise<ProjectConfig | null> {
    return this.getProject(tenantId);
  }

  private clean(doc: any): ProjectConfig {
    const { _id, ...rest } = doc;
    return rest as ProjectConfig;
  }
}

// ── P0-01: connector-secret redaction ─────────────────────────────────────────
// Integration credentials (CT clientSecret, WhatsApp/Shopify/Woo tokens) must NEVER
// reach the browser or logs. Public/operator reads are redacted; only internal
// runtime services (agent, WhatsApp sender) presenting the internal key get full
// values. This is the interim control until a KMS/secret-ref vault lands.
const SECRET_FIELDS = ['clientSecret', 'accessToken', 'verifyToken', 'consumerSecret', 'secretKey'];

function maskHint(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

/** Return a copy with integration + AI secrets replaced by a masked hint + `configured` flag. */
export function redactSecrets<T extends { integrations?: any; ai?: any }>(config: T): T {
  if (!config) return config;
  let out: any = config;

  // 1. Integration connector secrets (Shopify token, WhatsApp secret, etc.)
  if (config.integrations) {
    out = { ...out, integrations: {} };
    for (const [platform, cfg] of Object.entries(config.integrations as Record<string, any>)) {
      if (!cfg || typeof cfg !== 'object') { out.integrations[platform] = cfg; continue; }
      const redacted: any = { ...cfg };
      for (const f of SECRET_FIELDS) {
        if (f in redacted && redacted[f]) {
          redacted[`${f}Hint`] = maskHint(redacted[f]);
          redacted[`${f}Configured`] = true;
          delete redacted[f];
        }
      }
      out.integrations[platform] = redacted;
    }
  }

  // 2. Per-project LLM API key (ai.apiKey) — same masked-hint contract.
  if (config.ai && typeof config.ai === 'object' && config.ai.apiKey) {
    out = { ...out, ai: { ...config.ai } };
    out.ai.apiKeyHint = maskHint(config.ai.apiKey);
    out.ai.apiKeyConfigured = true;
    delete out.ai.apiKey;
  }

  return out;
}
