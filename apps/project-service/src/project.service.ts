import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { connectToDatabase } from '@journeyax/database';
import { Db, Collection } from 'mongodb';
import {
  ProjectConfig, CreateProjectDto, UpdateProjectDto,
  ProjectIsolationContext, ProjectStatus, ProjectMember, MemberRole,
  BusinessRule, CreateBusinessRuleDto, UpdateBusinessRuleDto, RuleStatus,
  ConfigVersion, CardTemplateDoc, CardSpec,
  ProjectTeam, MembershipStatus, MembershipAuditLog,
} from './project.types';
import { primitives, CARD_TYPE_NAMES, DEFAULT_TEMPLATES, type CardType } from '@journeyax/ui-cards';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  compileGraphToJourneyDefinition,
} from '@journeyax/business-pack';

const DB_NAME   = 'journeyax';
const PROJECTS  = 'tenant_configs';    // existing collection — backwards compat
const MEMBERS   = 'project_members';
const TEAMS     = 'project_teams';
const RULES     = 'business_rules';    // back-office configurable agent rules
const VERSIONS  = 'config_versions';   // immutable published config snapshots (FR-CONFIG-002)

import { STANDARD_TOOL_SCHEMAS, PLATFORM_TOOL_CONTRACTS, CapabilityRegistryService } from './capability-registry.service';
export { STANDARD_TOOL_SCHEMAS, PLATFORM_TOOL_CONTRACTS };

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
  private teamsCol!: Collection<ProjectTeam & { projectId: string; orgId: string }>;
  private rulesCol!: Collection<BusinessRule>;
  private versionsCol!: Collection<ConfigVersion>;
  private isConnected = false;
  private readonly capabilityService = new CapabilityRegistryService();

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
        journeyDefinition: {
          journeyId: 'caroma_bathroom_design',
          version: '1.0.0',
          displayName: 'Caroma Bathroom Design',
          description: 'Guided bathroom design and product selection',
          goals: ['understand_space', 'select_fixtures'],
          initialStage: 'discovery',
          stages: {
            discovery: {
              stageId: 'discovery',
              displayName: 'Space Discovery',
              description: 'Discover bathroom layout and style preferences',
              requiredFacts: [],
              allowedCapabilities: ['catalog_search'],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [{ nextStage: 'specification' }],
            },
            specification: {
              stageId: 'specification',
              displayName: 'Product Specification',
              description: 'Recommend fixtures and finalize specifications',
              requiredFacts: [],
              allowedCapabilities: ['catalog_search', 'quote_create', 'order_commit'],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [],
            },
          },
        },
      },
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.4,
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
        journeyDefinition: {
          journeyId: 'caroma_nz_bathroom_design',
          version: '1.0.0',
          displayName: 'Caroma NZ Bathroom Design',
          description: 'Guided bathroom design for New Zealand',
          goals: ['understand_space', 'select_fixtures'],
          initialStage: 'discovery',
          stages: {
            discovery: {
              stageId: 'discovery',
              displayName: 'Discovery',
              description: 'Discover bathroom space and NZ requirements',
              requiredFacts: [],
              allowedCapabilities: ['catalog_search'],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [{ nextStage: 'specification' }],
            },
            specification: {
              stageId: 'specification',
              displayName: 'Specification',
              description: 'Recommend fixtures with NZ GST pricing',
              requiredFacts: [],
              allowedCapabilities: ['catalog_search', 'quote_create', 'order_commit'],
              nextDecisionPolicy: 'dependency-first',
              exitConditions: [],
            },
          },
        },
      },
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.4,
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
      this.teamsCol    = db.collection(TEAMS);
      this.rulesCol    = db.collection<BusinessRule>(RULES);
      this.versionsCol = db.collection<ConfigVersion>(VERSIONS);
      this.isConnected = true;
      await this.ensureIndexes();
      
      // Do not seed local mock data into remote/QA/Prod clusters
      if (!uri.includes('mongodb.net')) {
        await this.seedProjects();
        await this.seedRules();
        console.log('[ProjectService] Seeded local mock data.');
      } else {
        console.log('[ProjectService] Connected to remote cluster — skipping local seeds.');
      }
      
      console.log('[ProjectService] Connected — indexes ready. Primary isolation key: projectId');
    } catch (err: any) {
      console.warn('[ProjectService] MongoDB unavailable:', err.message);
    }
  }

  setDbForTesting(db: any): void {
    this.db          = db;
    this.projectsCol = db.collection(PROJECTS);
    this.membersCol  = db.collection(MEMBERS);
    this.teamsCol    = db.collection(TEAMS);
    this.rulesCol    = db.collection(RULES);
    this.versionsCol = db.collection(VERSIONS);
    this.isConnected = true;
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
    await this.membersCol.createIndex({ invitationToken: 1 }, { sparse: true });

    // ── Teams collection ────────────────────────────────────────
    await this.teamsCol.createIndex({ projectId: 1, teamId: 1 }, { unique: true });
    await this.teamsCol.createIndex({ projectId: 1 });

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
      status: 'published',
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
      status: 'published',
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
      status: 'published',
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

  /**
   * Active rules only — this is what the agent loads each turn.
   * Only 'published' rules are honoured. Rules with no `status` field (pre-existing,
   * pre-publish-gate data) are treated as published for backward compatibility —
   * zero-migration-risk fallback, see docs on the publish gate.
   */
  async getActiveRules(projectId: string): Promise<BusinessRule[]> {
    if (!this.isConnected) return [];
    return this.rulesCol
      .find(
        {
          projectId,
          isActive: true,
          $or: [{ status: 'published' }, { status: { $exists: false } }],
        },
        { projection: { _id: 0 } },
      )
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
      status: dto.status ?? 'draft',
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

  /** Publish gate: flips a rule to 'published' so getActiveRules (and thus the agent) honours it. */
  async publishRule(projectId: string, ruleId: string): Promise<{ success: boolean; message?: string; rule?: BusinessRule }> {
    if (!this.isConnected) return { success: false, message: 'Database unavailable.' };
    const now = new Date();
    const res = await this.rulesCol.findOneAndUpdate(
      { ruleId, projectId },
      { $set: { status: 'published' as RuleStatus, updatedAt: now } },
      { returnDocument: 'after', projection: { _id: 0 } },
    );
    if (!res) return { success: false, message: `Rule '${ruleId}' not found.` };
    return { success: true, rule: res as unknown as BusinessRule };
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
        return null; // DB connected but project not found, do not fall back to seeds
      } catch (err: any) {
        console.error('[ProjectService] DB Error fetching project:', err.message);
        return null;
      }
    }

    // Fallback to seeds only if no DB connection
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
     *  Read once when integrations or notifications are being written. */
    const current: any = ((dto as any).integrations || (dto as any).notifications)
      ? await this.projectsCol!.findOne({ projectId: pid })
      : null;

    // Reject raw secrets in DTO (enforce tenant-scoped refs only)
    try {
      assertNoRawSecrets(dto);
    } catch (err: any) {
      return { success: false, message: err.message };
    }

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
    if ((dto as any).notifications) {
      const incomingNotif: any = { ...(dto as any).notifications };
      const existingNotif: any = current?.notifications;
      if (incomingNotif.channels && typeof incomingNotif.channels === 'object') {
        const channels: any = { ...incomingNotif.channels };
        if (channels.email && typeof channels.email === 'object') {
          const email: any = { ...channels.email };
          const existingEmail: any = existingNotif?.channels?.email || {};
          // Strip raw apiKey, persist tenant-scoped ref only
          delete email.apiKey;
          email.apiKeyRef = email.apiKeyRef || existingEmail.apiKeyRef || `vault://tenants/${pid}/sendgrid-api-key`;
          delete email.apiKeyHint;
          delete email.apiKeyConfigured;
          channels.email = email;
        }
        if (channels.webhook && typeof channels.webhook === 'object') {
          const webhook: any = { ...channels.webhook };
          const existingWebhook: any = existingNotif?.channels?.webhook || {};
          // Strip raw secret, persist tenant-scoped ref only
          delete webhook.secret;
          webhook.secretRef = webhook.secretRef || existingWebhook.secretRef || `vault://tenants/${pid}/webhook-secret`;
          delete webhook.secretHint;
          delete webhook.secretConfigured;
          channels.webhook = webhook;
        }
        incomingNotif.channels = channels;
      }
      $set.notifications = incomingNotif;
    }
    if ((dto as any).embed) $set.embed = (dto as any).embed;
    if ((dto as any).configurator) $set.configurator = (dto as any).configurator;
    // Commerce surface: 'quote' (B2B project quote — BOM, finishes) vs 'cart'
    // (B2C retail — bag, sizes, checkout). Declared per brand, never inferred, so
    // a retail tenant never inherits the fixtures/quote template. Default 'quote'.
    if ((dto as any).commerceMode) $set.commerceMode = (dto as any).commerceMode;
    // Storefront opening-screen copy (starters + input placeholder) — set per
    // tenant so the example is vertical-true, not a hardcoded generic one.
    if ((dto as any).intro) $set.intro = (dto as any).intro;
    // Sample-customer demo fixtures: replaced wholesale (profiles/orders/offers/
    // inventory are one coherent, fictional dataset — never merged piecemeal).
    if ((dto as any).demoCustomers !== undefined) $set.demoCustomers = (dto as any).demoCustomers;
    // Product-matching config lists (hand-offs, purchase limits, storage guide):
    // replaced wholesale, like intro/demoCustomers.
    for (const k of ['handoffs', 'purchaseLimits', 'storageGuide', 'scenarios']) {
      if ((dto as any)[k] !== undefined) $set[k] = (dto as any)[k];
    }
    // Card CMS (v3): tokens + per-card settings, and fulfilment, are coherent
    // units — replaced wholesale like `business`. cardTemplates arrives already
    // validated + stamped by the controller (see validateCardTemplates).
    if (dto.uiTheme && typeof dto.uiTheme === 'object') $set.uiTheme = dto.uiTheme;
    if (dto.fulfilment && typeof dto.fulfilment === 'object') $set.fulfilment = dto.fulfilment;
    if (dto.cardTemplates && typeof dto.cardTemplates === 'object') $set.cardTemplates = dto.cardTemplates;
    for (const [k, v] of Object.entries((dto as any).labels || {})) $set[`labels.${k}`] = v;
    if (typeof dto.quoteIntro === 'string') $set.quoteIntro = dto.quoteIntro;
    if (typeof dto.complianceBadge === 'string') $set.complianceBadge = dto.complianceBadge;

    for (const k of [
      'journeys', 'modelPolicy', 'agents', 'rules', 'evaluations',
      'experience', 'vocabulary', 'entities', 'conversationPolicy',
      'stageBindings', 'toolDefinitions', 'toolBindings', 'dataResidency',
    ]) {
      if ((dto as any)[k] !== undefined) $set[k] = (dto as any)[k];
    }

    // Deep-merge sub-documents (only update provided keys)
    for (const [k, v] of Object.entries(dto.scope    || {})) $set[`scope.${k}`]    = v;
    for (const [k, v] of Object.entries(dto.pricing  || {})) $set[`pricing.${k}`]  = v;
    for (const [k, v] of Object.entries(dto.persona  || {})) $set[`persona.${k}`]  = v;
    for (const [k, v] of Object.entries(dto.theme    || {})) $set[`theme.${k}`]    = v;
    for (const [k, v] of Object.entries(dto.channels || {})) $set[`channels.${k}`] = v;
    for (const [k, v] of Object.entries((dto as any).ai || {})) {
      // Secret guard: never persist raw apiKey. Only store non-secret AI configurations.
      if (k === 'apiKey' || k === 'apiKeyHint' || k === 'apiKeyConfigured') continue;
      $set[`ai.${k}`] = v;
    }

    // Integrations: strip all raw secret fields so only tenant-scoped connectionRef or secretRef are persisted
    for (const [k, v] of Object.entries((dto as any).integrations || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const incoming: any = { ...(v as any) };
        for (const f of SECRET_FIELDS) {
          delete incoming[f];
          delete incoming[`${f}Hint`];
          delete incoming[`${f}Configured`];
        }
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

  // ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ─────────────────────
  // Layer 3 of the tenant theme: one json-render spec per card type, stored on
  // the DRAFT at `cardTemplates[cardType]` and published with the rest of the
  // config. A tenant override replaces the platform default wholesale; removing
  // it falls back to DEFAULT_TEMPLATES. Specs are validated against the
  // primitive catalog before they are stored so a broken template never reaches
  // the storefront renderer.

  /** Every card type with the spec the DRAFT currently resolves to. */
  async listCardTemplates(projectId: string): Promise<{
    cards: Array<{
      cardType: CardType;
      source: 'tenant' | 'default';
      spec: CardSpec;
      settings: unknown | null;
      updatedAt?: string;
      updatedBy?: string;
      note?: string;
    }>;
  } | null> {
    const project = await this.getProject(projectId);
    if (!project) return null;
    const overrides = project.cardTemplates || {};
    const cards = CARD_TYPE_NAMES.map((cardType) => {
      const doc = overrides[cardType];
      const settings = project.uiTheme?.cards?.[cardType] ?? null;
      if (doc && doc.spec) {
        return {
          cardType, source: 'tenant' as const, spec: doc.spec, settings,
          updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, note: doc.note,
        };
      }
      return { cardType, source: 'default' as const, spec: DEFAULT_TEMPLATES[cardType], settings };
    });
    return { cards };
  }

  /** Upsert a tenant override on the draft; bumps `version` like updateProject. */
  async upsertCardTemplate(
    projectId: string,
    cardType: CardType,
    doc: CardTemplateDoc,
  ): Promise<{ success: boolean; message?: string; cardTemplate?: CardTemplateDoc }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const result = await this.projectsCol.updateOne(
      { projectId: pid },
      { $set: { [`cardTemplates.${cardType}`]: doc, updatedAt: doc.updatedAt }, $inc: { version: 1 } },
    );
    if (result.matchedCount === 0) return { success: false, message: `Project '${pid}' not found.` };
    this.bust(pid);
    return { success: true, cardTemplate: doc };
  }

  /** Remove a tenant override (back to the platform default); bumps `version`. */
  async removeCardTemplate(
    projectId: string,
    cardType: CardType,
  ): Promise<{ success: boolean; message?: string; removed?: boolean }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const existing = await this.projectsCol.findOne({ projectId: pid }, { projection: { [`cardTemplates.${cardType}`]: 1 } });
    if (!existing) return { success: false, message: `Project '${pid}' not found.` };
    const had = Boolean((existing as any).cardTemplates?.[cardType]);
    if (had) {
      await this.projectsCol.updateOne(
        { projectId: pid },
        { $unset: { [`cardTemplates.${cardType}`]: '' }, $set: { updatedAt: new Date().toISOString() }, $inc: { version: 1 } },
      );
      this.bust(pid);
    }
    return { success: true, removed: had };
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

    // Evaluation Gate (EVAL-001): ensure journey graph has valid entrypoint & compile
    let compiledJourney: any = null;
    const journeyGraph = doc.persona?.journeyGraph;
    if (journeyGraph && Array.isArray(journeyGraph.nodes) && journeyGraph.nodes.length > 0) {
      const hasTrigger = journeyGraph.nodes.some((n: any) => n.data?.kind?.startsWith('trigger.'));
      if (!hasTrigger) {
        return {
          success: false,
          message: 'Publish blocked by evaluation gate: Journey graph must contain at least one Trigger node.',
        };
      }

      const compileRes = compileGraphToJourneyDefinition(
        journeyGraph.nodes,
        journeyGraph.edges || [],
        {
          journeyId: pid,
          displayName: doc.companyName || pid,
        }
      );

      if (!compileRes.success) {
        return {
          success: false,
          message: `Publish blocked by evaluation gate: Journey graph compilation failed: ${(compileRes.errors || []).join('; ')}`,
        };
      }
      compiledJourney = compileRes.journeyDefinition;
    }

    if ((doc as any).evaluationGate?.required && (doc as any).evaluationGate?.passed === false) {
      return {
        success: false,
        message: 'Publish blocked by evaluation gate: Required regression evaluation suite has not passed.',
      };
    }

    const last = await this.versionsCol
      .find({ projectId: pid }).sort({ version: -1 }).limit(1).toArray();
    const version = (last[0]?.version ?? 0) + 1;

    // ── Assemble and publish Immutable Business Pack release into business_pack_releases ──
    const journeyList = compiledJourney
      ? [compiledJourney]
      : Array.isArray(doc.journeys) && doc.journeys.length > 0
      ? doc.journeys
      : doc.persona?.journeyDefinition
      ? (Array.isArray(doc.persona.journeyDefinition) ? doc.persona.journeyDefinition : [doc.persona.journeyDefinition])
      : [];

    if (journeyList.length === 0) {
      return {
        success: false,
        message: 'Publish blocked: Project must define at least one valid journey or compile a journey graph.',
      };
    }

    const industry = doc.business?.type || 'general';
    const dimensions = (doc.contextDimensions || []).map((d: any) => ({
      name: d.key || d.name,
      required: Boolean(d.scoping),
      promptOnMissing: d.question || `What ${d.label || d.key} are you looking for?`,
      allowedValues: d.values || [],
    }));

    // Compile Model Policy strictly from doc.modelPolicy or doc.ai (fail-closed, no hardcoded OpenAI/Anthropic fallback)
    let compiledModelPolicy: any = null;
    if (doc.modelPolicy?.policies && Array.isArray(doc.modelPolicy.policies) && doc.modelPolicy.policies.length > 0) {
      compiledModelPolicy = {
        version: doc.modelPolicy.version || '1.0.0',
        defaultPolicy: doc.modelPolicy.defaultPolicy || doc.modelPolicy.policies[0].policyId,
        policies: doc.modelPolicy.policies,
      };
    } else if (doc.ai?.model) {
      const rawProvider = (doc.ai.provider || 'openai').toLowerCase();
      const provider = rawProvider === 'gemini'
        ? 'google'
        : rawProvider === 'ollama'
        ? 'open-model'
        : ['openai', 'anthropic', 'google', 'open-model', 'custom'].includes(rawProvider)
        ? rawProvider
        : 'custom';

      const candidates = [
        {
          provider: provider as any,
          model: doc.ai.model,
          priority: 1,
          temperature: typeof doc.ai.temperature === 'number' ? doc.ai.temperature : undefined,
        },
      ];

      compiledModelPolicy = {
        version: '1.0.0',
        defaultPolicy: 'standard_turn',
        policies: [
          {
            policyId: 'standard_turn',
            candidates,
            dataResidency: (doc as any).dataResidency || 'au',
            maxInputTokens: 20000,
            maxOutputTokens: doc.ai.maxTokens || 2000,
            fallbackAllowed: false,
            timeoutMs: 10000,
          },
        ],
      };
    }

    if (!compiledModelPolicy) {
      return {
        success: false,
        message: 'Publish blocked: Project must define AI model policy or AI model configuration.',
      };
    }

    // Compile Specialist Agents directly from project document fields
    const compiledAgents = Array.isArray(doc.agents) && doc.agents.length > 0
      ? doc.agents
      : [
          {
            agentId: `${pid}_primary_assistant`,
            name: doc.persona?.systemName || doc.name || 'Assistant',
            purpose: doc.persona?.journeyGuidance || 'Primary conversational agent',
            description: doc.persona?.systemName || 'Primary conversational agent',
            modelPolicyRef: compiledModelPolicy.defaultPolicy,
            systemPromptTemplate: doc.persona?.systemPromptOverrides || 'Assist customer with product discovery.',
            allowedTools: Array.isArray(doc.capabilities) ? doc.capabilities : [],
            maxTurns: 5,
            handoffConditions: [],
          },
        ];

    if (Array.isArray((doc as any).specialistAgents)) {
      for (const sa of (doc as any).specialistAgents) {
        if (!sa.agentId || !sa.name) {
          return {
            success: false,
            message: 'Publish blocked: Specialist agent missing required agentId or name.',
          };
        }
        if (!compiledAgents.some((a: any) => a.agentId === sa.agentId)) {
          compiledAgents.push(sa);
        }
      }
    }

    const declaredAgentIds = new Set(compiledAgents.map((a: any) => a.agentId));
    for (const j of journeyList) {
      if (j.stages && typeof j.stages === 'object') {
        for (const [sId, stage] of Object.entries<any>(j.stages)) {
          if (stage.specialistAgentId && !declaredAgentIds.has(stage.specialistAgentId)) {
            return {
              success: false,
              message: `Publish blocked: Stage '${sId}' references undeclared specialist agent '${stage.specialistAgentId}'.`,
            };
          }
        }
      }
    }

    // Compile Stage-Scoped Tools and Capabilities directly from project document fields
    let compiledCapabilities: any = {
      version: '1.0.0',
      toolDefinitions: [],
      toolBindings: [],
      stageBindings: [],
    };

    if (doc.capabilities && typeof doc.capabilities === 'object' && !Array.isArray(doc.capabilities)) {
      const caps = doc.capabilities as any;
      compiledCapabilities = {
        version: caps.version || '1.0.0',
        toolDefinitions: caps.toolDefinitions || [],
        toolBindings: caps.toolBindings || [],
        stageBindings: caps.stageBindings || [],
      };
    } else {
      const stageTools = new Set<string>();
      for (const j of journeyList) {
        if (j.stages && typeof j.stages === 'object') {
          for (const stage of Object.values<any>(j.stages)) {
            if (Array.isArray(stage.allowedCapabilities)) {
              for (const t of stage.allowedCapabilities) stageTools.add(t);
            }
          }
        }
      }

      const toolNames: string[] = Array.from(new Set([
        ...(Array.isArray(doc.capabilities) ? doc.capabilities : []),
        ...(Array.isArray((doc as any).tools) ? (doc as any).tools : []),
        ...Array.from(stageTools),
      ]));

      const stageBindings: any[] = [];
      for (const j of journeyList) {
        if (j.stages && typeof j.stages === 'object') {
          for (const [sId, stage] of Object.entries<any>(j.stages)) {
            const allowed = Array.isArray(stage.allowedCapabilities) && stage.allowedCapabilities.length > 0
              ? stage.allowedCapabilities
              : toolNames;
            if (allowed && allowed.length > 0) {
              stageBindings.push({
                journeyId: j.journeyId,
                stageId: sId,
                tools: allowed.map((t: string) => ({ toolId: t })),
              });
            }
          }
        }
      }

      compiledCapabilities = {
        version: '1.0.0',
        toolDefinitions: ((doc as any).toolDefinitions || toolNames.map((toolId: string) => {
          const std = STANDARD_TOOL_SCHEMAS[toolId] || {
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            sideEffect: (['order_commit', 'quote_create', 'orderCommit', 'createQuote'].includes(toolId) ? 'transactional' : 'read') as any,
            risk: (['order_commit', 'quote_create'].includes(toolId) ? 'high' : 'low') as any,
            requiresApproval: ['order_commit', 'orderCommit'].includes(toolId),
            idempotencyRequired: ['order_commit', 'orderCommit'].includes(toolId),
          };
          return {
            toolId,
            version: '1.0.0',
            displayName: toolId,
            description: `Capability ${toolId}`,
            inputSchema: std.inputSchema,
            outputSchema: std.outputSchema,
            sideEffect: std.sideEffect,
            risk: std.risk,
            timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
            idempotencyPolicy: { required: std.idempotencyRequired, ttlSeconds: 86400 },
            approvalPolicy: { requiresApproval: std.requiresApproval, ttlMinutes: 60 },
            dataClassification: 'internal' as const,
          };
        })),
        toolBindings: ((doc as any).toolBindings || toolNames.map((toolId: string) => {
          const std = STANDARD_TOOL_SCHEMAS[toolId];
          return {
            tenantId: pid,
            environmentId: 'production' as const,
            toolId,
            bindingVersion: '1.0.0',
            executor: {
              type: 'native_capability' as const,
              nativeHandler: toolId,
            },
            enabled: true,
            policy: {
              requiredRole: 'customer',
              requiresConfirmation: std ? std.requiresApproval : ['order_commit', 'orderCommit'].includes(toolId),
              idempotencyRequired: std ? std.idempotencyRequired : ['order_commit', 'orderCommit'].includes(toolId),
              timeoutMs: 10000,
              retryAttempts: 0,
            },
          };
        })),
        stageBindings: (doc as any).stageBindings || stageBindings,
      };
    }

    const declaredToolIds = new Set(compiledCapabilities.toolDefinitions.map((t: any) => t.toolId));
    for (const j of journeyList) {
      if (j.stages && typeof j.stages === 'object') {
        for (const [sId, stage] of Object.entries<any>(j.stages)) {
          if (Array.isArray(stage.allowedCapabilities)) {
            for (const toolId of stage.allowedCapabilities) {
              if (!declaredToolIds.has(toolId)) {
                return {
                  success: false,
                  message: `Publish blocked: Stage '${sId}' references undeclared tool '${toolId}'. Tool must be declared in project capabilities or toolDefinitions.`,
                };
              }
            }
          }
        }
      }
    }

    // Compile Rules directly from project document fields
    const compiledRules = Array.isArray(doc.rules) ? doc.rules : [];

    // Compile Experience (Cards & Themes) directly from project document fields
    const themeFromDoc = (doc.uiTheme as any)?.theme || doc.theme;
    const tokens = doc.uiTheme?.tokens;
    const allowedCardTypes = doc.experience?.cards?.allowedCardTypes
      || (doc.cardTemplates ? Object.keys(doc.cardTemplates) : undefined)
      || [
        'bundle',
        'products',
        'productDetail',
        'quote',
        'comparison',
        'plan',
        'cart',
        'orderStatus',
        'guide',
      ];

    const compiledExperience = {
      version: '1.0.0',
      theme: {
        primaryColor: tokens?.colors?.brand || themeFromDoc?.primaryColor || '#0F172A',
        accentColor: tokens?.colors?.accent || themeFromDoc?.accentColor || '#3B82F6',
        fontFamily: tokens?.font?.body || tokens?.font?.display || themeFromDoc?.fontFamily || 'Inter, sans-serif',
        borderRadius: tokens?.radius?.md || themeFromDoc?.borderRadius || '8px',
        customCssVars: (doc.uiTheme as any)?.theme?.customCssVars || {},
      },
      cards: {
        allowedCardTypes,
        defaultCardRenderer: doc.experience?.cards?.defaultCardRenderer || '@journeyax/ui-cards',
        ...(doc.cardTemplates ? { templates: doc.cardTemplates } : {}),
      },
    };

    // Compile Evaluations directly from project document fields
    const compiledEvaluations = Array.isArray(doc.evaluations) && doc.evaluations.length > 0
      ? doc.evaluations
      : Array.isArray((doc as any).scenarios) && (doc as any).scenarios.length > 0
      ? [
          {
            suiteId: `${pid}_acceptance_suite`,
            name: `${doc.companyName || pid} Acceptance Suite`,
            tenantId: pid,
            version: '1.0.0',
            blockingOnPublish: false,
            scenarios: (doc as any).scenarios.map((s: any, idx: number) => ({
              scenarioId: s.id || `scenario_${idx + 1}`,
              name: s.id || `Scenario ${idx + 1}`,
              description: s.say,
              prompt: s.say,
              expectedTargetStage: s.stage,
              assertions: [],
              timeoutMs: 15000,
            })),
          },
        ]
      : [];

    const defaultEntities = doc.business?.entityModel
      ? [
          {
            entityId: doc.business.entityModel.key,
            displayName: doc.business.entityModel.label,
            description: doc.business.entityModel.labelPlural || doc.business.entityModel.label,
            attributes: (doc.business.entityModel.captureFields || []).map((f: any) => ({
              name: f.key,
              type: 'string' as const,
              required: Boolean(f.required),
            })),
          },
        ]
      : [
          {
            entityId: 'customer_context',
            displayName: 'Customer Context',
            description: 'Customer context and preferences',
            attributes: [
              { name: 'budget', type: 'number' as const, required: false },
              { name: 'timeline', type: 'string' as const, required: false },
            ],
          },
        ];

    const packData = {
      manifest: {
        packId: `pack_${pid}`,
        tenantId: pid,
        name: doc.companyName || doc.name || pid,
        version: `1.0.${version}`,
        description: `${industry} Business Pack`,
        schemaVersion: '1.0.0',
        environmentId: 'production',
        author: opts.publishedBy || 'studio',
      },
      profile: {
        companyName: doc.companyName || doc.name || pid,
        industry,
        primaryGoals: doc.scope?.categories || ['customer_service'],
        locales: ['en-AU', 'en-US'],
      },
      vocabulary: {
        version: '1.0.0',
        dimensions: dimensions.length > 0 ? dimensions : (doc.vocabulary?.dimensions || []),
        terms: doc.vocabulary?.terms || [],
        acronyms: doc.vocabulary?.acronyms || {},
        slotSynonyms: doc.vocabulary?.slotSynonyms || {},
        slotMappings: doc.vocabulary?.slotMappings || {},
        prohibitedTerms: doc.vocabulary?.prohibitedTerms || [],
      },
      entities: doc.entities || {
        version: '1.0.0',
        entities: defaultEntities,
      },
      conversationPolicy: doc.conversationPolicy || {
        fencingRules: [],
        prohibitedTopics: [],
        escalationThresholds: {
          sentimentFloor: -0.6,
          maxTurnsWithoutProgress: 4,
        },
      },
      modelPolicy: compiledModelPolicy,
      agents: compiledAgents,
      journeys: journeyList,
      rules: compiledRules,
      capabilities: compiledCapabilities,
      experience: compiledExperience,
      evaluations: compiledEvaluations,
    };

    // Validate Business Pack reference integrity fail-closed
    let availableSecrets: string[] = [];
    try {
      const secretDocs = await this.db.collection('tenant_secrets').find({ tenantId: pid }).toArray();
      availableSecrets = secretDocs.map((s: any) => s.secretRef || s.secretKey || s.key || s.name || s.id).filter(Boolean);
    } catch {
      availableSecrets = [];
    }

    const integrity = this.capabilityService.validateBusinessPackReferenceIntegrity(packData as any, {
      availableSecrets,
    });
    if (!integrity.valid) {
      return {
        success: false,
        message: `Publish blocked by reference integrity: ${integrity.errors.join('; ')}`,
      };
    }

    const snapshot = this.clean(doc);
    // The snapshot itself records which published version it is.
    (snapshot as any).activeVersion = version;
    if (compiledJourney) {
      (snapshot as any).persona = {
        ...snapshot.persona,
        journeyDefinition: compiledJourney,
      };
    }
    // ONE timestamp for all writes
    const now = new Date().toISOString();

    const updateFields: any = {
      activeVersion: version,
      status: 'active' as ProjectStatus,
      updatedAt: now,
    };
    if (compiledJourney) {
      updateFields['persona.journeyDefinition'] = compiledJourney;
    }

    const client = (this.db as any).client;
    const isProduction = process.env.NODE_ENV === 'production';

    const executeTransactionalPublish = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      // 1. Publish Business Pack release & update pointer inside the transaction
      await publishBusinessPack(this.db, packData, {
        publishedBy: opts.publishedBy,
        notes: opts.note,
        session,
      });

      // 2. Insert immutable snapshot into config_versions inside the transaction
      await this.versionsCol.insertOne({
        projectId: pid,
        version,
        config: snapshot,
        publishedAt: now,
        publishedBy: opts.publishedBy,
        note: opts.note,
      }, sessionOpts);

      // 3. Update project activeVersion and status inside the transaction
      await this.projectsCol.updateOne(
        { projectId: pid },
        { $set: updateFields },
        sessionOpts
      );
    };

    try {
      if (isProduction) {
        if (!client || typeof client.startSession !== 'function') {
          throw new Error('MongoDB client session required for transactional studio publication in production');
        }
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            await executeTransactionalPublish(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        if (client && typeof client.startSession === 'function') {
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              await executeTransactionalPublish(session);
            });
          } catch {
            await executeTransactionalPublish();
          } finally {
            await session.endSession();
          }
        } else {
          await executeTransactionalPublish();
        }
      }
    } catch (publishErr: any) {
      return {
        success: false,
        message: `Publish blocked: ${publishErr.message}`,
      };
    }

    this.bust(pid);
    return { success: true, version };
  }

  /**
   * The config the RUNTIME consumes: the active published snapshot.
   * In production, fails closed: never falls back to uncommitted/draft records.
   */
  async getPublishedConfig(projectId: string): Promise<(ProjectConfig & { published?: boolean }) | null> {
    const pid = projectId.toLowerCase();
    const draft = await this.getProject(pid);
    if (!draft) return null;
    const active = (draft as any).activeVersion;

    if (!active || !this.isConnected) {
      if (process.env.NODE_ENV === 'production') {
        return null;
      }
      return { ...draft, published: false };
    }

    try {
      const snap = await this.versionsCol.findOne({ projectId: pid, version: active });
      if (snap) return { ...snap.config, published: true };
    } catch {}

    if (process.env.NODE_ENV === 'production') {
      return null;
    }
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

  /** Point the runtime at an older published snapshot. Append-only — nothing is deleted.
   *  Coordinates Business Pack pointer and Studio project activeVersion in a single transaction. */
  async rollbackConfig(
    projectId: string,
    version: number,
    rolledBackBy?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const snap = await this.versionsCol.findOne({ projectId: pid, version });
    if (!snap) return { success: false, message: `Version ${version} not found for '${pid}'.` };

    const targetPackVersion = `1.0.${version}`;
    const client = (this.db as any).client;
    const isProduction = process.env.NODE_ENV === 'production';
    const now = new Date().toISOString();

    const executeTransactionalRollback = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      // 1. Rollback Business Pack pointer atomically
      await rollbackBusinessPack(this.db, pid, 'production', {
        targetVersion: targetPackVersion,
        rolledBackBy: rolledBackBy || 'studio',
        reason: `Studio rollback to version ${version}`,
        session,
      });

      // 2. Rollback Studio project activeVersion atomically
      await this.projectsCol.updateOne(
        { projectId: pid },
        { $set: { activeVersion: version, updatedAt: now } },
        sessionOpts
      );
    };

    try {
      if (isProduction) {
        if (!client || typeof client.startSession !== 'function') {
          throw new Error('MongoDB client session required for transactional studio rollback in production');
        }
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            await executeTransactionalRollback(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        if (client && typeof client.startSession === 'function') {
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              await executeTransactionalRollback(session);
            });
          } catch {
            await executeTransactionalRollback();
          } finally {
            await session.endSession();
          }
        } else {
          await executeTransactionalRollback();
        }
      }
    } catch (rbErr: any) {
      return {
        success: false,
        message: `Rollback failed: ${rbErr.message}`,
      };
    }

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

  // ── Member & Team Management (project-scoped lifecycle) ───────

  async inviteMember(
    projectId: string,
    orgId: string,
    email: string,
    fullName: string,
    role: MemberRole,
    invitedBy = 'system',
    options?: {
      teams?: string[];
      responsibilities?: string[];
      workflowOwnership?: string[];
      autoActivate?: boolean;
    }
  ): Promise<{ success: boolean; message?: string; invitationToken?: string; expiresAt?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();

    const exists = await this.membersCol.findOne({ projectId: pid, email: cleanEmail });
    const now = new Date().toISOString();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const isAutoActive = Boolean(options?.autoActivate);

    if (exists) {
      if (exists.status === 'revoked') {
        await this.membersCol.updateOne(
          { projectId: pid, email: cleanEmail },
          {
            $set: {
              role,
              fullName,
              status: isAutoActive ? 'active' : 'pending',
              isActive: isAutoActive,
              invitationToken: isAutoActive ? undefined : token,
              invitationExpiresAt: isAutoActive ? undefined : expiresAt,
              invitedAt: now,
              teams: options?.teams || exists.teams || [],
              responsibilities: options?.responsibilities || exists.responsibilities || [],
              workflowOwnership: options?.workflowOwnership || exists.workflowOwnership || [],
            },
            $push: {
              auditTrail: {
                action: 'invited',
                performedBy: invitedBy,
                timestamp: now,
                note: 'Re-invited revoked member',
                details: { role, teams: options?.teams },
              },
            } as any,
          }
        );
        return { success: true, invitationToken: isAutoActive ? undefined : token, expiresAt };
      }
      return { success: false, message: `'${cleanEmail}' is already a member of project '${pid}'.` };
    }

    const newMember: ProjectMember & { projectId: string; orgId: string } = {
      projectId: pid,
      orgId,
      email: cleanEmail,
      fullName,
      role,
      status: isAutoActive ? 'active' : 'pending',
      isActive: isAutoActive,
      invitationToken: isAutoActive ? undefined : token,
      invitationExpiresAt: isAutoActive ? undefined : expiresAt,
      invitedAt: now,
      teams: options?.teams || [],
      responsibilities: options?.responsibilities || [],
      workflowOwnership: options?.workflowOwnership || [],
      auditTrail: [
        {
          action: 'invited',
          performedBy: invitedBy,
          timestamp: now,
          details: { role, teams: options?.teams },
        },
      ],
    };

    await this.membersCol.insertOne(newMember as any);
    return { success: true, invitationToken: isAutoActive ? undefined : token, expiresAt };
  }

  async addMember(
    projectId: string,
    orgId: string,
    email: string,
    fullName: string,
    role: MemberRole,
    options?: {
      teams?: string[];
      responsibilities?: string[];
      workflowOwnership?: string[];
      autoActivate?: boolean;
    }
  ): Promise<{ success: boolean; message?: string; invitationToken?: string }> {
    return this.inviteMember(projectId, orgId, email, fullName, role, 'system', {
      ...options,
      autoActivate: options?.autoActivate ?? true,
    });
  }

  async acceptInvitation(
    projectId: string,
    email: string,
    token: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();

    const member = await this.membersCol.findOne({
      projectId: pid,
      email: cleanEmail,
    });

    if (!member) {
      return { success: false, message: `No pending invitation found for '${cleanEmail}'.` };
    }

    if (member.status === 'active') {
      return { success: true, message: 'Member is already active.' };
    }

    if (!member.invitationToken || member.invitationToken !== token) {
      return { success: false, message: 'Invalid invitation token.' };
    }

    if (member.invitationExpiresAt && new Date(member.invitationExpiresAt) < new Date()) {
      await this.membersCol.updateOne(
        { projectId: pid, email: cleanEmail },
        { $set: { status: 'expired' } }
      );
      return { success: false, message: 'Invitation has expired.' };
    }

    const now = new Date().toISOString();
    await this.membersCol.updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: {
          status: 'active',
          isActive: true,
          acceptedAt: now,
        },
        $unset: {
          invitationToken: '',
          invitationExpiresAt: '',
        },
        $push: {
          auditTrail: {
            action: 'accepted',
            performedBy: cleanEmail,
            timestamp: now,
          },
        } as any,
      }
    );

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
    isActive?: boolean,
    performedBy = 'system',
    extras?: { teams?: string[]; responsibilities?: string[]; workflowOwnership?: string[] }
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();
    const now = new Date().toISOString();

    const update: any = { role };
    if (isActive !== undefined) {
      update.isActive = isActive;
      update.status = isActive ? 'active' : 'revoked';
    }
    if (extras?.teams) update.teams = extras.teams;
    if (extras?.responsibilities) update.responsibilities = extras.responsibilities;
    if (extras?.workflowOwnership) update.workflowOwnership = extras.workflowOwnership;

    const result = await this.membersCol.updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: update,
        $push: {
          auditTrail: {
            action: 'role_changed',
            performedBy,
            timestamp: now,
            details: { newRole: role, isActive, ...extras },
          },
        } as any,
      }
    );

    if (result.matchedCount === 0) {
      return { success: false, message: `Member '${cleanEmail}' not found in project '${projectId}'.` };
    }
    return { success: true };
  }

  async removeMember(
    projectId: string,
    email: string,
    revokedBy = 'system',
    note?: string
  ): Promise<{ success: boolean }> {
    if (!this.isConnected) return { success: false };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();
    const now = new Date().toISOString();

    // Soft revocation: preserve member record and audit trail
    const result = await this.membersCol.updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: {
          status: 'revoked',
          isActive: false,
          revokedAt: now,
          revokedBy,
        },
        $push: {
          auditTrail: {
            action: 'revoked',
            performedBy: revokedBy,
            timestamp: now,
            note: note || 'Membership revoked',
          },
        } as any,
      }
    );

    return { success: result.matchedCount > 0 };
  }

  async verifyMembership(
    email: string,
    projectId: string
  ): Promise<{ isMember: boolean; role?: MemberRole; orgId?: string; status?: MembershipStatus }> {
    if (!this.isConnected) return { isMember: false };
    const cleanEmail = email.toLowerCase().trim();
    const member = await this.membersCol.findOne({
      email: cleanEmail,
      projectId: projectId.toLowerCase(),
      isActive: true,
    });
    if (!member || member.status === 'revoked' || member.status === 'expired') {
      return { isMember: false };
    }
    return { isMember: true, role: member.role, orgId: member.orgId, status: member.status || 'active' };
  }

  async addTeam(
    projectId: string,
    orgId: string,
    team: { teamId?: string; name: string; description?: string; workflowOwnership?: string[]; escalationContact?: string }
  ): Promise<{ success: boolean; team: ProjectTeam }> {
    if (!this.isConnected) throw new Error('Database not available.');
    const pid = projectId.toLowerCase();
    const teamId = (team.teamId || `team_${team.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`).slice(0, 40);
    const doc: ProjectTeam & { projectId: string; orgId: string } = {
      projectId: pid,
      orgId,
      teamId,
      name: team.name,
      description: team.description,
      workflowOwnership: team.workflowOwnership || [],
      escalationContact: team.escalationContact,
      createdAt: new Date().toISOString(),
    };
    await this.teamsCol.updateOne(
      { projectId: pid, teamId },
      { $set: doc },
      { upsert: true }
    );
    return { success: true, team: doc };
  }

  async listTeams(projectId: string): Promise<ProjectTeam[]> {
    if (!this.isConnected) return [];
    const pid = projectId.toLowerCase();
    const teams = await this.teamsCol.find({ projectId: pid }).toArray();
    return teams.map(({ _id, ...t }: any) => t);
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
// ── Card template validation (v3 Card CMS) ─────────────────────────────────
// Structural checks a template must pass before it is stored: it is a
// json-render flat spec whose every element uses a catalog primitive and whose
// every child / root reference resolves. Prop-level (zod) validation is the
// renderer's job at runtime; this guards the shape the renderer relies on.

export const PRIMITIVE_NAMES: ReadonlySet<string> = new Set(Object.keys(primitives));

export function isCardType(x: unknown): x is CardType {
  return typeof x === 'string' && (CARD_TYPE_NAMES as string[]).includes(x);
}

/** Returns an empty list when `spec` is valid, else every problem found. */
export function validateCardSpec(spec: unknown): string[] {
  const problems: string[] = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['spec must be an object of shape { root: string, elements: { [key]: { type, props, children? } } }'];
  }
  const { root, elements } = spec as { root?: unknown; elements?: unknown };
  if (typeof root !== 'string' || !root.trim()) problems.push('spec.root must be a non-empty string');
  if (!elements || typeof elements !== 'object' || Array.isArray(elements)) {
    problems.push('spec.elements must be an object keyed by element id');
    return problems;
  }
  const els = elements as Record<string, any>;
  const keys = Object.keys(els);
  if (keys.length === 0) problems.push('spec.elements is empty');
  if (typeof root === 'string' && root.trim() && !(root in els)) {
    problems.push(`spec.root '${root}' does not exist in spec.elements`);
  }
  for (const key of keys) {
    const el = els[key];
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      problems.push(`elements.${key} must be an object`);
      continue;
    }
    if (typeof el.type !== 'string' || !PRIMITIVE_NAMES.has(el.type)) {
      problems.push(`elements.${key}.type '${String(el.type)}' is not a catalog primitive (allowed: ${[...PRIMITIVE_NAMES].join(', ')})`);
    }
    if (el.props !== undefined && (typeof el.props !== 'object' || el.props === null || Array.isArray(el.props))) {
      problems.push(`elements.${key}.props must be an object when present`);
    }
    if (el.children !== undefined) {
      if (!Array.isArray(el.children)) {
        problems.push(`elements.${key}.children must be an array of element keys`);
      } else {
        for (const child of el.children) {
          if (typeof child !== 'string') problems.push(`elements.${key}.children contains a non-string entry`);
          else if (!(child in els)) problems.push(`elements.${key}.children references missing element '${child}'`);
        }
      }
    }
    if (el.slots !== undefined) {
      if (!el.slots || typeof el.slots !== 'object' || Array.isArray(el.slots)) {
        problems.push(`elements.${key}.slots must be an object of slotName → element keys`);
      } else {
        for (const [slot, list] of Object.entries(el.slots as Record<string, unknown>)) {
          if (!Array.isArray(list)) { problems.push(`elements.${key}.slots.${slot} must be an array of element keys`); continue; }
          for (const child of list) {
            if (typeof child !== 'string') problems.push(`elements.${key}.slots.${slot} contains a non-string entry`);
            else if (!(child in els)) problems.push(`elements.${key}.slots.${slot} references missing element '${child}'`);
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Validate a whole `cardTemplates` map (PATCH path) and return it normalised —
 * every entry stamped with cardType + updatedAt. Throws nothing; the caller
 * turns `problems` into a 400.
 */
export function validateCardTemplates(
  input: unknown,
  updatedBy?: string,
): { problems: string[]; templates: Record<string, CardTemplateDoc> } {
  const problems: string[] = [];
  const templates: Record<string, CardTemplateDoc> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { problems: ['cardTemplates must be an object keyed by cardType'], templates };
  }
  const now = new Date().toISOString();
  for (const [key, raw] of Object.entries(input as Record<string, any>)) {
    if (!isCardType(key)) { problems.push(`cardTemplates.${key}: unknown cardType (allowed: ${CARD_TYPE_NAMES.join(', ')})`); continue; }
    const spec = raw && typeof raw === 'object' ? raw.spec : undefined;
    const specProblems = validateCardSpec(spec);
    if (specProblems.length) { problems.push(...specProblems.map((p) => `cardTemplates.${key}: ${p}`)); continue; }
    templates[key] = {
      cardType: key,
      spec,
      ...(typeof raw.variant === 'string' ? { variant: raw.variant } : {}),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
      ...(typeof raw.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : updatedBy ? { updatedBy } : {}),
    };
  }
  return { problems, templates };
}

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

  // 3. Notification credentials (SendGrid apiKey, webhook secret)
  const notif = (config as any).notifications;
  if (notif && typeof notif === 'object' && notif.channels) {
    out = { ...out, notifications: { ...notif, channels: { ...notif.channels } } };
    if (notif.channels.email && typeof notif.channels.email === 'object') {
      const email = { ...notif.channels.email };
      if (email.apiKey) {
        email.apiKeyHint = maskHint(email.apiKey);
        email.apiKeyConfigured = true;
        email.apiKeyRef = email.apiKeyRef || `vault://tenants/${(config as any).projectId}/sendgrid-api-key`;
        delete email.apiKey;
      }
      out.notifications.channels.email = email;
    }
    if (notif.channels.webhook && typeof notif.channels.webhook === 'object') {
      const webhook = { ...notif.channels.webhook };
      if (webhook.secret) {
        webhook.secretHint = maskHint(webhook.secret);
        webhook.secretConfigured = true;
        webhook.secretRef = webhook.secretRef || `vault://tenants/${(config as any).projectId}/webhook-secret`;
        delete webhook.secret;
      }
      out.notifications.channels.webhook = webhook;
    }
  }

  return out;
}

/**
 * Asserts that a project creation/update payload contains no raw credentials.
 * Strictly enforces tenant-scoped secret/connection references.
 */
export function assertNoRawSecrets(dto: any): void {
  if (!dto || typeof dto !== 'object') return;

  // 1. Notification credentials
  if (dto.notifications?.channels?.email?.apiKey) {
    const val = String(dto.notifications.channels.email.apiKey).trim();
    if (val && !val.startsWith('••••')) {
      throw new Error('Raw notification apiKey is forbidden; accept tenant-scoped refs only');
    }
  }
  if (dto.notifications?.channels?.webhook?.secret) {
    const val = String(dto.notifications.channels.webhook.secret).trim();
    if (val && !val.startsWith('••••')) {
      throw new Error('Raw notification webhook secret is forbidden; accept tenant-scoped refs only');
    }
  }

  // 2. AI provider credentials
  if (dto.ai?.apiKey) {
    const val = String(dto.ai.apiKey).trim();
    if (val && !val.startsWith('••••')) {
      throw new Error('Raw AI apiKey is forbidden; accept tenant-scoped refs only');
    }
  }

  // 3. Connector credentials
  if (dto.integrations && typeof dto.integrations === 'object') {
    for (const [platform, cfg] of Object.entries(dto.integrations as Record<string, any>)) {
      if (cfg && typeof cfg === 'object') {
        for (const f of SECRET_FIELDS) {
          if (f in cfg && cfg[f]) {
            const val = String(cfg[f]).trim();
            if (val && !val.startsWith('••••')) {
              throw new Error(
                `Raw connector credential '${f}' in '${platform}' is forbidden; accept tenant-scoped refs only`
              );
            }
          }
        }
      }
    }
  }
}
