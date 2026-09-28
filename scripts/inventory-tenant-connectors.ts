/**
 * Truthful Tenant Connector Migration Inventory & Dry-Run Audit
 *
 * Requirements (Workstream C — Portfolio Governance):
 * 1. Loads the portfolio from config/portfolio-manifest.json (or an explicit
 *    manifest path / inline portfolio supplied by the caller).
 *    No tenant names, industries, residencies, or migration priorities are
 *    hardcoded inside this implementation file.
 * 2. Discovers Business Packs dynamically from packs/ and classifies each as:
 *      ACTIVE_PORTFOLIO  — in activePortfolio list
 *      PARKED            — in parked list (does NOT affect active readiness)
 *      SYNTHETIC_FIXTURE — tenantId ends with _fixture suffix
 * 3. Parked tenants are reported but excluded from active-portfolio readiness
 *    metrics.  They do not count as active blockers.
 * 4. Does not synthesise readiness, parity, cutover, rollback, or immutable-
 *    release evidence.
 * 5. Does not clear a supplied safe TEST_MONGODB_URI; refuses production-like
 *    URIs and operates offline when none is supplied.
 * 6. Queries real non-production releases, active pointers, cutover records,
 *    typed connector mappings, secret mappings, normalisation reports, and
 *    parity/canary evidence when available.
 * 7. Undiscovered ACTIVE_PORTFOLIO tenants must be NOT_DISCOVERED/BLOCKED.
 * 8. Synthetic fixtures must be in a separate test-only section and excluded
 *    from readiness counts.
 * 9. Read-only by default; writes docs/tenant-connector-migration-inventory.md
 *    only with --write.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

if (process.env.JOURNEYAX_OFFLINE_HARNESS !== 'true') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}

import {
  BusinessPackReleaseSchema,
  validateBusinessPack,
  computePackChecksum,
  BusinessPackRelease,
  BusinessPackLoader,
} from '@journeyax/business-pack';
import { CapabilityRegistryService } from '../apps/project-service/src/capability-registry.service';
import { CatalogSearchHandler } from '../apps/journey-runtime-service/src/capabilities/handlers/catalog-search.handler';

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio Manifest types
// ─────────────────────────────────────────────────────────────────────────────

export interface PortfolioTenantEntry {
  tenantId: string;
  displayName: string;
  industry: string;
  commerceMode: 'quote' | 'cart';
  dataResidency: string;
  migrationPriority?: number;
  reason?: string;
  notes?: string;
}

export interface PortfolioManifest {
  version: string;
  description?: string;
  updatedAt?: string;
  activePortfolio: PortfolioTenantEntry[];
  parked: PortfolioTenantEntry[];
  syntheticFixtures?: PortfolioTenantEntry[];
  syntheticFixtureSuffix?: string;
  packsRoot?: string;
}

/** Default manifest path relative to the repo root. */
export const DEFAULT_PORTFOLIO_MANIFEST_PATH = path.resolve(
  __dirname,
  '../config/portfolio-manifest.json'
);

/**
 * Loads and validates the portfolio manifest from a JSON file.
 * Throws if the file is missing or malformed.
 */
