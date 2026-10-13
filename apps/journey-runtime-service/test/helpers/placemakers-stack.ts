import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb } from '@journeyax/test-support';
import { applyAuthoring, attachAcceptanceScenarios, buildServerOwnedOkfContent, buildTaxonomyDraft } from '@journeyax/knowledge';
import { TurnApplicationService } from '../../src/kernel/turn-application.service';
import { PackRepository } from '../../src/kernel/pack.repository';
import { WorkspaceRepository } from '../../src/kernel/workspace.repository';
import { WorkspaceStore } from '../../src/workspace/workspace.store';
import { JourneyResolver } from '../../src/kernel/journey.resolver';
import { ModelGateway, type ModelExecutionRequest, type ModelExecutionResponse } from '../../src/kernel/model.gateway';
import { CapabilityGateway } from '../../src/kernel/capability.gateway';
import { CatalogSearchHandler } from '../../src/capabilities/handlers/catalog-search.handler';
import { ExecutionRepository } from '../../src/kernel/execution.repository';
import { OutboxRepository } from '../../src/kernel/outbox.repository';
import { PresentationPort } from '../../src/kernel/presentation.port';
import { TurnInterpreter } from '../../src/turn/interpret-event';
import { OutcomeValidator } from '../../src/turn/validate-outcome';
import { OkfKnowledgeControlPlane } from '../../src/kernel/knowledge-control-plane';
import { ProjectService } from '../../../project-service/src/project.service';
import { OkfAuthoringService } from '../../../project-service/src/okf-authoring.service';

/**
 * The real PlaceMakers inputs, published through the real chain, for tests that run the runtime on them: the committed catalogue
 * snapshot, authoring proposal, customer-path scenarios and catalogue mapping, an isolated store, and a language model replaced by a
 * fixed function. Nothing here touches a cluster.
 */
const root = path.resolve(__dirname, '../../../..');
export const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
export const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const ingest = read('scripts/okf/tenants/placemakers.ingest.json');
const authoringSpec = read('scripts/okf/tenants/placemakers.authoring.json');
const scenarioFile = read('scripts/okf/tenants/placemakers.scenarios.json');
export const catalogMapping = read('docs/migrations/placemakers-catalog-mapping.json').catalogMapping;
export const TENANT = 'placemakers';
export const ENVIRONMENT = 'test';

// ── catalogue fixture, shaped like the real products collection (path, category, price in priceUSD.min, currency per product) ──
const pathOf = (category: string): string[] => {
  const row = snapshot.rows.find((entry: any) => entry.path.length > 0 && entry.path[entry.path.length - 1] === category);
  assert.ok(row, `the snapshot has a "${category}" category`);
  return row.path;
};
// Real PlaceMakers SKUs are numeric; tests refer to them by a readable code.
export const SKU_OF: Record<string, string> = {};
export const CODE_OF: Record<string, string> = {};
const register = (code: string): string => {
  if (!SKU_OF[code]) { SKU_OF[code] = String(1000100 + Object.keys(SKU_OF).length); CODE_OF[SKU_OF[code]] = code; }
  return SKU_OF[code];
};
const product = (code: string, name: string, category: string, price: number, extra: Record<string, unknown> = {}) => ({
  projectId: TENANT, sku: register(code), name, category, categoryPath: pathOf(category), priceUSD: { min: price }, currency: 'NZD', inStock: true, ...extra,
});
export const products: any[] = [
  product('WS-1', 'Exterior wood screw 8g x 50mm', 'Wood Screws', 12.5),
  product('WS-2', 'Decking screw 10g x 65mm', 'Wood Screws', 18),
  product('MS-1', 'Self drilling metal screw', 'Metal Screws', 9),
  product('MA-1', 'Concrete anchor 6mm', 'Masonry  Anchors', 21),
  product('DB-1', 'HSS drill bit set', 'Drill Bits', 30),
  product('DB-2', 'Masonry drill bit', 'Drill Bits', 8),
  product('SB-1', 'Screwdriver bit set', 'Screwdriver Bits', 14),
  product('VN-1', 'Vanity unit 750mm', 'Vanities', 499),
  product('VN-2', 'Wall hung vanity 600mm', 'Vanities', 399),
  product('TW-1', 'Basin mixer', 'Tapware & Showering', 89),
  product('MR-1', 'LED bathroom mirror', 'Mirrors', 129),
  product('SW-1', 'Main switchboard 12 way', 'Switchgear', 340),
  product('HM-1', 'Claw hammer 16oz', 'Hammers & Mallets', 25),
  product('CD-1', 'Composite decking board 140mm', 'Composite Decking', 62),
  product('WC-1', 'Decking oil 4L', 'Woodcare', 76),
  product('OC-1', 'Deck wash 2L', 'Outdoor Cleaners', 24),
  product('DR-1', 'Cordless drill 18V', 'Drills', 189),
  product('IP-1', 'Interior wall paint 4L', 'Interior Paint', 89),
  product('BR-1', 'Paint roller kit', 'Brushes & Rollers', 24),
  product('MK-1', 'Masking tape 36mm', 'Masking', 6),
  // Filed by category name only (no hierarchy path), as 14 of the real categories are.
  { projectId: TENANT, sku: register('LP-1'), name: 'Laundry tap set', category: 'Laundry Tapware & Plumbing', priceUSD: { min: 55 }, currency: 'NZD', inStock: true },
  // A same-named category in another department must never be pulled in by the bathroom/tools scopes.
  { projectId: TENANT, sku: register('PL-X'), name: 'Garden plumbing fitting', category: 'Plumbing', categoryPath: ['Outdoor & Landscaping', 'Plumbing'], priceUSD: { min: 6 }, currency: 'NZD', inStock: true },
  { projectId: 'someone-else', sku: register('FOREIGN-1'), name: 'Another tenant wood screw', category: 'Wood Screws', categoryPath: pathOf('Wood Screws'), priceUSD: { min: 1 }, currency: 'NZD' },
];

