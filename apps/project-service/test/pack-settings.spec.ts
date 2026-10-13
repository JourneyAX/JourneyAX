import assert from 'node:assert/strict';
import { MemoryDb, createSuite } from '@journeyax/test-support';
import { isComponentCategoryCompatible, resolveCatalogMapping } from '@journeyax/business-pack';
import { ProjectService } from '../src/project.service';
import { validatePackSettings } from '../src/pack-settings';
import { OkfAuthoringService } from '../src/okf-authoring.service';
import { buildOkfContent } from '../../../packages/knowledge/test/fixtures';

const suite = createSuite('project-service: tenant pack settings');
const TENANT = 'placemakers';

async function createService(extra: Record<string, unknown> = {}) {
  const db = new MemoryDb();
  await db.collection('business_pack_releases').createIndex({ tenantId: 1, environmentId: 1, version: 1 } as any, { unique: true });
  await db.collection('config_versions').createIndex({ projectId: 1, version: 1 } as any, { unique: true });
  await db.collection('tenant_configs').insertOne({
    projectId: TENANT, name: 'T', companyName: 'T Ltd', pricing: { currency: 'NZD', symbol: '$', taxRate: 0.15, discountRate: 0 }, ai: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    persona: {
      systemName: 'Agent', systemPromptOverrides: 'Guide.',
      journeyGraph: {
        nodes: [
          { id: 'n1', data: { kind: 'trigger.intent', stageId: 'intake', label: 'Intake' } },
          { id: 'n2', data: { kind: 'stage.scoping', stageId: 'recommend', label: 'Recommend', allowedCapabilities: ['catalog_search'] } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    },
    ...extra,
  });
  const service = new ProjectService();
  (service as any).db = db;
  (service as any).projectsCol = db.collection('tenant_configs');
  (service as any).membersCol = db.collection('project_members');
  (service as any).rulesCol = db.collection('business_rules');
  (service as any).versionsCol = db.collection('config_versions');
  (service as any).isConnected = true;
  return { service, db };
}

async function main() {
  await suite.test('catalogMapping is validated and normalised before storage', () => {
    assert.equal(validatePackSettings({ catalogMapping: { searchPaths: ['$where'] } }).ok, false);
    assert.equal(validatePackSettings({ catalogMapping: { surprise: true } }).ok, false);
    const ok: any = validatePackSettings({ catalogMapping: { candidateLimit: 50 } });
    assert.equal(ok.ok, true);
    assert.equal(ok.set.catalogMapping.candidateLimit, 50);
    assert.deepEqual((validatePackSettings({ catalogMapping: null }) as any).set, { catalogMapping: null });
  });

  await suite.test('interpretation and pin policies are validated and mapped to extensions', () => {
    assert.equal(validatePackSettings({ interpretationPolicy: { nope: 1 } }).ok, false);
    assert.equal(validatePackSettings({ interpretationPolicy: { promptRules: [''] } }).ok, false);
    assert.equal(validatePackSettings({ interpretationPolicy: { money: { symbols: 'x' } } }).ok, false);
    assert.equal(validatePackSettings({ workspacePinPolicy: { idleRepinAfterHours: 0 } }).ok, false);
    assert.equal(validatePackSettings({ workspacePinPolicy: { idleRepinAfterHours: 24 } }).ok, true);
    const set: any = (validatePackSettings({ interpretationPolicy: { money: { symbols: ['€'] } }, workspacePinPolicy: null }) as any).set;
    assert.deepEqual(Object.keys(set).sort(), ['extensions.interpretationPolicy', 'extensions.workspacePinPolicy']);
    assert.equal(set['extensions.workspacePinPolicy'], null);
  });

  await suite.test('updateProject stores valid settings, rejects invalid ones and removes with null', async () => {
    const { service, db } = await createService();
    const bad = await service.updateProject(TENANT, { catalogMapping: { searchPaths: ['$where'] } } as any);
    assert.equal(bad.success, false);
    assert.match(bad.message || '', /Invalid catalogMapping/);
    assert.equal(db.dump('tenant_configs')[0].catalogMapping, undefined);
    const ok = await service.updateProject(TENANT, {
      catalogMapping: { pricing: { sources: [{ path: 'priceUSD', rangeKey: 'min', unit: 'major', currency: 'USD' }] } },
      workspacePinPolicy: { idleRepinAfterHours: 12 },
    } as any);
    assert.equal(ok.success, true, ok.message);
    const stored = db.dump('tenant_configs')[0];
    assert.equal(stored.catalogMapping.pricing.sources[0].currency, 'USD');
    assert.equal(stored.extensions.workspacePinPolicy.idleRepinAfterHours, 12);
    await service.updateProject(TENANT, { catalogMapping: null } as any);
    assert.equal(db.dump('tenant_configs')[0].catalogMapping, undefined);
  });

  await suite.test('publication carries the mapping and merges extensions with the space planner', async () => {
    const { service, db } = await createService({
      catalogMapping: { candidateLimit: 77 },
      extensions: { workspacePinPolicy: { idleRepinAfterHours: 6 } },
    });
    const result: any = await service.publishConfig(TENANT, { publishedBy: 'human:alice' });
    assert.equal(result.success, true, result.message);
    const release = db.dump('business_pack_releases')[0];
    assert.equal(release.catalogMapping.candidateLimit, 77);
    assert.equal(release.extensions.workspacePinPolicy.idleRepinAfterHours, 6);
  });

  await suite.test('regression: an empty cardTemplates object does not silence every card at runtime', async () => {
    const { service, db } = await createService({ cardTemplates: {} });
    const result: any = await service.publishConfig(TENANT, { publishedBy: 'human:alice' });
    assert.equal(result.success, true, result.message);
    const cards = db.dump('business_pack_releases')[0].experience.cards;
    assert.ok(cards.allowedCardTypes.length > 0, 'an empty allow-list would suppress products, clarify, quote and every other card');
    assert.ok(cards.allowedCardTypes.includes('products') && cards.allowedCardTypes.includes('clarify'));
    const narrowed = await createService({ cardTemplates: { products: { type: 'x' } } });
    await narrowed.service.publishConfig(TENANT, { publishedBy: 'human:alice' });
    assert.deepEqual(narrowed.db.dump('business_pack_releases')[0].experience.cards.allowedCardTypes, ['products'], 'a real override still narrows the set');
  });

  await suite.test('component category rules are tenant data: deny wins, allow narrows, no rule means unconstrained', () => {
    const rules = resolveCatalogMapping({ componentCategoryRules: {
      lining: { allow: ['plasterboard', 'lining'] },
      base: { deny: ['specialist board'], allow: ['cabinet', 'vanit'] },
    } }).componentCategoryRules;
    assert.equal(isComponentCategoryCompatible('lining', 'Interior Plasterboard', rules), true);
    assert.equal(isComponentCategoryCompatible('lining', 'Tapware', rules), false);
    assert.equal(isComponentCategoryCompatible('BASE', 'Specialist Board cabinet', rules), false);
    assert.equal(isComponentCategoryCompatible('base', 'Vanity units', rules), true);
    assert.equal(isComponentCategoryCompatible('overhead', 'anything', rules), true);
    assert.equal(isComponentCategoryCompatible('lining', '', rules), true);
    assert.equal(isComponentCategoryCompatible('lining', 'Tapware', {}), true, 'no rules → not constrained');
  });

  await suite.test('space planner integrity uses the pack mapping rules, not built-in category lists', async () => {
    const { service, db } = await createService();
    await db.collection('products').insertMany([
      { tenantId: TENANT, sku: '100001', category: 'Interior Plasterboard' },
      { tenantId: TENANT, sku: '100002', category: 'Tapware' },
    ] as any);
    const planner = { componentReferences: [{ sku: '100001', category: 'lining' }, { sku: '100002', category: 'lining' }] };
    const publication: any = service.getPublicationService();
    const rules = { componentCategoryRules: { lining: { allow: ['plasterboard', 'lining'] } } };

    const constrained = await publication.validateSpacePlannerCatalogueIntegrity(TENANT, planner, rules);
    assert.equal(constrained.valid, false);
    assert.match(constrained.error, /Semantic category mismatch for SKU '100002'/);

    const unconstrained = await publication.validateSpacePlannerCatalogueIntegrity(TENANT, planner, undefined);
    assert.equal(unconstrained.valid, true, 'without tenant rules nothing is assumed about category semantics');

    const missing = await publication.validateSpacePlannerCatalogueIntegrity(TENANT, { componentReferences: [{ sku: '999999', category: 'lining' }] }, rules);
    assert.equal(missing.valid, false);
    assert.match(missing.error, /Missing catalogue SKUs/);
  });

  await suite.test('OKF fact roles flow into the attached fact registry', async () => {
    const db = new MemoryDb();
    const attached: any[] = [];
    const okf = new OkfAuthoringService(async () => db as any, async (_projectId, update) => { attached.push(update); return { success: true }; });
    const draft: any = structuredClone(buildOkfContent());
    draft.factRegistry[0].extensions = { role: 'quantity', multiple: true };
    draft.factRegistry[1].extensions = { role: 'not-a-role' };
    const registry = (okf as any).attachedFactRegistry(draft);
    const [first, second] = draft.factRegistry.map((fact: any) => registry.facts[fact.factKey]);
    assert.equal(first.role, 'quantity');
    assert.equal(first.multiple, true);
    assert.equal(second.role, undefined, 'unknown roles are ignored');
  });
  await suite.test('a default journey is a validated pack setting; a project with several journeys publishes only once it is set', async () => {
    const good = validatePackSettings({ routingPolicy: { defaultJourneyId: ' intake ', fallbackOnCatalogSearch: false } });
    assert.deepEqual(good.ok && good.set, { routingPolicy: { defaultJourneyId: 'intake', fallbackOnCatalogSearch: false } });
    assert.deepEqual(validatePackSettings({ routingPolicy: null }), { ok: true, set: { routingPolicy: null } });
    for (const bad of [[], 'intake', {}, { defaultJourneyId: '' }, { defaultJourneyId: 'a', extra: 1 }, { defaultJourneyId: 'a', fallbackOnCatalogSearch: 'yes' }]) {
      assert.equal(validatePackSettings({ routingPolicy: bad }).ok, false, JSON.stringify(bad));
    }
    // Two journeys and no default: the publisher refuses to guess.
    const { service, db } = await createService();
    await db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $set: { 'persona.journeyGraph.nodes': [
      { id: 't1', data: { kind: 'trigger.intent', stageId: 'one_start', label: 'One' } },
      { id: 't2', data: { kind: 'trigger.intent', stageId: 'two_start', label: 'Two' } },
    ], 'persona.journeyGraph.edges': [] } });
    const blocked: any = await service.publishConfig(TENANT, { environmentId: 'test' });
    assert.equal(blocked.success, false);
    assert.match(blocked.message, /default journey/i);
    // The setting is stored through the ordinary update path and the next publication uses it.
    const saved = await service.updateProject(TENANT, { routingPolicy: { defaultJourneyId: `${TENANT}_one`, fallbackOnCatalogSearch: true } } as any);
    assert.equal(saved.success, true, saved.message);
    const published: any = await service.publishConfig(TENANT, { environmentId: 'test' });
    assert.equal(published.success, true, published.message);
    assert.equal(db.dump('business_pack_releases').at(-1)!.routingPolicy.defaultJourneyId, `${TENANT}_one`);
    const rejected = await service.updateProject(TENANT, { routingPolicy: { defaultJourneyId: '' } } as any);
    assert.equal(rejected.success, false);
  });
  await suite.test('a draft carrying undefined fields is stored as plain data and still validates after the database round trip', async () => {
    const { service, db } = await createService();
    const authoring = new OkfAuthoringService(async () => db as any, (pid, update) => service.updateProject(pid, update as any));
    const content: any = buildOkfContent();
    // A generator that leaves a field undefined: the driver would store null, which hashes differently from an absent field.
    content.concepts[0].extensions = { ...(content.concepts[0].extensions ?? {}), note: { detail: undefined, other: 'x' } };
    const saved = await authoring.saveDraft({ projectId: TENANT, environmentId: 'test', expectedRevision: 0, content, updatedBy: 'author-1' });
    assert.equal(saved.validation.valid, true);
    const stored: any = await authoring.getDraft(TENANT, 'test');
    assert.deepEqual(stored.content.concepts[0].extensions.note, { other: 'x' }, 'the undefined field is not stored at all');
    const checked: any = await authoring.validateDraft(TENANT, 'test');
    assert.equal(checked.valid ?? checked.validation?.valid, true, JSON.stringify(checked.issues ?? checked.validation?.issues ?? []).slice(0, 200));
  });
  await suite.test('the pack takes its currency from the project; a project that states none is not published with a guessed one', async () => {
    const { service, db } = await createService({ pricing: { currency: 'nzd', symbol: '$', taxRate: 0.15, discountRate: 0 }, profile: { primaryLocale: 'en-NZ' } });
    const published: any = await service.publishConfig(TENANT, { environmentId: 'test' });
    assert.equal(published.success, true, published.message);
    const profile = db.dump('business_pack_releases').at(-1)!.profile;
    assert.equal(profile.primaryCurrency, 'NZD');
    assert.deepEqual(profile.supportedCurrencies, ['NZD']);
    assert.equal(profile.primaryLocale, 'en-NZ');
    const missing = await createService({ pricing: undefined });
    await missing.db.collection('tenant_configs').updateOne({ projectId: TENANT }, { $unset: { pricing: '' } });
    const blocked: any = await missing.service.publishConfig(TENANT, { environmentId: 'test' });
    assert.equal(blocked.success, false);
    assert.match(blocked.message, /pricing currency/);
    assert.equal(missing.db.dump('business_pack_releases').length, 0, 'nothing is published');
  });

}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