export function loadPortfolioManifest(manifestPath = DEFAULT_PORTFOLIO_MANIFEST_PATH): PortfolioManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Portfolio manifest not found at: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as PortfolioManifest;
  if (!Array.isArray(parsed.activePortfolio) || !Array.isArray(parsed.parked)) {
    throw new Error(
      `Portfolio manifest at '${manifestPath}' must have 'activePortfolio' and 'parked' arrays`
    );
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery classification
// ─────────────────────────────────────────────────────────────────────────────

export type PackClassification = 'ACTIVE_PORTFOLIO' | 'PARKED' | 'SYNTHETIC_FIXTURE';

export type ProjectSource = 'filesystem_pack' | 'non_prod_db' | 'not_discovered' | 'synthetic_fixture';

export interface DiscoveredProject {
  tenantId: string;
  name: string;
  source: ProjectSource;
  classification: PackClassification;
  industry: string;
  commerceMode: 'quote' | 'cart';
  externalConnectors: string[];
  activepiecesFlows: {
    toolId: string;
    flowId: string;
    connectionRef: string;
    sideEffect: 'read' | 'write' | 'transactional';
    risk: 'low' | 'medium' | 'high';
  }[];
  model: { provider: string; model: string };
  dataResidency: string;
  packCandidate?: BusinessPackRelease;
}

export interface ComputedAuditResult {
  tenantId: string;
  name: string;
  source: ProjectSource;
  classification: PackClassification;
  industry: string;
  commerceMode: 'quote' | 'cart';
  schemaValid: boolean;
  schemaErrors: string[];
  semanticValid: boolean;
  semanticErrors: string[];
  referenceIntegrityValid: boolean;
  referenceIntegrityErrors: string[];
  groundedRetrievalIsolated: boolean;
  groundedRetrievalEvidence: string;
  connectorBoundaryCompliant: boolean;
  rawSecretsCount: number;
  rawSecretsList: string[];
  directUrlsCount: number;
  directUrlsList: string[];
  checksum: string;
  activepiecesFlowsCount: number;
  connectionRefMappings: string[];
  parityResult: 'VERIFIED' | 'PARTIAL' | 'UNEVALUATED';
  immutableReleaseReadiness: 'READY' | 'NOT_READY';
  cutoverRecordState: 'VERIFIED_ACTIVE' | 'PENDING_APPROVAL' | 'NO_RECORD_FOUND';
  rollbackEvidence: 'BASELINE_CONFIRMED' | 'NO_ROLLBACK_BASELINE';
  blockers: string[];
  migrationStatus: 'CANDIDATE_PACK_VALIDATED' | 'FIXTURE_EVALUATION_ONLY' | 'PARKED' | 'BLOCKED';
}

export interface SafeDatabaseEnvironment {
  uri?: string;
  mode: 'connected' | 'offline_safe' | 'rejected_production';
  warning?: string;
}

export interface DatabaseEvidence {
  connected: boolean;
  releases: Map<string, any>;
  pointers: Map<string, any>;
  cutovers: Map<string, any>;
  connections: Map<string, any[]>;
  secrets: Map<string, number>;
  normalizationReports: Map<string, any>;
  parityEvidence: Map<string, any>;
  discoveredProjects: Set<string>;
}

export function tenantEnvKey(tenantId: string, environmentId: string = 'production'): string {
  return `${tenantId}:${environmentId}`;
}

const FORBIDDEN_PROVIDER_DOMAINS = [
  'api.australia-southeast1.gcp.commercetools.com',
  'auth.australia-southeast1.gcp.commercetools.com',
  'api.stripe.com',
  'api.sendgrid.com',
  'api.shopify.com',
  'api.salesforce.com',
  'api.hubspot.com',
];

const SECRET_KEYS = [
  'clientsecret',
  'accesstoken',
  'secretkey',
  'consumersecret',
  'password',
  'apikey',
];

/**
 * Resolves safe database environment strictly via TEST_MONGODB_URI.
 * Never falls back to MONGODB_URI. Refuses production-like URIs.
 */
export function resolveSafeDatabaseEnvironment(
  env: Record<string, string | undefined> = process.env
): SafeDatabaseEnvironment {
  const rawUri = env.TEST_MONGODB_URI;
  if (!rawUri || !rawUri.trim()) {
    return {
      mode: 'offline_safe',
      warning: 'No TEST_MONGODB_URI supplied. Operating in safe offline mode. (MONGODB_URI fallback prohibited)',
    };
  }

  const trimmed = rawUri.trim();
  const lower = trimmed.toLowerCase();

  const isProdLike =
    lower.includes('prod') ||
    lower.includes('production') ||
    (lower.includes('mongodb.net') &&
      !lower.includes('test') &&
      !lower.includes('dev') &&
      !lower.includes('staging'));

  if (isProdLike) {
    return {
      mode: 'rejected_production',
      warning: 'Production-like MongoDB URI detected — connection refused to enforce non-production safety. Operating offline.',
    };
  }

  return { uri: trimmed, mode: 'connected' };
}

/**
 * Queries real non-production MongoDB collections when a safe URI is available.
 */
export async function queryNonProductionDatabase(uri: string): Promise<DatabaseEvidence> {
  const evidence: DatabaseEvidence = {
    connected: false,
    releases: new Map(),
    pointers: new Map(),
    cutovers: new Map(),
    connections: new Map(),
    secrets: new Map(),
    normalizationReports: new Map(),
    parityEvidence: new Map(),
    discoveredProjects: new Set(),
  };

  let client: MongoClient | null = null;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
    await client.connect();
    evidence.connected = true;
    const db = client.db(process.env.MONGODB_DB_NAME || 'journeyx');

    try {
      const p1 = await db.collection('tenant_configs').find({}).project({ projectId: 1, _id: 0 }).toArray();
      for (const p of p1) if (p.projectId) evidence.discoveredProjects.add(p.projectId);
      const p2 = await db.collection('projects').find({}).project({ projectId: 1, _id: 0 }).toArray();
      for (const p of p2) if (p.projectId) evidence.discoveredProjects.add(p.projectId);
    } catch {}

    const releases = await db
      .collection('business_pack_releases')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, version: -1, createdAt: -1 })
      .toArray();
    for (const r of releases) {
      if (r.tenantId) {
        const key = tenantEnvKey(r.tenantId, r.environmentId || 'production');
        if (!evidence.releases.has(key)) evidence.releases.set(key, r);
      }
    }

    const pointers = await db
      .collection('business_pack_pointers')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, updatedAt: -1 })
      .toArray();
    for (const p of pointers) {
      if (p.tenantId) {
        const key = tenantEnvKey(p.tenantId, p.environmentId || 'production');
        if (!evidence.pointers.has(key)) evidence.pointers.set(key, p);
      }
    }

    const cutovers = await db
      .collection('tenant_cutovers')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, cutoverAt: -1, createdAt: -1 })
      .toArray();
    for (const c of cutovers) {
      if (c.tenantId) {
        const key = tenantEnvKey(c.tenantId, c.environmentId || 'production');
        if (!evidence.cutovers.has(key)) evidence.cutovers.set(key, c);
      }
    }

    const connections = await db
      .collection('tenant_connections')
      .find({})
      .project({ _id: 0, connectionRef: 1, name: 1, pieceName: 1, pieceId: 1, provider: 1, status: 1, enabled: 1, allowedFlows: 1, tenantId: 1, environmentId: 1 })
      .sort({ tenantId: 1, connectionRef: 1 })
      .toArray();
    for (const c of connections) {
      if (c.tenantId) {
        const key = tenantEnvKey(c.tenantId, c.environmentId || 'production');
        const list = evidence.connections.get(key) || [];
        list.push(c);
        evidence.connections.set(key, list);
      }
    }

    const secretCounts = await db
      .collection('tenant_secrets')
      .aggregate([{ $group: { _id: { tenantId: '$tenantId', environmentId: { $ifNull: ['$environmentId', 'production'] } }, count: { $sum: 1 } } }])
      .toArray();
    for (const s of secretCounts) {
      if (s._id?.tenantId) {
        const key = tenantEnvKey(s._id.tenantId, s._id.environmentId || 'production');
        evidence.secrets.set(key, s.count);
      }
    }

    const normReports = await db.collection('normalization_reports').find({}).toArray();
    for (const n of normReports) {
      if (n.tenantId) {
        const key = tenantEnvKey(n.tenantId, n.environmentId || 'production');
        evidence.normalizationReports.set(key, n);
      }
    }

    const parities = await db.collection('parity_evidence').find({}).toArray();
    for (const p of parities) {
      if (p.tenantId) {
        const key = tenantEnvKey(p.tenantId, p.environmentId || 'production');
        evidence.parityEvidence.set(key, p);
      }
    }
  } catch (err: any) {
    console.warn(`[Inventory] Non-production DB query unavailable (${err.message}). Operating in safe offline mode.`);
  } finally {
    if (client) { try { await client.close(); } catch {} }
  }

  return evidence;
}