/** Stands in for the language model: a fixed function of the message, so the run is repeatable. */
export class FixedGateway extends ModelGateway {
  async execute(_release: any, request: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    let content = 'Here are options from the catalogue.';
    if (request.taskType === 'fast_intent' && request.prompt.includes('<customer_message>')) {
      const message = request.prompt.match(/<customer_message>\s*([\s\S]*?)\s*<\/customer_message>/i)?.[1]?.trim().toLowerCase() || '';
      const candidateFacts: Record<string, any> = {};
      if (message.includes('composite')) candidateFacts.deck_material = { value: 'composite', confidence: 1 };
      if (message.includes('4x3')) candidateFacts.deck_size = { value: '4x3 m', confidence: 1 };
      if (message.includes('timber screws')) candidateFacts.fastener_substrate = { value: 'timber', confidence: 1 };
      if (message === 'renovation') candidateFacts.project_scope = { value: 'renovation', confidence: 1 };
      content = JSON.stringify({ intent: 'product_search', candidateFacts });
    }
    return {
      content, route: { policyId: request.taskType, provider: 'custom', model: 'fixed-test-model', dataResidency: 'test', timeoutMs: 1000, maxInputTokens: 4096, maxOutputTokens: 1024 },
      latencyMs: 1, residencyProven: true, residencyEvidence: 'isolated-test-adapter',
    };
  }
}

/**
 * The project as the back office holds it: a visual journey graph (one trigger per journey, named as the live pack's are),
 * the catalogue mapping, and the AI settings. The pack is produced by the real publisher, never assembled by hand.
 */
export function projectDoc() {
  const trigger = (id: string, label: string) => ({ id: `t-${id}`, data: { kind: 'trigger.intent', stageId: `${id}_start`, label } });
  return {
    projectId: TENANT, name: 'PlaceMakers', companyName: 'PlaceMakers', ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 }, profile: { primaryLocale: 'en-NZ' }, catalogMapping,
    routingPolicy: { defaultJourneyId: 'placemakers_shop', fallbackOnCatalogSearch: true },
    persona: {
      systemName: 'PlaceMakers assistant', systemPromptOverrides: 'Help customers find products.',
      journeyGraph: {
        nodes: [
          trigger('shop', 'Shop'),
          { id: 'n-catalogue', data: { kind: 'tool.search', stageId: 'catalogue', label: 'Catalogue', capabilityId: 'catalog.search' } },
          trigger('plan', 'Plan your space'), trigger('services', 'Services'), trigger('guides', 'Tools & Guides'), trigger('support', 'Customer Service'),
        ],
        edges: [{ id: 'e-shop', source: 't-shop', target: 'n-catalogue' }],
      },
    },
  };
}


