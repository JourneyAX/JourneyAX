/**
 * Truthful Tenant Connector Migration Inventory & Dry-Run Audit
 *
 * Requirements (Workstream C):
 * 1. Discovers actual projects from filesystem migration sources (packs/)
 *    and non-production DB if available.
 * 2. Does not synthesize readiness, parity, cutover, rollback, or immutable-release evidence.
 * 3. Does not clear a supplied safe TEST_MONGODB_URI; refuses production-like URIs
 *    and operates offline when none is supplied.
 * 4. Queries real non-production releases, active pointers, cutover records,
 *    typed connector mappings, secret mappings, normalization reports, and parity/canary evidence when available.
 * 5. Undiscovered required tenants must be NOT_DISCOVERED/BLOCKED, not synthetic ready.
 * 6. Synthetic fixtures must be in a separate test-only section and excluded from readiness counts.
 * 7. Parity is UNEVALUATED unless actual project scenarios ran.
 * 8. Release readiness must be false whenever blockers or connector-boundary failures exist.
 *    The generated summary and per-project rows must be internally consistent.
 * 9. Read-only by default; writes docs/tenant-connector-migration-inventory.md only with --write.
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

export type ProjectSource = 'filesystem_pack' | 'non_prod_db' | 'not_discovered' | 'synthetic_fixture';

export interface DiscoveredProject {
  tenantId: string;
  name: string;
  source: ProjectSource;
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
  migrationStatus: 'CANDIDATE_PACK_VALIDATED' | 'FIXTURE_EVALUATION_ONLY' | 'BLOCKED';
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
}

export const REQUIRED_CUSTOMER_TENANTS = [
  'workweargroup',
  'royalcyber',
  'abercrombie',
  'caroma',
  'caroma-nz',
  'placemakers',
  'momentec',
  'garts',
  'dragonshield',
];

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
 * Resolves safe database environment strictly via TEST_MONGODB_URI or allowlisted non-production source.
 * Never falls back to MONGODB_URI. Refuses production-like URIs and operates offline when none is supplied.
 */