function scanForRawSecrets(obj: any, currentPath = ''): string[] {
  const found: string[] = [];
  if (!obj || typeof obj !== 'object') return found;
  for (const [k, v] of Object.entries(obj)) {
    const p = currentPath ? `${currentPath}.${k}` : k;
    if (typeof v === 'string') {
      const lowKey = k.toLowerCase();
      if (SECRET_KEYS.includes(lowKey) || (lowKey === 'secret' && !p.toLowerCase().endsWith('secretref'))) {
        const val = v.trim();
        if (val && !val.startsWith('••••') && !val.startsWith('vault://') && !val.startsWith('ref://') && !val.startsWith('env://')) {
          found.push(`${p}: raw value present`);
        }
      }
    } else if (typeof v === 'object') {
      found.push(...scanForRawSecrets(v, p));
    }
  }
  return found;
}

function scanForDirectUrls(obj: any, currentPath = ''): string[] {
  const found: string[] = [];
  if (!obj || typeof obj !== 'object') return found;
  for (const [k, v] of Object.entries(obj)) {
    const p = currentPath ? `${currentPath}.${k}` : k;
    if (typeof v === 'string') {
      for (const domain of FORBIDDEN_PROVIDER_DOMAINS) {
        if (v.includes(domain)) found.push(`${p}: references direct domain '${domain}'`);
      }
    } else if (typeof v === 'object') {
      found.push(...scanForDirectUrls(v, p));
    }
  }
  return found;
}

/**
 * Classifies a tenantId given the portfolio manifest.
 */
export function classifyTenant(
  tenantId: string,
  manifest: PortfolioManifest
): PackClassification {
  const fixtureSuffix = manifest.syntheticFixtureSuffix ?? '_fixture';
  if (tenantId.endsWith(fixtureSuffix)) return 'SYNTHETIC_FIXTURE';
  if (manifest.activePortfolio.some((e) => e.tenantId === tenantId)) return 'ACTIVE_PORTFOLIO';
  if (manifest.parked.some((e) => e.tenantId === tenantId)) return 'PARKED';
  // Unknown tenants discovered from the filesystem are classified PARKED by default
  // (they do not become active blockers without an explicit portfolio entry).
  return 'PARKED';
}

/**
 * Discovers projects from filesystem packs/ and the database, then merges
 * with the active portfolio list to produce not_discovered entries for
 * active tenants that are missing.
 *
 * Metadata (displayName, industry, residency, commerceMode) comes exclusively
 * from the portfolio manifest — never from switch statements or hardcoded maps.
 */
export async function discoverProjects(
  dbEvidence: DatabaseEvidence,
  manifest: PortfolioManifest
): Promise<DiscoveredProject[]> {
  const discovered: DiscoveredProject[] = [];
  const loader = new BusinessPackLoader();
  const fixtureSuffix = manifest.syntheticFixtureSuffix ?? '_fixture';
  const packsRelPath = manifest.packsRoot ?? 'packs';
  const packsDir = path.resolve(__dirname, '..', packsRelPath);

  // 1. Filesystem packs/
  if (fs.existsSync(packsDir)) {
    const entries = fs.readdirSync(packsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tenantDir = path.join(packsDir, entry.name);
      if (!fs.existsSync(path.join(tenantDir, 'manifest.json'))) continue;

      const loaded = await loader.loadFromDisk(entry.name, 'production');
      if (!loaded) continue;

      const tenantId = loaded.manifest.tenantId ?? entry.name;
      const classification = classifyTenant(tenantId, manifest);

      // Resolve display metadata from manifest entry (never hardcoded here)
      const portfolioEntry =
        manifest.activePortfolio.find((e) => e.tenantId === tenantId) ??
        manifest.parked.find((e) => e.tenantId === tenantId);

      const modelCandidate = loaded.modelPolicy?.policies?.[0]?.candidates?.[0];
      const modelSpec = modelCandidate
        ? { provider: modelCandidate.provider, model: modelCandidate.model }
        : { provider: 'custom', model: 'tenant_configured' };

      const externalConnectors: string[] = [];
      if (loaded.capabilities?.toolBindings?.some((b) => b.executor?.type === 'activepieces_flow'))
        externalConnectors.push('Activepieces Flows');
      if (loaded.capabilities?.toolBindings?.some((b) => b.executor?.type === 'native_capability'))
        externalConnectors.push('Native Capabilities');

      discovered.push({
        tenantId,
        name: portfolioEntry?.displayName ?? loaded.profile?.companyName ?? loaded.manifest.name ?? tenantId,
        source: 'filesystem_pack',
        classification,
        industry: portfolioEntry?.industry ?? loaded.profile?.industry ?? 'Commercial Enterprise',
        commerceMode: portfolioEntry?.commerceMode ?? 'quote',
        externalConnectors,
        activepiecesFlows: (loaded.capabilities?.toolBindings || [])
          .filter((b) => b.executor?.type === 'activepieces_flow')
          .map((b) => ({
            toolId: b.toolId,
            flowId: (b.executor as any).flowId,
            connectionRef: (b.executor as any).connectionRef,
            sideEffect: 'write' as const,
            risk: 'medium' as const,
          })),
        model: modelSpec,
        dataResidency: portfolioEntry?.dataResidency ?? (loaded as any).manifest?.dataResidency ?? loaded.modelPolicy?.policies?.[0]?.dataResidency ?? 'au',
        packCandidate: loaded,
      });
    }
  }

  // 2. Real non-production DB releases not already on disk
  for (const [key, releaseDoc] of dbEvidence.releases.entries()) {
    const tenantId = releaseDoc.manifest?.tenantId || releaseDoc.tenantId || key.split(':')[0];
    if (discovered.some((d) => d.tenantId === tenantId)) continue;

    const classification = classifyTenant(tenantId, manifest);
    const portfolioEntry =
      manifest.activePortfolio.find((e) => e.tenantId === tenantId) ??
      manifest.parked.find((e) => e.tenantId === tenantId);

    const modelCandidate = releaseDoc.modelPolicy?.policies?.[0]?.candidates?.[0];
    const modelSpec = modelCandidate
      ? { provider: modelCandidate.provider, model: modelCandidate.model }
      : { provider: 'custom', model: 'tenant_configured' };

    discovered.push({
      tenantId,
      name: portfolioEntry?.displayName ?? releaseDoc.manifest?.name ?? tenantId,
      source: 'non_prod_db',
      classification,
      industry: portfolioEntry?.industry ?? releaseDoc.profile?.industry ?? 'Enterprise',
      commerceMode: portfolioEntry?.commerceMode ?? 'quote',
      externalConnectors: ['Activepieces Flows'],
      activepiecesFlows: (releaseDoc.capabilities?.toolBindings || [])
        .filter((b: any) => b.executor?.type === 'activepieces_flow')
        .map((b: any) => ({ toolId: b.toolId, flowId: b.executor.flowId, connectionRef: b.executor.connectionRef, sideEffect: 'write', risk: 'medium' })),
      model: modelSpec,
      dataResidency: portfolioEntry?.dataResidency ?? (releaseDoc as any).manifest?.dataResidency ?? releaseDoc.modelPolicy?.policies?.[0]?.dataResidency ?? 'au',
      packCandidate: releaseDoc,
    });
  }

  // 3. Active portfolio entries not yet discovered → mark not_discovered
  for (const entry of manifest.activePortfolio) {
    if (!discovered.some((d) => d.tenantId === entry.tenantId)) {
      discovered.push({
        tenantId: entry.tenantId,
        name: entry.displayName,
        source: 'not_discovered',
        classification: 'ACTIVE_PORTFOLIO',
        industry: entry.industry,
        commerceMode: entry.commerceMode,
        externalConnectors: [],
        activepiecesFlows: [],
        model: { provider: 'custom', model: 'tenant_configured' },
        dataResidency: entry.dataResidency,
      });
    }
  }

  // 4. Parked portfolio entries not yet discovered → mark not_discovered (but PARKED)
  for (const entry of manifest.parked) {
    if (!discovered.some((d) => d.tenantId === entry.tenantId)) {
      // Parked tenants that are not on disk get a not_discovered record but are
      // classified PARKED — they do not appear in active readiness metrics.
      discovered.push({
        tenantId: entry.tenantId,
        name: entry.displayName,
        source: 'not_discovered',
        classification: 'PARKED',
        industry: entry.industry,
        commerceMode: entry.commerceMode,
        externalConnectors: [],
        activepiecesFlows: [],
        model: { provider: 'custom', model: 'tenant_configured' },
        dataResidency: entry.dataResidency,
      });
    }
  }

  // 5. Synthetic fixtures declared in portfolio manifest
  for (const fix of manifest.syntheticFixtures || []) {
    discovered.push({
      tenantId: fix.tenantId,
      name: fix.displayName,
      source: 'synthetic_fixture',
      classification: 'SYNTHETIC_FIXTURE',
      industry: fix.industry,
      commerceMode: fix.commerceMode,
      externalConnectors: ['Activepieces Flows'],
      activepiecesFlows: [
        {
          toolId: `${fix.tenantId}.tool`,
          flowId: `ap_flow_${fix.tenantId}`,
          connectionRef: `conn_${fix.tenantId}`,
          sideEffect: 'write',
          risk: 'medium',
        },
      ],
      model: { provider: 'custom', model: 'tenant_configured' },
      dataResidency: fix.dataResidency,
    });
  }

  return discovered;
}

