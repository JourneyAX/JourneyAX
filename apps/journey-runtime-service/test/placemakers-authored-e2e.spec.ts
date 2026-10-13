import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { applyAuthoring, buildServerOwnedOkfContent, buildTaxonomyDraft, publishOkfRelease } from '@journeyax/knowledge';
import { TurnApplicationService } from '../src/kernel/turn-application.service';
import { PackRepository } from '../src/kernel/pack.repository';
import { WorkspaceRepository } from '../src/kernel/workspace.repository';
import { WorkspaceStore } from '../src/workspace/workspace.store';
import { JourneyResolver } from '../src/kernel/journey.resolver';
import { ModelGateway, type ModelExecutionRequest, type ModelExecutionResponse } from '../src/kernel/model.gateway';
import { CapabilityGateway } from '../src/kernel/capability.gateway';
import { CatalogSearchHandler } from '../src/capabilities/handlers/catalog-search.handler';
import { ExecutionRepository } from '../src/kernel/execution.repository';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { PresentationPort } from '../src/kernel/presentation.port';
import { TurnInterpreter } from '../src/turn/interpret-event';
import { OutcomeValidator } from '../src/turn/validate-outcome';
import { OkfKnowledgeControlPlane } from '../src/kernel/knowledge-control-plane';
import { ProjectService } from '../../project-service/src/project.service';
import { OkfAuthoringService } from '../../project-service/src/okf-authoring.service';

/**
 * End to end, on real PlaceMakers inputs: the committed catalogue snapshot, the committed authoring proposal and the
 * committed catalogue mapping, published as an OKF release into an isolated store and run through the real turn service,
 * gate, catalogue handler, presentation port and basket policy. Only the language model is replaced by a fixed function.
 */
const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const ingest = read('scripts/okf/tenants/placemakers.ingest.json');
const authoringSpec = read('scripts/okf/tenants/placemakers.authoring.json');
const catalogMapping = read('docs/migrations/placemakers-catalog-mapping.json').catalogMapping;

const suite = createSuite('runtime: PlaceMakers authored knowledge, end to end');
const TENANT = 'placemakers';
const ENVIRONMENT = 'test';

// ── catalogue fixture, shaped like the real products collection (path, category, price in priceUSD.min, currency per product) ──
const pathOf = (category: string): string[] => {
  const row = snapshot.rows.find((entry: any) => entry.path.length > 0 && entry.path[entry.path.length - 1] === category);
  assert.ok(row, `the snapshot has a "${category}" category`);
  return row.path;
};
// Real PlaceMakers SKUs are numeric; tests refer to them by a readable code.
const SKU_OF: Record<string, string> = {};
const CODE_OF: Record<string, string> = {};
const register = (code: string): string => {
  if (!SKU_OF[code]) { SKU_OF[code] = String(1000100 + Object.keys(SKU_OF).length); CODE_OF[SKU_OF[code]] = code; }
  return SKU_OF[code];
};
const product = (code: string, name: string, category: string, price: number, extra: Record<string, unknown> = {}) => ({
  projectId: TENANT, sku: register(code), name, category, categoryPath: pathOf(category), priceUSD: { min: price }, currency: 'NZD', inStock: true, ...extra,
});
const products: any[] = [
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
  // Filed by category name only (no hierarchy path), as 14 of the real categories are.
  { projectId: TENANT, sku: register('LP-1'), name: 'Laundry tap set', category: 'Laundry Tapware & Plumbing', priceUSD: { min: 55 }, currency: 'NZD', inStock: true },
  // A same-named category in another department must never be pulled in by the bathroom/tools scopes.
  { projectId: TENANT, sku: register('PL-X'), name: 'Garden plumbing fitting', category: 'Plumbing', categoryPath: ['Outdoor & Landscaping', 'Plumbing'], priceUSD: { min: 6 }, currency: 'NZD', inStock: true },
  { projectId: 'someone-else', sku: register('FOREIGN-1'), name: 'Another tenant wood screw', category: 'Wood Screws', categoryPath: pathOf('Wood Screws'), priceUSD: { min: 1 }, currency: 'NZD' },
];