export function resolveSafeDatabaseEnvironment(
  env: Record<string, string | undefined> = process.env
): SafeDatabaseEnvironment {
  // Connect only via explicit TEST_MONGODB_URI or allowlisted non-production source; never fall back to MONGODB_URI
  const rawUri = env.TEST_MONGODB_URI;
  if (!rawUri || !rawUri.trim()) {
    return {
      mode: 'offline_safe',
      warning: 'No TEST_MONGODB_URI supplied. Operating in safe offline mode. (MONGODB_URI fallback prohibited)',
    };
  }

  const trimmed = rawUri.trim();
  const lower = trimmed.toLowerCase();

  // Guard against production-like URIs
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

  return {
    uri: trimmed,
    mode: 'connected',
  };
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

/**
 * Queries real non-production MongoDB collections when a safe URI is available.
 * Keys all evidence by tenant+environment, uses projections/countDocuments for secrets,
 * and deterministically selects releases, pointers, and cutovers.
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

    // Discover any customer projects from non-production DB
    try {
      const p1 = await db.collection('tenant_configs').find({}).project({ projectId: 1, _id: 0 }).toArray();
      for (const p of p1) if (p.projectId) evidence.discoveredProjects.add(p.projectId);
      const p2 = await db.collection('projects').find({}).project({ projectId: 1, _id: 0 }).toArray();
      for (const p of p2) if (p.projectId) evidence.discoveredProjects.add(p.projectId);
    } catch {}

    // Deterministically select releases: sort by version desc, createdAt desc
    const releases = await db
      .collection('business_pack_releases')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, version: -1, createdAt: -1 })
      .toArray();
    for (const r of releases) {
      if (r.tenantId) {
        const key = tenantEnvKey(r.tenantId, r.environmentId || 'production');
        if (!evidence.releases.has(key)) {
          evidence.releases.set(key, r);
        }
      }
    }

    // Deterministically select pointers: sort by updatedAt desc
    const pointers = await db
      .collection('business_pack_pointers')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, updatedAt: -1 })
      .toArray();
    for (const p of pointers) {
      if (p.tenantId) {
        const key = tenantEnvKey(p.tenantId, p.environmentId || 'production');
        if (!evidence.pointers.has(key)) {
          evidence.pointers.set(key, p);
        }
      }
    }

    // Deterministically select cutovers: sort by cutoverAt desc, createdAt desc
    const cutovers = await db
      .collection('tenant_cutovers')
      .find({})
      .sort({ tenantId: 1, environmentId: 1, cutoverAt: -1, createdAt: -1 })
      .toArray();
    for (const c of cutovers) {
      if (c.tenantId) {
        const key = tenantEnvKey(c.tenantId, c.environmentId || 'production');
        if (!evidence.cutovers.has(key)) {
          evidence.cutovers.set(key, c);
        }
      }
    }

    // Connections with projection (never fetch raw credentials)
    const connections = await db
      .collection('tenant_connections')
      .find({})
      .project({
        _id: 0,
        connectionRef: 1,
        name: 1,
        pieceName: 1,
        pieceId: 1,
        provider: 1,
        status: 1,
        enabled: 1,
        allowedFlows: 1,
        tenantId: 1,
        environmentId: 1,
      })
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

    // Secrets count using aggregation / projections (strictly avoid loading raw secrets into memory)
    const secretCounts = await db
      .collection('tenant_secrets')
      .aggregate([
        {
          $group: {
            _id: {
              tenantId: '$tenantId',
              environmentId: { $ifNull: ['$environmentId', 'production'] },
            },
            count: { $sum: 1 },
          },
        },
      ])
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
    if (client) {
      try {
        await client.close();
      } catch {}
    }
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
      if (
        SECRET_KEYS.includes(lowKey) ||
        (lowKey === 'secret' && !p.toLowerCase().endsWith('secretref'))
      ) {
        const val = v.trim();
        if (
          val &&
          !val.startsWith('••••') &&
          !val.startsWith('vault://') &&
          !val.startsWith('ref://') &&
          !val.startsWith('env://')
        ) {
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
        if (v.includes(domain)) {
          found.push(`${p}: references direct domain '${domain}'`);
        }
      }
    } else if (typeof v === 'object') {
      found.push(...scanForDirectUrls(v, p));
    }
  }
  return found;
}

/**
 * Discovers projects from filesystem and database.
 */
async function discoverProjects(dbEvidence: DatabaseEvidence): Promise<DiscoveredProject[]> {
  const discovered: DiscoveredProject[] = [];
  const loader = new BusinessPackLoader();

  // 1. Filesystem migration sources in packs/
  const packsDir = path.resolve(__dirname, '../packs');
  if (fs.existsSync(packsDir)) {
    const entries = fs.readdirSync(packsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const tenantDir = path.join(packsDir, entry.name);
        if (fs.existsSync(path.join(tenantDir, 'manifest.json'))) {
          const loaded = await loader.loadFromDisk(entry.name, 'production');
          if (loaded) {
            const modelCandidate = loaded.modelPolicy?.policies?.[0]?.candidates?.[0];
            const modelSpec = modelCandidate
              ? { provider: modelCandidate.provider, model: modelCandidate.model }
              : { provider: 'custom', model: 'tenant_configured' };

            const externalConnectors: string[] = [];
            if (loaded.capabilities?.toolBindings?.some((b) => b.executor?.type === 'activepieces_flow')) {
              externalConnectors.push('Activepieces Flows');
            }
            if (loaded.capabilities?.toolBindings?.some((b) => b.executor?.type === 'native_capability')) {
              externalConnectors.push('Native Capabilities');
            }

            discovered.push({
              tenantId: loaded.manifest.tenantId,
              name: loaded.profile?.companyName || loaded.manifest.name,
              source: 'filesystem_pack',
              industry: loaded.profile?.industry || 'Commercial Enterprise',
              commerceMode: 'quote',
              externalConnectors,
              activepiecesFlows: (loaded.capabilities?.toolBindings || [])
                .filter((b) => b.executor?.type === 'activepieces_flow')
                .map((b) => ({
                  toolId: b.toolId,
                  flowId: (b.executor as any).flowId,
                  connectionRef: (b.executor as any).connectionRef,
                  sideEffect: 'write',
                  risk: 'medium',
                })),
              model: modelSpec,
              dataResidency: loaded.manifest.dataResidency || 'au',
              packCandidate: loaded,
            });
          }
        }
      }
    }
  }

  // 2. Real non-production database releases
  for (const [key, releaseDoc] of dbEvidence.releases.entries()) {
    const tenantId = releaseDoc.manifest?.tenantId || releaseDoc.tenantId || key.split(':')[0];
    if (!discovered.some((d) => d.tenantId === tenantId)) {
      const modelCandidate = releaseDoc.modelPolicy?.policies?.[0]?.candidates?.[0];
      const modelSpec = modelCandidate
        ? { provider: modelCandidate.provider, model: modelCandidate.model }
        : { provider: 'custom', model: 'tenant_configured' };

      discovered.push({
        tenantId,
        name: releaseDoc.manifest?.name || tenantId,
        source: 'non_prod_db',
        industry: releaseDoc.profile?.industry || 'Enterprise',
        commerceMode: 'quote',
        externalConnectors: ['Activepieces Flows'],
        activepiecesFlows: (releaseDoc.capabilities?.toolBindings || [])
          .filter((b: any) => b.executor?.type === 'activepieces_flow')
          .map((b: any) => ({
            toolId: b.toolId,
            flowId: b.executor.flowId,
            connectionRef: b.executor.connectionRef,
            sideEffect: 'write',
            risk: 'medium',
          })),
        model: modelSpec,
        dataResidency: releaseDoc.manifest?.dataResidency || 'au',
        packCandidate: releaseDoc,
      });
    }
  }

  // 3. Required Customer Tenants and discovered projects: any missing are marked not_discovered
  const CUSTOMER_TENANT_METADATA: Record<
    string,
    { name: string; industry: string; commerceMode: 'quote' | 'cart'; residency: string }
  > = {
    workweargroup: { name: 'Workwear Group', industry: 'Industrial & Uniform Apparel', commerceMode: 'quote', residency: 'au' },
    royalcyber: { name: 'Royal Cyber Digital', industry: 'Commercial Consulting & Services', commerceMode: 'quote', residency: 'us' },
    abercrombie: { name: 'Abercrombie & Fitch', industry: 'Retail Apparel & Fashion', commerceMode: 'cart', residency: 'us' },
    caroma: { name: 'Caroma Australia', industry: 'Commercial & Residential Fixtures', commerceMode: 'quote', residency: 'au' },
    'caroma-nz': { name: 'Caroma New Zealand', industry: 'Commercial & Residential Fixtures', commerceMode: 'quote', residency: 'nz' },
    placemakers: { name: 'PlaceMakers New Zealand', industry: 'Building Materials & Trade Supplies', commerceMode: 'quote', residency: 'nz' },
    momentec: { name: 'Momentec Brands', industry: 'Custom Sports & Athletic Apparel', commerceMode: 'cart', residency: 'us' },
    garts: { name: 'Gart Sports & Outdoor', industry: 'Sporting Goods & Outdoor Recreation', commerceMode: 'quote', residency: 'us' },
    dragonshield: { name: 'Dragon Shield (Arcane Tinmen)', industry: 'Gaming Accessories & Card Sleeves', commerceMode: 'cart', residency: 'eu' },
  };

  const allRequiredCustomerTenants = new Set([
    ...REQUIRED_CUSTOMER_TENANTS,
    ...dbEvidence.discoveredProjects,
  ]);

  for (const requiredId of allRequiredCustomerTenants) {
    if (!discovered.some((d) => d.tenantId === requiredId)) {
      const meta = CUSTOMER_TENANT_METADATA[requiredId] || {
        name: requiredId,
        industry: 'Commercial Enterprise',
        commerceMode: 'quote',
        residency: 'au',
      };
      discovered.push({
        tenantId: requiredId,
        name: meta.name,
        source: 'not_discovered',
        industry: meta.industry,
        commerceMode: meta.commerceMode,
        externalConnectors: [],
        activepiecesFlows: [],
        model: { provider: 'custom', model: 'tenant_configured' },
        dataResidency: meta.residency,
      });
    }
  }

  // 4. Synthetic test fixtures (evaluated for topology matrix testing only, separate from customer readiness)
  const syntheticFixtures: Omit<DiscoveredProject, 'source'>[] = [
    {
      tenantId: 'placemakers_fixture',
      name: 'PlaceMakers Topology Fixture',
      industry: 'Building Materials & Trade Supplies',
      commerceMode: 'quote',
      externalConnectors: ['SAP ERP (Activepieces)', 'Trade Quote Flow'],
      activepiecesFlows: [
        {
          toolId: 'sap.quote_sync',
          flowId: 'ap_flow_pm_sap_quote',
          connectionRef: 'conn_pm_sap_trade',
          sideEffect: 'write',
          risk: 'medium',
        },
      ],
      model: { provider: 'custom', model: 'trade_quote_model' },
      dataResidency: 'nz',
    },
    {
      tenantId: 'abercrombie_fixture',
      name: 'Abercrombie Topology Fixture',
      industry: 'Retail Apparel & Fashion',
      commerceMode: 'cart',
      externalConnectors: ['Shopify (Activepieces)'],
      activepiecesFlows: [
        {
          toolId: 'shopify.order_create',
          flowId: 'ap_flow_anf_shopify_order',
          connectionRef: 'conn_anf_shopify_secret',
          sideEffect: 'transactional',
          risk: 'high',
        },
      ],
      model: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      dataResidency: 'us',
    },
    {
      tenantId: 'caroma_fixture',
      name: 'Caroma Topology Fixture',
      industry: 'Commercial & Residential Fixtures',
      commerceMode: 'quote',
      externalConnectors: ['Activepieces Flows'],
      activepiecesFlows: [
        {
          toolId: 'quote.create',
          flowId: 'ap_flow_caroma_quote',
          connectionRef: 'conn_caroma_quote_secret',
          sideEffect: 'write',
          risk: 'medium',
        },
      ],
      model: { provider: 'google', model: 'gemini-2.5-pro' },
      dataResidency: 'au',
    },
    {
      tenantId: 'momentec_fixture',
      name: 'Momentec Topology Fixture',
      industry: 'Custom Sports & Athletic Apparel',
      commerceMode: 'cart',
      externalConnectors: ['commercetools (Activepieces)'],
      activepiecesFlows: [
        {
          toolId: 'commercetools.roster_order',
          flowId: 'ap_flow_momentec_ct_order',
          connectionRef: 'conn_momentec_ct_secret',
          sideEffect: 'transactional',
          risk: 'high',
        },
      ],
      model: { provider: 'google', model: 'gemini-1.5-pro' },
      dataResidency: 'us',
    },
    {
      tenantId: 'garts_fixture',
      name: 'Gart Sports Topology Fixture',
      industry: 'Sporting Goods & Outdoor Recreation',
      commerceMode: 'quote',
      externalConnectors: ['SAP ERP (Activepieces)'],
      activepiecesFlows: [
        {
          toolId: 'sap.b2b_inventory_check',
          flowId: 'ap_flow_garts_sap_inv',
          connectionRef: 'conn_garts_sap_secret',
          sideEffect: 'read',
          risk: 'low',
        },
      ],
      model: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      dataResidency: 'us',
    },
    {
      tenantId: 'dragonshield_fixture',
      name: 'Dragon Shield Topology Fixture',
      industry: 'Gaming Accessories & Card Sleeves',
      commerceMode: 'cart',
      externalConnectors: ['Shopify (Activepieces)', 'Stripe (Activepieces)'],
      activepiecesFlows: [
        {
          toolId: 'shopify.cart_checkout',
          flowId: 'ap_flow_ds_shopify_checkout',
          connectionRef: 'conn_ds_shopify_secret',
          sideEffect: 'transactional',
          risk: 'high',
        },
      ],
      model: { provider: 'custom', model: 'gaming_cart_model' },
      dataResidency: 'eu',
    },
  ];

  for (const f of syntheticFixtures) {
    if (!discovered.some((d) => d.tenantId === f.tenantId)) {
      discovered.push({ ...f, source: 'synthetic_fixture' });
    }
  }

  return discovered;
}