export interface PlaceMakersStack {
  db: MemoryDb;
  /** The project service over the same store: publish, rollback and history behave exactly as in the back office. */
  projects: ProjectService;
  pack: any;
  reference: any;
  content: any;
  okf: any;
  authored: ReturnType<typeof applyAuthoring>;
  /** `servePacks: true` loads the active pack through the real repository and loader (checksum-verified) instead of being handed one. */
  serviceFor: (options?: { servePacks?: boolean }) => TurnApplicationService;
}

/** Draft + customer paths → immutable OKF release → project → Business Pack, exactly as the back office does it. */
export async function buildPlaceMakersStack(options: { environmentId?: 'dev' | 'test' | 'staging' | 'production' } = {}): Promise<PlaceMakersStack> {
  // Always an isolated in-memory store; `production` only names the environment inside it (the one a customer's request defaults to).
  const ENVIRONMENT = options.environmentId ?? 'test';
  const authored = applyAuthoring(buildTaxonomyDraft(snapshot, ingest), authoringSpec);
  assert.deepEqual(authored.errors, []);
  const attached = attachAcceptanceScenarios(authored.draft, scenarioFile);
  assert.deepEqual(attached.errors, []);
  const draft: any = { ...authored.draft, acceptanceScenarios: attached.scenarios };
  const content = buildServerOwnedOkfContent(draft, { tenantId: TENANT, environmentId: ENVIRONMENT, releaseId: 'okf-pm-authored', evaluatedAt: snapshot.snapshotAt });
  const db = new MemoryDb();
  await db.collection('products').insertMany(products.map((entry) => ({ ...entry })));
  for (const [name, spec] of [['business_pack_releases', { tenantId: 1, environmentId: 1, version: 1 }], ['config_versions', { projectId: 1, version: 1 }]] as const) {
    await db.collection(name).createIndex(spec as any, { unique: true });
  }
  await db.collection('tenant_configs').insertOne(projectDoc());
  const projects = new ProjectService();
  Object.assign(projects as any, {
    db, projectsCol: db.collection('tenant_configs'), membersCol: db.collection('project_members'), rulesCol: db.collection('business_rules'),
    versionsCol: db.collection('config_versions'), isConnected: true,
  });
  const authoring = new OkfAuthoringService(async () => db as any, (pid, update) => projects.updateProject(pid, update as any));
  const saved = await authoring.saveDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: 0, content: draft, updatedBy: 'process:test' });
  assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues.slice(0, 3)));
  const okf: any = await authoring.publishDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
  const publication: any = await projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: 'human:reviewer' });
  assert.equal(publication.success, true, publication.message);
  const pack: any = db.dump('business_pack_releases').at(-1);
  assert.equal(pack.knowledgeModel.checksum, okf.release.checksum, 'the pack is bound to the exact checksum of the published release');
  assert.equal(pack.knowledgeModel.required, true);

  const serviceFor = (options: { servePacks?: boolean } = {}) => {
    const modelGateway = new FixedGateway();
    const capabilityGateway = new CapabilityGateway();
    capabilityGateway.registerCustomAdapter('catalog.search', new CatalogSearchHandler(undefined, async () => db as any));
    return new TurnApplicationService(
      options.servePacks ? new PackRepository(db) : new PackRepository(), new WorkspaceRepository(new WorkspaceStore({ forceInMemory: true })), new JourneyResolver(), undefined,
      modelGateway, capabilityGateway, undefined, new ExecutionRepository(), new OutboxRepository({ forceInMemory: true }),
      new PresentationPort(modelGateway), new TurnInterpreter(modelGateway), undefined, new OutcomeValidator(),
      new OkfKnowledgeControlPlane(async () => db as any),
    );
  };
  return { db, projects, pack, reference: pack.knowledgeModel, content, okf, authored, serviceFor };
}