/** Stands in for the language model: a fixed function of the message, so the run is repeatable. */
class FixedGateway extends ModelGateway {
  async execute(_release: any, request: ModelExecutionRequest): Promise<ModelExecutionResponse> {
    let content = 'Here are options from the catalogue.';
    if (request.taskType === 'fast_intent' && request.prompt.includes('<customer_message>')) {
      const message = request.prompt.match(/<customer_message>\s*([\s\S]*?)\s*<\/customer_message>/i)?.[1]?.trim().toLowerCase() || '';
      const candidateFacts: Record<string, any> = {};
      if (message.includes('composite')) candidateFacts.deck_material = { value: 'composite', confidence: 1 };
      if (message.includes('4x3')) candidateFacts.deck_size = { value: '4x3 m', confidence: 1 };
      if (message.includes('timber screws')) candidateFacts.fastener_substrate = { value: 'timber', confidence: 1 };
      content = JSON.stringify({ intent: 'product_search', candidateFacts });
    }
    return {
      content, route: { policyId: request.taskType, provider: 'custom', model: 'fixed-test-model', dataResidency: 'test', timeoutMs: 1000 },
      latencyMs: 1, residencyProven: true, residencyEvidence: 'isolated-test-adapter',
    };
  }
}

/**
 * The project as the back office holds it: a visual journey graph (one trigger per journey, named as the live pack's are),
 * the catalogue mapping, and the AI settings. The pack is produced by the real publisher, never assembled by hand.
 */