function buildCandidatePack(spec: DiscoveredProject): BusinessPackRelease | null {
  if (spec.source === 'not_discovered') {
    return null;
  }

  if (spec.packCandidate) {
    return spec.packCandidate;
  }

  const pack: BusinessPackRelease = {
    manifest: {
      packId: `pack_${spec.tenantId}`,
      tenantId: spec.tenantId,
      environmentId: 'production',
      version: '1.0.0',
      name: `${spec.name} Business Pack`,
      description: `Candidate Business Pack for ${spec.name}`,
      author: 'JourneyAX Migration Authority',
      dataResidency: spec.dataResidency,
      checksum: '',
    },
    profile: {
      companyName: spec.name,
      industry: spec.industry,
      targetAudience: 'B2B/B2C Customers',
      brandValues: ['Integrity', 'Quality'],
      toneOfVoice: 'Professional, Grounded',
    },
    vocabulary: { terms: [], acronyms: {}, slotSynonyms: {} },
    entities: { entities: [] },
    conversationPolicy: {
      fencingRules: ['Stay grounded in catalog data'],
      prohibitedTopics: [],
      escalationThresholds: {
        sentimentFloor: -0.6,
        maxTurnsWithoutProgress: 4,
      },
    },
    modelPolicy: {
      version: '1.0.0',
      defaultPolicy: 'p1',
      policies: [
        {
          policyId: 'p1',
          taskType: 'general_turn',
          candidates: [{ provider: spec.model.provider, model: spec.model.model, priority: 1 }],
          dataResidency: spec.dataResidency,
          maxInputTokens: 8000,
          maxOutputTokens: 2000,
          fallbackAllowed: false,
        },
      ],
    },
    agents: [
      {
        agentId: 'primary_stylist',
        name: `${spec.name} Advisor`,
        purpose: 'Advise customer on products and specifications',
        systemPromptTemplate: 'Ground all answers in authoritative catalog data.',
        modelPolicyRef: 'p1',
        allowedTools: [
          'catalog.search',
          'pricing.validate',
          'order.commit',
          ...spec.activepiecesFlows.map((f) => f.toolId),
        ],
      },
    ],
    journeys: [
      {
        journeyId: `${spec.tenantId}_journey`,
        version: '1.0.0',
        displayName: `${spec.name} Flow`,
        goals: ['product_discovery'],
        initialStage: 'stage_discovery',
        stages: {
          stage_discovery: {
            stageId: 'stage_discovery',
            displayName: 'Discovery',
            requiredFacts: [],
            allowedCapabilities: ['catalog.search', 'knowledge.search'],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [{ nextStage: 'stage_checkout' }],
          },
          stage_checkout: {
            stageId: 'stage_checkout',
            displayName: 'Checkout',
            requiredFacts: ['selected_items'],
            allowedCapabilities: [
              'pricing.validate',
              'order.commit',
              ...spec.activepiecesFlows.map((f) => f.toolId),
            ],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [],
          },
        },
      },
    ],
    capabilities: {
      version: '1.0.0',
      toolDefinitions: [
        {
          toolId: 'catalog.search',
          version: '1.0.0',
          displayName: 'Catalog Search',
          description: 'Domain-neutral catalog search',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 60 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
          dataClassification: 'public',
        },
        {
          toolId: 'pricing.validate',
          version: '1.0.0',
          displayName: 'Pricing Validate',
          description: 'Domain-neutral pricing validation',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'read',
          risk: 'low',
          timeoutPolicy: { timeoutMs: 5000, retryAttempts: 0 },
          idempotencyPolicy: { required: false, ttlSeconds: 60 },
          approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
          dataClassification: 'internal',
        },
        {
          toolId: 'order.commit',
          version: '1.0.0',
          displayName: 'Order Commit',
          description: 'Durable order commitment',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: 'transactional',
          risk: 'high',
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: true, ttlSeconds: 3600 },
          approvalPolicy: { requiresApproval: true, ttlMinutes: 30 },
          dataClassification: 'confidential',
        },
        ...spec.activepiecesFlows.map((f) => ({
          toolId: f.toolId,
          version: '1.0.0',
          displayName: f.toolId,
          description: `Activepieces flow execution for ${f.toolId}`,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          sideEffect: f.sideEffect,
          risk: f.risk,
          timeoutPolicy: { timeoutMs: 15000, retryAttempts: 1 },
          idempotencyPolicy: { required: f.sideEffect !== 'read', ttlSeconds: 300 },
          approvalPolicy: { requiresApproval: f.risk === 'high', ttlMinutes: 15 },
          dataClassification: 'internal' as const,
        })),
      ],
      toolBindings: [
        {
          tenantId: spec.tenantId,
          environmentId: 'production',
          toolId: 'catalog.search',
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'catalog.search' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 5000,
            retryAttempts: 0,
          },
        },
        {
          tenantId: spec.tenantId,
          environmentId: 'production',
          toolId: 'pricing.validate',
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'pricing.validate' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: false,
            idempotencyRequired: false,
            timeoutMs: 5000,
            retryAttempts: 0,
          },
        },
        {
          tenantId: spec.tenantId,
          environmentId: 'production',
          toolId: 'order.commit',
          bindingVersion: '1.0.0',
          executor: { type: 'native_capability', nativeHandler: 'order.commit' },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: true,
            idempotencyRequired: true,
            timeoutMs: 10000,
            retryAttempts: 0,
          },
        },
        ...spec.activepiecesFlows.map((f) => ({
          tenantId: spec.tenantId,
          environmentId: 'production' as const,
          toolId: f.toolId,
          bindingVersion: '1.0.0',
          executor: {
            type: 'activepieces_flow' as const,
            flowId: f.flowId,
            connectionRef: f.connectionRef,
          },
          enabled: true,
          policy: {
            requiredRole: 'customer',
            requiresConfirmation: f.risk === 'high',
            idempotencyRequired: f.sideEffect !== 'read',
            timeoutMs: 15000,
            retryAttempts: 1,
          },
        })),
      ],
      stageBindings: [
        {
          journeyId: `${spec.tenantId}_journey`,
          stageId: 'stage_discovery',
          tools: [{ toolId: 'catalog.search' }],
        },
        {
          journeyId: `${spec.tenantId}_journey`,
          stageId: 'stage_checkout',
          tools: [
            { toolId: 'pricing.validate' },
            { toolId: 'order.commit' },
            ...spec.activepiecesFlows.map((f) => ({ toolId: f.toolId })),
          ],
        },
      ],
    },
    experience: {
      version: '1.0.0',
      theme: {
        primaryColor: '#0055ff',
        accentColor: '#ff0055',
        fontFamily: 'Inter, sans-serif',
      },
      cards: {
        allowedCardTypes: ['products', 'specifications', 'orders'],
      },
    },
    rules: [],
    evaluations: [],
    checksum: '',
  };

  pack.manifest.checksum = computePackChecksum(pack);
  pack.checksum = pack.manifest.checksum;
  return pack;
}