function buildCandidatePack(spec: DiscoveredProject): BusinessPackRelease | null {
  if (spec.source === 'not_discovered') return null;
  if (spec.packCandidate) return spec.packCandidate;

  const pack: BusinessPackRelease = {
    manifest: {
      packId: `pack_${spec.tenantId}`,
      tenantId: spec.tenantId,
      environmentId: 'production',
      version: '1.0.0',
      name: `${spec.name} Business Pack`,
      description: `Candidate Business Pack for ${spec.name}`,
      status: 'active',
      checksum: '',
    },
    profile: {
      companyName: spec.name,
      industry: spec.industry,
      brandTone: 'Professional, Grounded',
      primaryCurrency: 'AUD',
      supportedCurrencies: ['AUD', 'NZD', 'USD'],
      primaryLocale: 'en-AU',
      supportedLocales: ['en-AU', 'en-NZ', 'en-US'],
    },
    vocabulary: {
      version: '1.0.0',
      terms: [],
      acronyms: {},
      slotSynonyms: {},
      slotMappings: {},
      prohibitedTerms: [],
    },
    entities: {
      version: '1.0.0',
      entities: [],
    },
    conversationPolicy: { fencingRules: ['Stay grounded in catalog data'], prohibitedTopics: [], escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 } },
    modelPolicy: {
      version: '1.0.0',
      defaultPolicy: 'p1',
      policies: [{
        policyId: 'p1',
        candidates: [{
          provider: (['custom', 'openai', 'anthropic', 'google', 'open-model'].includes(spec.model.provider)
            ? spec.model.provider
            : 'custom') as 'custom' | 'openai' | 'anthropic' | 'google' | 'open-model',
          model: spec.model.model,
          priority: 1,
        }],
        dataResidency: spec.dataResidency,
        maxInputTokens: 8000,
        maxOutputTokens: 2000,
        fallbackAllowed: false,
        timeoutMs: 15000,
      }],
    },
    agents: [{
      agentId: 'primary_stylist',
      name: `${spec.name} Advisor`,
      purpose: 'Advise customer on products and specifications',
      systemPromptTemplate: 'Ground all answers in authoritative catalog data.',
      modelPolicyRef: 'p1',
      allowedTools: ['catalog.search', 'pricing.validate', 'order.commit', ...spec.activepiecesFlows.map((f) => f.toolId)],
      inputSchema: {},
      outputSchema: {},
      maxTurns: 10,
      handoffConditions: [],
    }],
    journeys: [{
      journeyId: `${spec.tenantId}_journey`,
      version: '1.0.0',
      displayName: `${spec.name} Flow`,
      goals: ['product_discovery'],
      initialStage: 'stage_discovery',
      stages: {
        stage_discovery: { stageId: 'stage_discovery', displayName: 'Discovery', requiredFacts: [], allowedCapabilities: ['catalog.search', 'knowledge.search'], nextDecisionPolicy: 'dependency-first', exitConditions: [{ nextStage: 'stage_checkout' }] },
        stage_checkout: { stageId: 'stage_checkout', displayName: 'Checkout', requiredFacts: ['selected_items'], allowedCapabilities: ['pricing.validate', 'order.commit', ...spec.activepiecesFlows.map((f) => f.toolId)], nextDecisionPolicy: 'dependency-first', exitConditions: [] },
      },
    }],
    capabilities: {
      version: '1.0.0',
      toolDefinitions: [
        { toolId: 'catalog.search', version: '1.0.0', displayName: 'Catalog Search', description: 'Domain-neutral catalog search', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', risk: 'low', timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 }, idempotencyPolicy: { required: false, ttlSeconds: 60 }, approvalPolicy: { requiresApproval: false, ttlMinutes: 10 }, dataClassification: 'public' },
        { toolId: 'pricing.validate', version: '1.0.0', displayName: 'Pricing Validate', description: 'Domain-neutral pricing validation', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'read', risk: 'low', timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 }, idempotencyPolicy: { required: false, ttlSeconds: 60 }, approvalPolicy: { requiresApproval: false, ttlMinutes: 10 }, dataClassification: 'internal' },
        { toolId: 'order.commit', version: '1.0.0', displayName: 'Order Commit', description: 'Durable order commitment', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: 'transactional', risk: 'high', timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 }, idempotencyPolicy: { required: true, ttlSeconds: 3600 }, approvalPolicy: { requiresApproval: true, ttlMinutes: 30 }, dataClassification: 'confidential' },
        ...spec.activepiecesFlows.map((f) => ({ toolId: f.toolId, version: '1.0.0', displayName: f.toolId, description: `Activepieces flow execution for ${f.toolId}`, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffect: f.sideEffect, risk: f.risk, timeoutPolicy: { timeoutMs: 15000, retryAttempts: 1 }, idempotencyPolicy: { required: f.sideEffect !== 'read', ttlSeconds: 300 }, approvalPolicy: { requiresApproval: f.risk === 'high', ttlMinutes: 15 }, dataClassification: 'internal' as const })),
      ],
      toolBindings: [
        { tenantId: spec.tenantId, environmentId: 'production', toolId: 'catalog.search', bindingVersion: '1.0.0', executor: { type: 'native_capability', nativeHandler: 'catalog.search' }, enabled: true, policy: { requiredRole: 'customer', requiresConfirmation: false, idempotencyRequired: false, timeoutMs: 5000, retryAttempts: 0 } },
        { tenantId: spec.tenantId, environmentId: 'production', toolId: 'pricing.validate', bindingVersion: '1.0.0', executor: { type: 'native_capability', nativeHandler: 'pricing.validate' }, enabled: true, policy: { requiredRole: 'customer', requiresConfirmation: false, idempotencyRequired: false, timeoutMs: 5000, retryAttempts: 0 } },
        { tenantId: spec.tenantId, environmentId: 'production', toolId: 'order.commit', bindingVersion: '1.0.0', executor: { type: 'native_capability', nativeHandler: 'order.commit' }, enabled: true, policy: { requiredRole: 'customer', requiresConfirmation: true, idempotencyRequired: true, timeoutMs: 10000, retryAttempts: 0 } },
        ...spec.activepiecesFlows.map((f) => ({ tenantId: spec.tenantId, environmentId: 'production' as const, toolId: f.toolId, bindingVersion: '1.0.0', executor: { type: 'activepieces_flow' as const, flowId: f.flowId, connectionRef: f.connectionRef }, enabled: true, policy: { requiredRole: 'customer', requiresConfirmation: f.risk === 'high', idempotencyRequired: f.sideEffect !== 'read', timeoutMs: 15000, retryAttempts: 1 } })),
      ],
      stageBindings: [
        { journeyId: `${spec.tenantId}_journey`, stageId: 'stage_discovery', tools: [{ toolId: 'catalog.search' }] },
        { journeyId: `${spec.tenantId}_journey`, stageId: 'stage_checkout', tools: [{ toolId: 'pricing.validate' }, { toolId: 'order.commit' }, ...spec.activepiecesFlows.map((f) => ({ toolId: f.toolId }))] },
      ],
    },
    experience: {
      version: '1.0.0',
      theme: { primaryColor: '#0055ff', accentColor: '#ff0055', fontFamily: 'Inter, sans-serif', borderRadius: '8px' },
      cards: { allowedCardTypes: ['products', 'specifications', 'orders'], defaultCardRenderer: 'standard' },
    },
    rules: [],
    evaluations: [],
  };

  pack.manifest.checksum = computePackChecksum(pack);
  return pack;
}