function projectDoc() {
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

const cards = (result: any, component: string) => (result.uiInstructions || []).filter((entry: any) => entry.component === component);
const skusOf = (card: any) => (card?.props?.products || []).map((entry: any) => CODE_OF[entry.sku] ?? entry.sku).sort();
const suggestionSkus = (card: any) => (card?.props?.groups || []).flatMap((group: any) => group.items.map((item: any) => CODE_OF[item.sku] ?? item.sku)).sort();
const retrieved = (result: any) => (result.executedCapabilities || []).some((entry: any) => entry.toolId === 'catalog.search');

async function main() {
  const authored = applyAuthoring(buildTaxonomyDraft(snapshot, ingest), authoringSpec);
  assert.deepEqual(authored.errors, []);
  const content = buildServerOwnedOkfContent(authored.draft, { tenantId: TENANT, environmentId: ENVIRONMENT, releaseId: 'okf-pm-authored', evaluatedAt: snapshot.snapshotAt });
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
  // Draft → immutable OKF release → attached to the project → Business Pack, exactly as the back office does it.
  const authoring = new OkfAuthoringService(async () => db as any, (pid, update) => projects.updateProject(pid, update as any));
  const saved = await authoring.saveDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: 0, content: authored.draft, updatedBy: 'process:test' });
  assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation.issues.slice(0, 3)));
  const okf: any = await authoring.publishDraft({ projectId: TENANT, environmentId: ENVIRONMENT, expectedRevision: saved.revision, version: '1.0.0', publishedBy: 'human:reviewer' });
  const publication: any = await projects.publishConfig(TENANT, { environmentId: ENVIRONMENT, publishedBy: 'human:reviewer' });
  assert.equal(publication.success, true, publication.message);
  const pack: any = db.dump('business_pack_releases').at(-1);
  const reference = pack.knowledgeModel;
  assert.equal(reference.checksum, okf.release.checksum, 'the pack is bound to the exact checksum of the published release');
  assert.equal(reference.required, true);

  const serviceFor = (pack: any) => {
    const modelGateway = new FixedGateway();
    const capabilityGateway = new CapabilityGateway();
    capabilityGateway.registerCustomAdapter('catalog.search', new CatalogSearchHandler(undefined, async () => db as any));
    void pack;
    return new TurnApplicationService(
      new PackRepository(), new WorkspaceRepository(new WorkspaceStore({ forceInMemory: true })), new JourneyResolver(), undefined,
      modelGateway, capabilityGateway, undefined, new ExecutionRepository(), new OutboxRepository({ forceInMemory: true }),
      new PresentationPort(modelGateway), new TurnInterpreter(modelGateway), undefined, new OutcomeValidator(),
      new OkfKnowledgeControlPlane(async () => db as any),
    );
  };
  const service = serviceFor(pack);
  const run = (workspaceId: string, message: string, n = 1) => {
    // The turn service resolves the active pack from the repository; hand it this pack directly, as the cutover gate does.
    return (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId, sessionId: workspaceId, turnId: `${workspaceId}-t${n}`, correlationId: `${workspaceId}-c${n}`, message,
    }, pack) as Promise<any>;
  };

  await suite.test('"wood screws": only wood-screw products, then unverified "Have you considered?" with live products', async () => {
    const result = await run('ws-wood-screws', 'wood screws');
    assert.equal(result.trace.knowledgeGate.mode, 'direct_results');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['WS-1', 'WS-2'], 'path scope: no metal screws, anchors or another tenant\'s product');
    const suggestion = cards(result, 'accessories')[0];
    assert.ok(suggestion, 'the cross-sell card is shown next to real results');
    assert.equal(suggestion.props.heading, 'Have you considered?');
    assert.match(suggestion.props.note, /not confirmed/i);
    assert.deepEqual(suggestionSkus(suggestion), ['DB-1', 'DB-2', 'SB-1'], 'live products from the suggested categories');
    assert.deepEqual(suggestion.props.groups.map((group: any) => group.label), ['Drill Bits', 'Screwdriver Bits']);
    assert.ok(!suggestion.props.groups.some((group: any) => ['required', 'recommended'].includes(group.key)), 'never presented as required or recommended');
  });

  await suite.test('"vanities": bathroom products only, with tapware and mirrors suggested; nothing from other departments', async () => {
    const result = await run('ws-vanities', 'vanities');
    assert.deepEqual(skusOf(cards(result, 'products')[0]), ['VN-1', 'VN-2']);
    assert.deepEqual(suggestionSkus(cards(result, 'accessories')[0]), ['MR-1', 'TW-1']);
    const everyShown = [...skusOf(cards(result, 'products')[0]), ...suggestionSkus(cards(result, 'accessories')[0])];
    assert.ok(!everyShown.includes('PL-X') && !everyShown.includes('FOREIGN-1'));
  });

  await suite.test('"screws": a grouped overview from the family members, with the merchant\'s question as the last card', async () => {
    const result = await run('ws-screws', 'screws');
    assert.equal(result.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.ok(result.trace.knowledgeGate.retrieval.categoryPaths.length >= 3);
    const shown = skusOf(cards(result, 'products')[0]);
    assert.ok(['WS-1', 'MS-1', 'MA-1'].every((sku) => shown.includes(sku)), `examples from each member category: ${shown}`);
    assert.ok(!shown.includes('FOREIGN-1'));
    const order = (result.uiInstructions as any[]).map((entry) => entry.component);
    assert.equal(order[order.length - 1], 'clarify', 'the question is the customer\'s next step');
    assert.equal(cards(result, 'clarify')[0].props.questions[0].id, 'fastener_substrate');
  });

  await suite.test('a project is served by the gate: question first, then a grouped overview of its categories', async () => {
    const first = await run('ws-deck', 'i want to build a deck');
    assert.equal(first.trace.knowledgeGate.mode, 'overview_then_ask');
    assert.equal(first.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/deck-build');
    assert.equal(cards(first, 'clarify')[0].props.questions[0].id, 'deck_material');
    const second = await run('ws-deck', 'composite and 4x3 m', 2);
    assert.equal(second.trace.knowledgeGate.conceptId, 'concept://placemakers/projects/deck-build');
    const shown = skusOf(cards(second, 'products')[0]);
    assert.ok(shown.includes('CD-1'), `decking boards from the project's categories: ${shown}`);
    assert.deepEqual(suggestionSkus(cards(second, 'accessories')[0]), ['OC-1', 'WC-1', 'WS-1', 'WS-2'], 'wood screws, woodcare and outdoor cleaners are suggested for the deck');
  });

  await suite.test('problems escalate: no retrieval, no cards of products, no cross-sell, no invented advice', async () => {
    for (const [message, label] of [['my bathroom is leaking', 'bathroom leak'], ['there is a gas leak', 'gas'], ['my heater is smoking', 'uncovered hazard'], ['water near power points', 'electrical']]) {
      const result = await run(`ws-problem-${label.replace(/\W/g, '')}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'safety_then_diagnose', message);
      assert.equal(retrieved(result), false, `${message}: no catalogue call`);
      assert.equal(cards(result, 'products').length + cards(result, 'accessories').length, 0, `${message}: no product or cross-sell card`);
      assert.match(String(result.assistantMessage), /qualified|professional|tradesperson|licensed|emergency/i, `${message}: a professional is named`);
    }
  });

  await suite.test('installation, warranty and care questions fail safely: nothing retrieved, nothing shown, nothing claimed', async () => {
    for (const message of ['how do i install a vanity', 'what is the warranty on this vanity', 'clean my deck']) {
      const result = await run(`ws-evidence-${message.length}`, message);
      assert.equal(result.trace.knowledgeGate.mode, 'evidence_answer', message);
      assert.equal(retrieved(result), false, message);
      assert.equal(cards(result, 'products').length + cards(result, 'accessories').length + cards(result, 'guide').length + cards(result, 'warranty').length, 0, message);
    }
  });

  await suite.test('an exact SKU resolves in the tenant catalogue only', async () => {
    const result = await run('ws-sku', `SKU ${SKU_OF['HM-1']}`);
    assert.equal(result.trace.knowledgeGate.mode, 'direct_results');
    assert.ok(skusOf(cards(result, 'products')[0]).includes('HM-1'));
    const foreign = await run('ws-sku-foreign', `SKU ${SKU_OF['FOREIGN-1']}`);
    assert.ok(!skusOf(cards(foreign, 'products')[0]).includes('FOREIGN-1'), 'another tenant\'s SKU is never shown');
  });

  await suite.test('a concept the release does not cover is never answered from the catalogue by default', async () => {
    for (const message of ['do you sell flux capacitors', 'is the flux capacitor rated for a load bearing span']) {
      const result = await run(`ws-unmatched-${message.length}`, message);
      assert.equal(retrieved(result), false, message);
      assert.equal(cards(result, 'products').length, 0, message);
      assert.ok(!['direct_results', 'overview_then_ask', 'legacy_search'].includes(result.trace.knowledgeGate.mode), `${message}: ${result.trace.knowledgeGate.mode}`);
    }
  });

  await suite.test('a suitability question about something we list shows the listing and says plainly that nothing verified supports the claim', async () => {
    const result = await run('ws-technical', 'is this wood screw suitable for a load bearing beam');
    const gate = result.trace.knowledgeGate;
    assert.ok(gate.trace.reasonCodes.includes('technical_requirement_unverified'));
    assert.ok(!gate.claims.allowedClasses.some((claim: string) => ['compatibility', 'requirement', 'substitution', 'safety_instruction'].includes(claim)));
    assert.match(String(result.assistantMessage), /can't confirm technical suitability/, 'the statement is in the message the customer reads, not left to the model');
    assert.ok(skusOf(cards(result, 'products')[0]).length > 0, 'the listing itself is still useful and asserts nothing');
  });

  await suite.test('a request that only partly matches asks the department question; it never claims the unmatched part exists', async () => {
    const result = await run('ws-partial', 'do you sell garden gnomes');
    const gate = result.trace.knowledgeGate;
    assert.equal(gate.mode, 'overview_then_ask');
    assert.equal(gate.conceptId, 'concept://placemakers/outdoor-and-landscaping/garden-and-landscaping');
    assert.deepEqual(gate.claims.allowedClasses.filter((claim: string) => !['catalog_fact', 'suggestion'].includes(claim)), []);
    assert.ok(cards(result, 'clarify').length === 1, 'the department question is asked');
  });

  await suite.test('catalogue-only fallback is an explicit release decision, shows live facts only, and carries no claim', async () => {
    const optedIn = structuredClone(content) as any;
    optedIn.policy = { ...(optedIn.policy || {}), coverage: { uncoveredShopping: { mode: 'catalogue_only', commerce: { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' } } } };
    const optedRelease = await publishOkfRelease(db as any, {
      releaseId: 'okf-pm-catalogue-only', tenantId: TENANT, environmentId: ENVIRONMENT, version: '1.0.1', content: optedIn, publishedBy: 'human:test',
    });
    const optedPack = { ...structuredClone(pack), knowledgeModel: { ...reference, releaseId: optedRelease.releaseId, version: optedRelease.version, checksum: optedRelease.checksum } };
    const result = await (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-opt-in', sessionId: 'ws-opt-in', turnId: 't1', correlationId: 'c1', message: 'garden plumbing fitting',
    }, optedPack);
    const gate = result.trace.knowledgeGate;
    if (gate.mode === 'legacy_search') {
      assert.ok(gate.trace.reasonCodes.includes('uncovered_shopping_catalogue_only'));
      assert.deepEqual(gate.claims.allowedClasses, ['catalog_fact']);
      assert.deepEqual(gate.commerce, { addToCart: 'allowed_with_warning', checkout: 'requires_compatibility_resolution' });
    } else {
      assert.notEqual(gate.mode, 'direct_results', 'a covered answer would have to come from a concept, not from the fallback');
    }
  });

  await suite.test('basket: the strictest governing concept decides, paths keep same-named categories apart, path-less products are still governed', async () => {
    const plane = new OkfKnowledgeControlPlane(async () => db as any);
    const command = { tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'basket', sessionId: 'basket', correlationId: 'basket', message: 'add to cart' } as any;
    const basket = (...skus: string[]) => plane.evaluateBasket(pack, command, null, skus.map((code) => ({ sku: SKU_OF[code] ?? code })));
    assert.deepEqual((await basket('HM-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' });
    assert.equal((await basket('SW-1'))?.commerce.checkout, 'requires_professional_confirmation', 'switchgear needs a qualified professional');
    assert.equal((await basket('HM-1', 'SW-1'))?.commerce.checkout, 'requires_professional_confirmation');
    assert.deepEqual((await basket('WS-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' }, 'the screws family states compatibility as a disclaimer; its commerce ceiling is the merchant\'s call');
    assert.deepEqual((await basket('LP-1'))?.commerce, { addToCart: 'allowed', checkout: 'allowed' }, 'a product filed by category name only is governed by its concept');
    assert.deepEqual((await basket('NOPE'))?.commerce, { addToCart: 'blocked', checkout: 'blocked' }, 'an unknown SKU is blocked');
    assert.deepEqual((await basket('FOREIGN-1'))?.commerce, { addToCart: 'blocked', checkout: 'blocked' }, 'another tenant\'s SKU is blocked');
    // A "Plumbing" in the Outdoor department is covered by the Outdoor hierarchy, not by the bathroom or tools "Plumbing".
    const stray = await basket('PL-X');
    assert.ok(!stray?.reasonCodes.includes('missing_catalog_sku'));
  });

  await suite.test('the release was published checksum-bound, and a different checksum cannot be used by the pack', async () => {
    const tampered = { ...structuredClone(pack), knowledgeModel: { ...reference, checksum: 'f'.repeat(64) } };
    const result = await (service as any).executeTurn({
      tenantId: TENANT, environmentId: ENVIRONMENT, workspaceId: 'ws-tamper', sessionId: 'ws-tamper', turnId: 't1', correlationId: 'c1', message: 'wood screws',
    }, tampered);
    assert.equal(retrieved(result), false, 'a required release that fails verification fails closed');
    assert.equal(cards(result, 'products').length, 0);
  });

}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