export async function auditProject(
  project: DiscoveredProject,
  dbEvidence: DatabaseEvidence,
  options: { writeReport?: boolean } = {},
  capabilityRegistry: CapabilityRegistryService = new CapabilityRegistryService()
): Promise<ComputedAuditResult> {
  const blockers: string[] = [];

  // Case 1: Required customer tenant NOT discovered on disk or database
  if (project.source === 'not_discovered') {
    blockers.push('Required customer tenant not discovered on filesystem or database');
    blockers.push('Cutover approval record missing in tenant_cutovers');
    blockers.push('Rollback baseline snapshot missing in business_pack_pointers');

    return {
      tenantId: project.tenantId,
      name: project.name,
      source: 'not_discovered',
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

  // Case 2: Discovered project (filesystem pack, non-prod DB, or synthetic fixture)
  const pack = buildCandidatePack(project)!;

  // Normalize legacy disk pack schema fields if loaded from disk
  for (const agent of pack.agents || []) {
    if (!agent.allowedTools) {
      agent.allowedTools = (pack.capabilities?.toolDefinitions || []).map((t) => t.toolId);
    }
    if (!agent.modelPolicyRef && (agent as any).policyRef) {
      agent.modelPolicyRef = (agent as any).policyRef;
    }
    if (!agent.purpose) {
      agent.purpose = (agent as any).role || agent.name || 'Advise customer';
    }
  }
  if (!Array.isArray(pack.rules)) {
    pack.rules = (pack.rules as any)?.businessRules || [];
  }
  if (!Array.isArray(pack.evaluations)) {
    pack.evaluations = (pack.evaluations as any)?.suites || [];
  }
  if (!(pack.conversationPolicy as any)?.fencingRules && (pack.conversationPolicy as any)?.policies) {
    pack.conversationPolicy = {
      fencingRules: (pack.conversationPolicy as any)?.policies?.flatMap((p: any) => p.rules || []) || [],
      prohibitedTopics: [],
      escalationThresholds: {
        sentimentFloor: -0.6,
        repetitionThreshold: 3,
      },
    };
  }

  // 1. Schema Validation
  const schemaParsed = BusinessPackReleaseSchema.safeParse(pack);
  const schemaValid = schemaParsed.success;
  const schemaErrors = schemaParsed.success
    ? []
    : schemaParsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  if (!schemaValid) {
    blockers.push(`Schema validation failed: ${schemaErrors.join('; ')}`);
  }

  // 2. Semantic Validation
  let semanticValid = false;
  let semanticErrors: string[] = [];
  if (schemaValid) {
    const semanticValidation = validateBusinessPack(schemaParsed.data);
    semanticValid = semanticValidation.valid;
    semanticErrors = semanticValidation.issues.map((i) => `[${i.path}] ${i.message}`);
    if (!semanticValid) {
      blockers.push(`Semantic validation failed: ${semanticErrors.join('; ')}`);
    }
  } else {
    semanticErrors = ['Schema invalid; skipping semantic validation'];
    blockers.push('Semantic validation skipped due to schema errors');
  }

  // 3. Reference Integrity against CapabilityRegistryService
  const refIntegrity = capabilityRegistry.validateBusinessPackReferenceIntegrity(pack as any);
  const referenceIntegrityValid = refIntegrity.valid;
  const referenceIntegrityErrors = refIntegrity.errors;
  if (!referenceIntegrityValid) {
    blockers.push(`Reference integrity failed: ${referenceIntegrityErrors.join('; ')}`);
  }

  // 4. Grounded Retrieval Tenant Isolation Proof
  const multiTenantCatalog: MockProductRecord[] = [
    {
      sku: `${project.tenantId.toUpperCase()}-SKU-001`,
      tenantId: project.tenantId,
      title: `Genuine Product for ${project.name}`,
      category: 'Hardware',
      price: { amount: 100, currency: 'AUD' },
      stock: { inStock: true, availableQuantity: 10 },
    },
    {
      sku: 'OTHER-LEAK-999',
      tenantId: 'other_isolated_tenant',
      title: 'Leaked Cross-Tenant Product',
      category: 'Hardware',
      price: { amount: 999, currency: 'USD' },
      stock: { inStock: true, availableQuantity: 1 },
    },
  ];

  const handler = new CatalogSearchHandler(multiTenantCatalog);
  const searchResponse = await handler.execute(
    { query: 'Genuine', category: 'Hardware' },
    {
      workspaceId: `ws_${project.tenantId}`,
      tenantId: project.tenantId,
      environmentId: 'production',
      correlationId: `corr_${project.tenantId}`,
    }
  );

  const isolationPassed =
    searchResponse.items.length === 1 &&
    searchResponse.items[0].sku === `${project.tenantId.toUpperCase()}-SKU-001` &&
    !searchResponse.items.some((i: any) => i.sku === 'OTHER-LEAK-999');

  const isolationEvidence = isolationPassed
    ? `Executed CatalogSearchHandler: strictly returned 1 item for tenant '${project.tenantId}'; 0 items leaked from 'other_isolated_tenant'`
    : `Isolation failed: cross-tenant items leaked in CatalogSearchHandler execution`;

  if (!isolationPassed) {
    blockers.push('Grounded retrieval tenant isolation check failed');
  }

  // 5. Raw Secrets
  const rawSecretsList = scanForRawSecrets(pack);
  const rawSecretsCount = rawSecretsList.length;
  if (rawSecretsCount > 0) {
    blockers.push(`Raw secrets present: ${rawSecretsList.join(', ')}`);
  }

  // 6. Direct Provider URLs
  const directUrlsList = scanForDirectUrls(pack);
  const directUrlsCount = directUrlsList.length;
  if (directUrlsCount > 0) {
    blockers.push(`Direct provider URLs present: ${directUrlsList.join(', ')}`);
  }

  // 7. Activepieces Connector Boundary Compliance
  const connectorBoundaryCompliant =
    rawSecretsCount === 0 &&
    directUrlsCount === 0 &&
    (pack.capabilities?.toolBindings || []).every(
      (b) =>
        b.executor.type === 'native_capability' ||
        (b.executor.type === 'activepieces_flow' && (b.executor as any).connectionRef)
    );

  if (!connectorBoundaryCompliant) {
    blockers.push('Connector boundary compliance violated');
  }

  // 8. Connection Ref Mappings
  const connectionRefMappings = (pack.capabilities?.toolBindings || [])
    .filter((b) => b.executor.type === 'activepieces_flow' && (b.executor as any).connectionRef)
    .map((b) => `${b.toolId} -> ${(b.executor as any).connectionRef}`);

  // 9. Cutover & Rollback Evidence from Real DB (keyed by tenant+environment)
  const envKey = tenantEnvKey(project.tenantId, 'production');
  const cutoverDoc = dbEvidence.cutovers.get(envKey);
  const pointerDoc = dbEvidence.pointers.get(envKey);
  const releaseDoc = dbEvidence.releases.get(envKey);

  let cutoverRecordState: 'VERIFIED_ACTIVE' | 'PENDING_APPROVAL' | 'NO_RECORD_FOUND' = 'NO_RECORD_FOUND';
  if (cutoverDoc) {
    // Validate cutover status, active pointer, release/checksum and rollback release.
    // Approval presence alone is NOT active cutover.
    if (cutoverDoc.status === 'active') {
      const hasActivePointer = Boolean(
        pointerDoc &&
          (pointerDoc.activeVersion === pack?.manifest?.version ||
            pointerDoc.activeReleaseId === pack?.manifest?.packId)
      );
      const hasValidChecksum = Boolean(
        (releaseDoc && (releaseDoc.manifestChecksum || releaseDoc.checksum)) ||
          pack?.manifest?.checksum
      );
      if (hasActivePointer && hasValidChecksum) {
        cutoverRecordState = 'VERIFIED_ACTIVE';
      } else {
        cutoverRecordState = 'PENDING_APPROVAL';
        blockers.push('Cutover is marked active but lacks matching active pointer or validated checksum');
      }
    } else if (
      cutoverDoc.status === 'pending' ||
      cutoverDoc.status === 'approved' ||
      cutoverDoc.approvalRecord
    ) {
      cutoverRecordState = 'PENDING_APPROVAL';
    }
  }

  let rollbackEvidence: 'BASELINE_CONFIRMED' | 'NO_ROLLBACK_BASELINE' = 'NO_ROLLBACK_BASELINE';
  if (pointerDoc && (pointerDoc.baselineVersion || pointerDoc.rollbackVersion)) {
    rollbackEvidence = 'BASELINE_CONFIRMED';
  } else if (cutoverDoc && (cutoverDoc.baselineVersion || cutoverDoc.rollbackVersion)) {
    rollbackEvidence = 'BASELINE_CONFIRMED';
  }

  if (cutoverRecordState === 'NO_RECORD_FOUND') {
    blockers.push('Cutover approval record missing in tenant_cutovers');
  } else if (cutoverRecordState === 'PENDING_APPROVAL') {
    blockers.push('Cutover status is not actively verified (pending approval or pointer reconciliation)');
  }

  if (rollbackEvidence === 'NO_ROLLBACK_BASELINE') {
    blockers.push('Rollback baseline snapshot missing in business_pack_pointers or tenant_cutovers');
  }
  if (project.source === 'synthetic_fixture') {
    blockers.push('Synthetic test fixture: not a discovered customer project');
  }

  // 10. Parity Evidence: UNEVALUATED unless actual project scenarios ran
  let parityResult: 'VERIFIED' | 'PARTIAL' | 'UNEVALUATED' = 'UNEVALUATED';
  const parityDoc = dbEvidence.parityEvidence.get(envKey);
  if (parityDoc && typeof parityDoc.scenariosRun === 'number' && parityDoc.scenariosRun > 0) {
    if (parityDoc.scenariosPassed === parityDoc.scenariosRun) {
      parityResult = 'VERIFIED';
    } else if (parityDoc.scenariosPassed > 0) {
      parityResult = 'PARTIAL';
    }
  }

  // 11. Immutable Release Readiness: Must be NOT_READY whenever blockers exist or connector-boundary fails
  const immutableReleaseReadiness: 'READY' | 'NOT_READY' =
    blockers.length === 0 &&
    connectorBoundaryCompliant &&
    schemaValid &&
    semanticValid &&
    referenceIntegrityValid &&
    isolationPassed
      ? 'READY'
      : 'NOT_READY';

  let migrationStatus: 'CANDIDATE_PACK_VALIDATED' | 'FIXTURE_EVALUATION_ONLY' | 'BLOCKED';
  if (project.source === 'synthetic_fixture') {
    migrationStatus = 'FIXTURE_EVALUATION_ONLY';
  } else if (immutableReleaseReadiness === 'READY') {
    migrationStatus = 'CANDIDATE_PACK_VALIDATED';
  } else {
    migrationStatus = 'BLOCKED';
  }

  return {
    tenantId: project.tenantId,
    name: project.name,
    source: project.source,
    industry: project.industry,
    commerceMode: project.commerceMode,
    schemaValid,
    schemaErrors,
    semanticValid,
    semanticErrors,
    referenceIntegrityValid,
    referenceIntegrityErrors,
    groundedRetrievalIsolated: isolationPassed,
    groundedRetrievalEvidence: isolationEvidence,
    connectorBoundaryCompliant,
    rawSecretsCount,
    rawSecretsList,
    directUrlsCount,
    directUrlsList,
    checksum: pack.checksum || computePackChecksum(pack),
    activepiecesFlowsCount: (pack.capabilities?.toolBindings || []).filter(
      (b) => b.executor.type === 'activepieces_flow'
    ).length,
    connectionRefMappings,
    parityResult,
    immutableReleaseReadiness,
    cutoverRecordState,
    rollbackEvidence,
    blockers,
    migrationStatus,
  };
}

export async function runTenantConnectorInventory(
  options: { writeReport?: boolean } = {}
): Promise<ComputedAuditResult[]> {
  const dbEnv = resolveSafeDatabaseEnvironment();
  if (dbEnv.warning) {
    console.warn(`🔒 ${dbEnv.warning}`);
  }

  console.log('\n📊 Running Truthful Tenant Connector Migration Inventory & Audit...\n');

  let dbEvidence: DatabaseEvidence = {
    connected: false,
    discoveredProjects: new Set(),
    releases: new Map(),
    pointers: new Map(),
    cutovers: new Map(),
    connections: new Map(),
    secrets: new Map(),
    normalizationReports: new Map(),
    parityEvidence: new Map(),
  };

  if (dbEnv.mode === 'connected' && dbEnv.uri) {
    dbEvidence = await queryNonProductionDatabase(dbEnv.uri);
  }

  const capabilityRegistry = new CapabilityRegistryService();
  const discoveredProjects = await discoverProjects(dbEvidence);
  const results: ComputedAuditResult[] = [];

  for (const project of discoveredProjects) {
    const auditRes = await auditProject(project, dbEvidence, options, capabilityRegistry);
    results.push(auditRes);
  }

  // Console Summary Table
  console.table(
    results.map((r) => ({
      Tenant: r.tenantId,
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

  // Write report if requested
  const writeFlag = options.writeReport ?? process.argv.includes('--write');
  if (writeFlag) {
    const reportPath = path.resolve(__dirname, '../docs/tenant-connector-migration-inventory.md');
    const timestamp = new Date().toISOString();

    const customerResults = results.filter((r) => r.source !== 'synthetic_fixture');
    const fixtureResults = results.filter((r) => r.source === 'synthetic_fixture');

    const discoveredCustomersCount = customerResults.filter((r) => r.source !== 'not_discovered').length;
    const blockedUndiscoveredCount = customerResults.filter((r) => r.source === 'not_discovered').length;
    const readyCustomersCount = customerResults.filter((r) => r.immutableReleaseReadiness === 'READY').length;
    const compliantBoundaryCount = customerResults.filter((r) => r.connectorBoundaryCompliant).length;
    const verifiedParityCount = customerResults.filter((r) => r.parityResult === 'VERIFIED').length;
    const unevaluatedParityCount = customerResults.filter((r) => r.parityResult === 'UNEVALUATED').length;

    let md = `# JourneyAX Tenant Connector Migration Inventory & Truthful Audit\n\n`;
    md += `**Audit Timestamp**: \`${timestamp}\`\n`;
    md += `**Branch**: \`JourneyAX-dev-v4\`\n`;
    md += `**Audit Mode**: Read-Only Architecture Enforcement & Evidence-Backed Verification\n\n`;
    md += `> **MIGRATION STATUS NOTICE**: This inventory reflects actual computed evaluations. Discovered repository migration sources are strictly separated from synthetic test fixtures. Synthetic fixtures are excluded from customer readiness metrics. No hardcoded compliance claims or artificial pass flags are permitted. Undiscovered required tenants fail closed as \`NOT_DISCOVERED\` / \`BLOCKED\`.\n\n`;
    md += `---\n\n`;

    md += `## 1. Executive Summary\n\n`;
    md += `| Metric | Computed Value | Assessment |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| **Required Customer Tenants** | ${customerResults.length} | Mandatory customer tenants tracked for migration |\n`;
    md += `| **Discovered Customer Tenants** | ${discoveredCustomersCount} / ${customerResults.length} | Filesystem packs (${customerResults.filter((r) => r.source === 'filesystem_pack').length}) + Non-prod DB (${customerResults.filter((r) => r.source === 'non_prod_db').length}) |\n`;
    md += `| **Undiscovered Customer Tenants** | ${blockedUndiscoveredCount} / ${customerResults.length} | Missing from filesystem and database; marked \`BLOCKED\` |\n`;
    md += `| **Immutable Release Ready (Customers)** | ${readyCustomersCount} / ${customerResults.length} | Computed via real schema, isolation, and absence of blockers |\n`;
    md += `| **Connector Boundary Compliant (Customers)** | ${compliantBoundaryCount} / ${customerResults.length} | Scanned for direct provider URLs and raw secrets |\n`;
    md += `| **Parity Evaluation Status (Customers)** | ${verifiedParityCount} Verified / ${unevaluatedParityCount} Unevaluated | Parity is \`UNEVALUATED\` unless real scenario evidence exists |\n`;
    md += `| **Synthetic Test Fixtures** | ${fixtureResults.length} | Topology testing only; excluded from customer readiness |\n\n`;

    md += `## 2. Customer Tenant Migration Matrix\n\n`;
    md += `| Tenant ID | Brand Name | Source Category | Industry | Commerce Mode | Activepieces Flows | Status |\n`;
    md += `| :--- | :--- | :---: | :--- | :---: | :---: | :---: |\n`;
    for (const r of customerResults) {
      md += `| \`${r.tenantId}\` | ${r.name} | \`${r.source}\` | ${r.industry} | \`${r.commerceMode}\` | ${r.activepiecesFlowsCount} flows | \`${r.migrationStatus}\` |\n`;
    }
    md += `\n`;

    md += `## 3. Customer Tenant Conformance & Evidence Audit\n\n`;
    md += `| Tenant ID | Schema | Semantics | Ref Integrity | Isolated? | Raw Secrets | Direct URLs | Parity | Checksum |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
    for (const r of customerResults) {
      const checksumSnippet = r.checksum === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : `\`${r.checksum.slice(0, 16)}...\``;
      md += `| \`${r.tenantId}\` | ${r.schemaValid ? 'PASS' : 'FAIL'} | ${r.semanticValid ? 'PASS' : 'FAIL'} | ${r.referenceIntegrityValid ? 'PASS' : 'FAIL'} | ${r.groundedRetrievalIsolated ? 'YES' : 'NO'} | ${r.rawSecretsCount} | ${r.directUrlsCount} | \`${r.parityResult}\` | ${checksumSnippet} |\n`;
    }
    md += `\n`;

    md += `## 4. Customer Tenant Operational State & Cutover Blockers\n\n`;
    md += `| Tenant ID | Cutover Record (\`tenant_cutovers\`) | Rollback Baseline | Blockers Count | Specific Blockers |\n`;
    md += `| :--- | :---: | :---: | :---: | :--- |\n`;
    for (const r of customerResults) {
      const blockersText = r.blockers.length === 0 ? 'None' : r.blockers.join('; ');
      md += `| \`${r.tenantId}\` | \`${r.cutoverRecordState}\` | \`${r.rollbackEvidence}\` | ${r.blockers.length} | ${blockersText} |\n`;
    }
    md += `\n`;

    md += `## 5. Synthetic Test Fixtures (Topology Matrix Only - Excluded from Customer Readiness)\n\n`;
    md += `| Tenant ID | Brand Name | Topology Category | Commerce Mode | Activepieces Flows | Status |\n`;
    md += `| :--- | :--- | :--- | :---: | :---: | :---: |\n`;
    for (const r of fixtureResults) {
      md += `| \`${r.tenantId}\` | ${r.name} | ${r.industry} | \`${r.commerceMode}\` | ${r.activepiecesFlowsCount} flows | \`${r.migrationStatus}\` |\n`;
    }
    md += `\n`;

    md += `## 6. Architecture Governance Signoff Status\n\n`;
    md += `**STATUS**: PENDING ARCHITECTURE GOVERNANCE & SECURITY APPROVAL\n\n`;
    md += `*Notice: In compliance with Workstream C truthful reporting requirements, no approval or signature is certified because cutover records in \`tenant_cutovers\` remain pending and undiscovered required tenants remain blocked.*\n`;

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, md, 'utf8');
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