export interface MockProductRecord {
  sku: string;
  projectId: string;
  tenantId: string;
  title: string;
  category: string;
  price: { amount: number; currency: string };
  stock: { inStock: boolean; availableQuantity: number };
}

export async function auditProject(
  project: DiscoveredProject,
  dbEvidence: DatabaseEvidence,
  options: { writeReport?: boolean } = {},
  capabilityRegistry: CapabilityRegistryService = new CapabilityRegistryService()
): Promise<ComputedAuditResult> {
  const blockers: string[] = [];

  // PARKED tenants: report status without triggering active readiness checks.
  // They do not count as blockers for the active portfolio.
  if (project.classification === 'PARKED' && project.source === 'not_discovered') {
    return {
      tenantId: project.tenantId,
      name: project.name,
      source: project.source,
      classification: 'PARKED',
      industry: project.industry,
      commerceMode: project.commerceMode,
      schemaValid: false,
      schemaErrors: ['Parked — not evaluated'],
      semanticValid: false,
      semanticErrors: ['Parked — not evaluated'],
      referenceIntegrityValid: false,
      referenceIntegrityErrors: [],
      groundedRetrievalIsolated: false,
      groundedRetrievalEvidence: 'Parked tenant — isolation not evaluated',
      connectorBoundaryCompliant: false,
      rawSecretsCount: 0,
      rawSecretsList: [],
      directUrlsCount: 0,
      directUrlsList: [],
      checksum: 'NOT_EVALUATED',
      activepiecesFlowsCount: 0,
      connectionRefMappings: [],
      parityResult: 'UNEVALUATED',
      immutableReleaseReadiness: 'NOT_READY',
      cutoverRecordState: 'NO_RECORD_FOUND',
      rollbackEvidence: 'NO_ROLLBACK_BASELINE',
      blockers: ['Parked tenant — not counted in active portfolio readiness'],
      migrationStatus: 'PARKED',
    };
  }

  // ACTIVE_PORTFOLIO or SYNTHETIC_FIXTURE — not_discovered
  if (project.source === 'not_discovered') {
    blockers.push('Required active-portfolio tenant not discovered on filesystem or database');
    blockers.push('Cutover approval record missing in tenant_cutovers');
    blockers.push('Rollback baseline snapshot missing in business_pack_pointers');

    return {
      tenantId: project.tenantId,
      name: project.name,
      source: 'not_discovered',
      classification: project.classification,
      industry: project.industry,
      commerceMode: project.commerceMode,
      schemaValid: false,
      schemaErrors: ['No release manifest discovered to validate'],
      semanticValid: false,
      semanticErrors: ['No business pack candidate available'],
      referenceIntegrityValid: false,
      referenceIntegrityErrors: ['No capability registry references found'],
      groundedRetrievalIsolated: false,
      groundedRetrievalEvidence: 'Tenant not discovered; isolated retrieval not evaluated',
      connectorBoundaryCompliant: false,
      rawSecretsCount: 0,
      rawSecretsList: [],
      directUrlsCount: 0,
      directUrlsList: [],
      checksum: 'NOT_AVAILABLE',
      activepiecesFlowsCount: 0,
      connectionRefMappings: [],
      parityResult: 'UNEVALUATED',
      immutableReleaseReadiness: 'NOT_READY',
      cutoverRecordState: 'NO_RECORD_FOUND',
      rollbackEvidence: 'NO_ROLLBACK_BASELINE',
      blockers,
      migrationStatus: 'BLOCKED',
    };
  }

  // Discovered — perform full audit
  const pack = buildCandidatePack(project)!;

  // Normalize legacy disk pack schema fields
  for (const agent of pack.agents || []) {
    if (!agent.allowedTools) agent.allowedTools = (pack.capabilities?.toolDefinitions || []).map((t) => t.toolId);
    if (!agent.modelPolicyRef && (agent as any).policyRef) agent.modelPolicyRef = (agent as any).policyRef;
    if (!agent.purpose) agent.purpose = (agent as any).role || agent.name || 'Advise customer';
  }
  if (!Array.isArray(pack.rules)) pack.rules = (pack.rules as any)?.businessRules || [];
  if (!Array.isArray(pack.evaluations)) pack.evaluations = (pack.evaluations as any)?.suites || [];
  if (!(pack.conversationPolicy as any)?.fencingRules && (pack.conversationPolicy as any)?.policies) {
    pack.conversationPolicy = {
      fencingRules: (pack.conversationPolicy as any)?.policies?.flatMap((p: any) => p.rules || []) || [],
      prohibitedTopics: [],
      escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 3 },
    };
  }

  const schemaParsed = BusinessPackReleaseSchema.safeParse(pack);
  const schemaValid = schemaParsed.success;
  const schemaErrors = schemaParsed.success ? [] : schemaParsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`);
  if (!schemaValid) blockers.push(`Schema validation failed: ${schemaErrors.join('; ')}`);

  let semanticValid = false;
  let semanticErrors: string[] = [];
  if (schemaValid) {
    const semanticValidation = validateBusinessPack(schemaParsed.data);
    semanticValid = semanticValidation.valid;
    semanticErrors = semanticValidation.issues.map((i) => `[${i.path}] ${i.message}`);
    if (!semanticValid) blockers.push(`Semantic validation failed: ${semanticErrors.join('; ')}`);
  } else {
    semanticErrors = ['Schema invalid; skipping semantic validation'];
    blockers.push('Semantic validation skipped due to schema errors');
  }

  const refIntegrity = capabilityRegistry.validateBusinessPackReferenceIntegrity(pack as any);
  const referenceIntegrityValid = refIntegrity.valid;
  const referenceIntegrityErrors = refIntegrity.errors;
  if (!referenceIntegrityValid) blockers.push(`Reference integrity failed: ${referenceIntegrityErrors.join('; ')}`);

  const multiTenantCatalog: MockProductRecord[] = [
    { sku: `${project.tenantId.toUpperCase()}-SKU-001`, projectId: project.tenantId, tenantId: project.tenantId, title: `Genuine Product for ${project.name}`, category: 'Hardware', price: { amount: 100, currency: 'AUD' }, stock: { inStock: true, availableQuantity: 10 } },
    { sku: 'OTHER-LEAK-999', projectId: 'other_isolated_tenant', tenantId: 'other_isolated_tenant', title: 'Leaked Cross-Tenant Product', category: 'Hardware', price: { amount: 999, currency: 'USD' }, stock: { inStock: true, availableQuantity: 1 } },
  ];

  const handler = new CatalogSearchHandler(multiTenantCatalog);
  const searchResponse = await handler.execute(
    { query: 'Genuine', category: 'Hardware' },
    {
      workspaceId: `ws_${project.tenantId}`,
      tenantId: project.tenantId,
      environmentId: 'production',
      correlationId: `corr_${project.tenantId}`,
      sessionId: `sess_${project.tenantId}`,
      stageId: 'stage_discovery',
      packVersionId: '1.0.0',
    }
  );

  const isolationPassed =
    searchResponse.items.length === 1 &&
    searchResponse.items[0].sku === `${project.tenantId.toUpperCase()}-SKU-001` &&
    !searchResponse.items.some((i: any) => i.sku === 'OTHER-LEAK-999');

  const isolationEvidence = isolationPassed
    ? `Executed CatalogSearchHandler: strictly returned 1 item for tenant '${project.tenantId}'; 0 items leaked from 'other_isolated_tenant'`
    : `Isolation failed: cross-tenant items leaked in CatalogSearchHandler execution`;

  if (!isolationPassed) blockers.push('Grounded retrieval tenant isolation check failed');

  const rawSecretsList = scanForRawSecrets(pack);
  const rawSecretsCount = rawSecretsList.length;
  if (rawSecretsCount > 0) blockers.push(`Raw secrets present: ${rawSecretsList.join(', ')}`);

  const directUrlsList = scanForDirectUrls(pack);
  const directUrlsCount = directUrlsList.length;
  if (directUrlsCount > 0) blockers.push(`Direct provider URLs present: ${directUrlsList.join(', ')}`);

  const connectorBoundaryCompliant =
    rawSecretsCount === 0 &&
    directUrlsCount === 0 &&
    (pack.capabilities?.toolBindings || []).every(
      (b) => b.executor.type === 'native_capability' || (b.executor.type === 'activepieces_flow' && (b.executor as any).connectionRef)
    );

  if (!connectorBoundaryCompliant) blockers.push('Connector boundary compliance violated');

  const connectionRefMappings = (pack.capabilities?.toolBindings || [])
    .filter((b) => b.executor.type === 'activepieces_flow' && (b.executor as any).connectionRef)
    .map((b) => `${b.toolId} -> ${(b.executor as any).connectionRef}`);

  const envKey = tenantEnvKey(project.tenantId, 'production');
  const cutoverDoc = dbEvidence.cutovers.get(envKey);
  const pointerDoc = dbEvidence.pointers.get(envKey);
  const releaseDoc = dbEvidence.releases.get(envKey);

  let cutoverRecordState: 'VERIFIED_ACTIVE' | 'PENDING_APPROVAL' | 'NO_RECORD_FOUND' = 'NO_RECORD_FOUND';
  if (cutoverDoc) {
    if (cutoverDoc.status === 'active') {
      const hasActivePointer = Boolean(pointerDoc && (pointerDoc.activeVersion === pack?.manifest?.version || pointerDoc.activeReleaseId === pack?.manifest?.packId));
      const hasValidChecksum = Boolean((releaseDoc && (releaseDoc.manifestChecksum || releaseDoc.checksum)) || pack?.manifest?.checksum);
      if (hasActivePointer && hasValidChecksum) {
        cutoverRecordState = 'VERIFIED_ACTIVE';
      } else {
        cutoverRecordState = 'PENDING_APPROVAL';
        blockers.push('Cutover is marked active but lacks matching active pointer or validated checksum');
      }
    } else if (cutoverDoc.status === 'pending' || cutoverDoc.status === 'approved' || cutoverDoc.approvalRecord) {
      cutoverRecordState = 'PENDING_APPROVAL';
    }
  }

  let rollbackEvidence: 'BASELINE_CONFIRMED' | 'NO_ROLLBACK_BASELINE' = 'NO_ROLLBACK_BASELINE';
  if (pointerDoc && (pointerDoc.baselineVersion || pointerDoc.rollbackVersion)) rollbackEvidence = 'BASELINE_CONFIRMED';
  else if (cutoverDoc && (cutoverDoc.baselineVersion || cutoverDoc.rollbackVersion)) rollbackEvidence = 'BASELINE_CONFIRMED';

  if (cutoverRecordState === 'NO_RECORD_FOUND') blockers.push('Cutover approval record missing in tenant_cutovers');
  else if (cutoverRecordState === 'PENDING_APPROVAL') blockers.push('Cutover status is not actively verified (pending approval or pointer reconciliation)');

  if (rollbackEvidence === 'NO_ROLLBACK_BASELINE') blockers.push('Rollback baseline snapshot missing in business_pack_pointers or tenant_cutovers');
  if (project.classification === 'SYNTHETIC_FIXTURE' || project.source === 'synthetic_fixture') blockers.push('Synthetic test fixture: not a discovered customer project');

  let parityResult: 'VERIFIED' | 'PARTIAL' | 'UNEVALUATED' = 'UNEVALUATED';
  const parityDoc = dbEvidence.parityEvidence.get(envKey);
  if (parityDoc && typeof parityDoc.scenariosRun === 'number' && parityDoc.scenariosRun > 0) {
    if (parityDoc.scenariosPassed === parityDoc.scenariosRun) parityResult = 'VERIFIED';
    else if (parityDoc.scenariosPassed > 0) parityResult = 'PARTIAL';
  }

  const immutableReleaseReadiness: 'READY' | 'NOT_READY' =
    blockers.length === 0 && connectorBoundaryCompliant && schemaValid && semanticValid && referenceIntegrityValid && isolationPassed
      ? 'READY'
      : 'NOT_READY';

  let migrationStatus: 'CANDIDATE_PACK_VALIDATED' | 'FIXTURE_EVALUATION_ONLY' | 'PARKED' | 'BLOCKED';
  if (project.classification === 'SYNTHETIC_FIXTURE' || project.source === 'synthetic_fixture') {
    migrationStatus = 'FIXTURE_EVALUATION_ONLY';
  } else if (project.classification === 'PARKED') {
    migrationStatus = 'PARKED';
    blockers.push('Parked tenant — not counted in active portfolio readiness');
  } else if (immutableReleaseReadiness === 'READY') {
    migrationStatus = 'CANDIDATE_PACK_VALIDATED';
  } else {
    migrationStatus = 'BLOCKED';
  }

  return {
    tenantId: project.tenantId, name: project.name, source: project.source, classification: project.classification,
    industry: project.industry, commerceMode: project.commerceMode, schemaValid, schemaErrors, semanticValid, semanticErrors,
    referenceIntegrityValid, referenceIntegrityErrors, groundedRetrievalIsolated: isolationPassed, groundedRetrievalEvidence: isolationEvidence,
    connectorBoundaryCompliant, rawSecretsCount, rawSecretsList, directUrlsCount, directUrlsList,
    checksum: pack.manifest?.checksum || computePackChecksum(pack), activepiecesFlowsCount: (pack.capabilities?.toolBindings || []).filter((b) => b.executor?.type === 'activepieces_flow').length,
    connectionRefMappings, parityResult, immutableReleaseReadiness, cutoverRecordState, rollbackEvidence, blockers, migrationStatus,
  };
}

export interface InventoryOptions {
  writeReport?: boolean;
  manifestPath?: string;
  manifest?: PortfolioManifest;
}

export async function runTenantConnectorInventory(
  options: InventoryOptions = {}
): Promise<ComputedAuditResult[]> {
  const manifest = options.manifest ?? loadPortfolioManifest(options.manifestPath);

  const dbEnv = resolveSafeDatabaseEnvironment();
  if (dbEnv.warning) console.warn(`🔒 ${dbEnv.warning}`);

  console.log('\n📊 Running Truthful Tenant Connector Migration Inventory & Audit...\n');

  let dbEvidence: DatabaseEvidence = {
    connected: false, discoveredProjects: new Set(), releases: new Map(), pointers: new Map(),
    cutovers: new Map(), connections: new Map(), secrets: new Map(), normalizationReports: new Map(), parityEvidence: new Map(),
  };

  if (dbEnv.mode === 'connected' && dbEnv.uri) {
    dbEvidence = await queryNonProductionDatabase(dbEnv.uri);
  }

  const capabilityRegistry = new CapabilityRegistryService();
  const discoveredProjects = await discoverProjects(dbEvidence, manifest);
  const results: ComputedAuditResult[] = [];

  for (const project of discoveredProjects) {
    const auditRes = await auditProject(project, dbEvidence, options, capabilityRegistry);
    results.push(auditRes);
  }

  // Console Summary Table
  console.table(
    results.map((r) => ({
      Tenant: r.tenantId,
      Class: r.classification,
      Source: r.source,
      Schema: r.schemaValid ? 'PASS' : 'FAIL',
      Isolated: r.groundedRetrievalIsolated ? 'YES' : 'NO',
      RawSecrets: r.rawSecretsCount,
      DirectUrls: r.directUrlsCount,
      Readiness: r.immutableReleaseReadiness,
      Status: r.migrationStatus,
      BlockerCount: r.blockers.length,
    }))
  );

  const writeFlag = options.writeReport ?? process.argv.includes('--write');
  if (writeFlag) {
    const reportPath = path.resolve(__dirname, '../docs/tenant-connector-migration-inventory.md');
    const timestamp = new Date().toISOString();

    const activeResults = results.filter((r) => r.classification === 'ACTIVE_PORTFOLIO');
    const parkedResults = results.filter((r) => r.classification === 'PARKED');
    const fixtureResults = results.filter((r) => r.classification === 'SYNTHETIC_FIXTURE');

    const discoveredActiveCount = activeResults.filter((r) => r.source !== 'not_discovered').length;
    const blockedUndiscoveredCount = activeResults.filter((r) => r.source === 'not_discovered').length;
    const readyActiveCount = activeResults.filter((r) => r.immutableReleaseReadiness === 'READY').length;

    let md = `# JourneyAX Tenant Connector Migration Inventory & Truthful Audit\n\n`;
    md += `**Audit Timestamp**: \`${timestamp}\`\n`;
    md += `**Portfolio Manifest Version**: \`${manifest.version}\`\n`;
    md += `**Audit Mode**: Read-Only Architecture Enforcement & Evidence-Backed Verification\n\n`;
    md += `> **MIGRATION STATUS NOTICE**: Parked tenants do not affect active-portfolio readiness. Synthetic fixtures are excluded from readiness counts. Undiscovered active-portfolio tenants fail closed as \`NOT_DISCOVERED\` / \`BLOCKED\`.\n\n---\n\n`;

    md += `## 1. Executive Summary\n\n`;
    md += `| Metric | Value |\n| :--- | :--- |\n`;
    md += `| Active portfolio tenants | ${activeResults.length} |\n`;
    md += `| Discovered active tenants | ${discoveredActiveCount} / ${activeResults.length} |\n`;
    md += `| Undiscovered active tenants | ${blockedUndiscoveredCount} / ${activeResults.length} |\n`;
    md += `| Immutable release ready (active) | ${readyActiveCount} / ${activeResults.length} |\n`;
    md += `| Parked tenants (not counted) | ${parkedResults.length} |\n`;
    md += `| Synthetic test fixtures (excluded) | ${fixtureResults.length} |\n\n`;

    md += `## 2. Active Portfolio Readiness Matrix\n\n`;
    md += `| Tenant ID | Display Name | Discovered | Schema | Semantics | Isolation | Status | Notes |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const r of activeResults) {
      const manifestEntry = manifest.activePortfolio.find((e) => e.tenantId === r.tenantId);
      const notes = manifestEntry?.notes ?? '';
      md += `| \`${r.tenantId}\` | ${r.name} | ${r.source !== 'not_discovered' ? '✅' : '❌'} | ${r.schemaValid ? 'PASS' : 'FAIL'} | ${r.semanticValid ? 'PASS' : 'FAIL'} | ${r.groundedRetrievalIsolated ? 'YES' : 'NO'} | \`${r.migrationStatus}\` | ${notes} |\n`;
    }
    md += `\n`;

    md += `## 3. Parked Tenants (Not Counted in Active Readiness)\n\n`;
    md += `| Tenant ID | Display Name | Reason |\n| :--- | :--- | :--- |\n`;
    for (const r of parkedResults) {
      const parkedEntry = manifest.parked.find((e) => e.tenantId === r.tenantId);
      md += `| \`${r.tenantId}\` | ${r.name} | ${parkedEntry?.reason ?? 'Parked'} |\n`;
    }
    md += `\n`;

    md += `## 4. Synthetic Test Fixtures (Topology Matrix Only)\n\n`;
    if (fixtureResults.length === 0) { md += `No synthetic fixtures found.\n\n`; }
    else {
      md += `| Tenant ID | Schema | Status |\n| :--- | :---: | :---: |\n`;
      for (const r of fixtureResults) md += `| \`${r.tenantId}\` | ${r.schemaValid ? 'PASS' : 'FAIL'} | \`${r.migrationStatus}\` |\n`;
      md += `\n`;
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, md.trimEnd() + '\n', 'utf8');
    console.log(`\n📄 Truthful migration inventory written to:\n   ${reportPath}\n`);
  } else {
    console.log('\nℹ️ Read-only run complete. Use --write flag to regenerate docs/tenant-connector-migration-inventory.md\n');
  }

  return results;
}

if (require.main === module) {
  runTenantConnectorInventory().catch((err) => {
    console.error('Fatal error during tenant connector inventory:', err);
    process.exit(1);
  });
}
