import { Injectable } from '@nestjs/common';
import {
  buildCatalogueBaseFilter,
  buildCategoryScopeClauses,
  checkCatalogMapping,
  normalizeCatalogProduct,
  resolveCatalogMapping,
  type MappingCheckResult,
  type ResolvedCatalogMapping,
} from '@journeyax/business-pack';
import {
  analyzeKnowledgeCoverage,
  COLLECTION_OKF_RELEASES,
  diffKnowledge,
  hydrateOkfReleaseEnvelope,
  type CatalogueRow,
  type KnowledgeCoverage,
  type KnowledgeDiff,
} from '@journeyax/knowledge';
import { OkfAuthoringService } from './okf-authoring.service';

type DbProvider = () => any;
type ProjectProvider = (projectId: string) => Promise<any | null>;

const PACK_RELEASES = 'business_pack_releases';
const PACK_POINTERS = 'business_pack_pointers';
const PRODUCTS = 'products';
/** Bound on what the back office reads from the live catalogue per request. */
const SAMPLE_PRODUCTS = 200;
const SAMPLE_ROWS = 12;

interface ReleaseRef { releaseId: string; version: string; checksum: string; required?: boolean; failurePolicy?: string }

const clean = (value: string) => (value || '').trim().toLowerCase();
/** An aggregation reference to a document field. */
const fieldRef = (field: string) => ['$', field].join('');

/**
 * Read-only views over the business knowledge, the live catalogue and the active Business Pack for the back office.
 * Nothing here writes; every figure is computed from the stored draft/release/pack and the tenant's own products at the
 * moment of the request, through the tenant's catalogue mapping.
 */
@Injectable()
export class KnowledgeInsightService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly projectProvider: ProjectProvider,
    private readonly authoring: OkfAuthoringService,
  ) {}

  private scope(projectId: string, environmentId: string) {
    const tenantId = clean(projectId);
    const environment = clean(environmentId || 'production');
    if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error('A valid projectId is required');
    if (!['dev', 'test', 'staging', 'production'].includes(environment)) throw new Error('Invalid environmentId');
    return { tenantId, environmentId: environment };
  }

  private async mappingFor(projectId: string): Promise<ResolvedCatalogMapping> {
    const project = await this.projectProvider(projectId);
    return resolveCatalogMapping(project?.catalogMapping ?? undefined);
  }

  private baseFilter(mapping: ResolvedCatalogMapping, tenantId: string) {
    const { filter, and } = buildCatalogueBaseFilter(mapping, tenantId);
    if (and.length === 0) delete filter.$and;
    return filter;
  }

  /** The active Business Pack for an environment: its version, journeys and the knowledge release it is bound to. */
  private async activePack(tenantId: string, environmentId: string) {
    const db = await this.dbProvider();
    const pointer = await db.collection(PACK_POINTERS).findOne({ tenantId, environmentId });
    if (!pointer?.activeVersion) return null;
    const release = await db.collection(PACK_RELEASES).findOne({ tenantId, environmentId, version: pointer.activeVersion });
    if (!release) return null;
    const pack = release.packData || release;
    const journeys: any[] = Array.isArray(pack.journeys) ? pack.journeys : Object.values(pack.journeys || {});
    return {
      version: String(pointer.activeVersion),
      publishedAt: release.publishedAt ?? null,
      publishedBy: release.publishedBy ?? null,
      journeyIds: journeys.map((journey) => String(journey.journeyId)),
      knowledgeModel: (pack.knowledgeModel ?? null) as ReleaseRef | null,
      hasCatalogMapping: Boolean(pack.catalogMapping),
      currency: pack.profile?.primaryCurrency ?? null,
    };
  }

  private async releaseContent(tenantId: string, environmentId: string, releaseId: string) {
    const db = await this.dbProvider();
    const stored = await db.collection(COLLECTION_OKF_RELEASES).findOne({ tenantId, environmentId, releaseId });
    if (!stored) return null;
    return (await hydrateOkfReleaseEnvelope(db, stored)).content;
  }

  /** Distinct (hierarchy path, category) groups of the tenant's live catalogue with their product counts. */
  async catalogueRows(projectId: string): Promise<CatalogueRow[]> {
    const { tenantId } = this.scope(projectId, 'production');
    const mapping = await this.mappingFor(projectId);
    const db = await this.dbProvider();
    const pathField = mapping.categoryHierarchyPaths[0];
    const categoryField = mapping.categoryPaths[0];
    const grouped: any[] = await db.collection(PRODUCTS).aggregate([
      { $match: this.baseFilter(mapping, tenantId) },
      { $group: { _id: { path: fieldRef(pathField), category: fieldRef(categoryField) }, n: { $sum: 1 } } },
    ]).toArray();
    return grouped.map((row) => ({
      path: Array.isArray(row._id?.path) ? row._id.path.map(String) : [],
      ...(typeof row._id?.category === 'string' && row._id.category ? { category: row._id.category } : {}),
      products: Number(row.n) || 0,
    }));
  }

  /** Coverage of the catalogue and the pack by the draft knowledge, plus what is authored, verified and missing. */
  async coverage(projectId: string, environmentId = 'production'): Promise<KnowledgeCoverage & { environmentId: string; revision: number; pack: { version: string; journeyIds: string[] } | null }> {
    const scope = this.scope(projectId, environmentId);
    const draft = await this.authoring.getDraft(projectId, scope.environmentId);
    if (!draft) throw new Error('OKF draft not found');
    const pack = await this.activePack(scope.tenantId, scope.environmentId);
    const coverage = analyzeKnowledgeCoverage(draft.content, {
      journeyIds: pack ? pack.journeyIds : null,
      catalogue: await this.catalogueRows(projectId),
    });
    return { ...coverage, environmentId: scope.environmentId, revision: draft.revision, pack: pack ? { version: pack.version, journeyIds: pack.journeyIds } : null };
  }

  /**
   * Where the knowledge stands on the way to customers: the draft being edited, the immutable releases, the release the
   * project is bound to (staged), and the one the live Business Pack runs (active) — and exactly what differs between them.
   */
  async lifecycle(projectId: string, environmentId = 'production') {
    const scope = this.scope(projectId, environmentId);
    const [draft, releases, project, pack] = await Promise.all([
      this.authoring.getDraft(projectId, scope.environmentId),
      this.authoring.listReleases(projectId, scope.environmentId),
      this.projectProvider(projectId),
      this.activePack(scope.tenantId, scope.environmentId),
    ]);
    const staged: ReleaseRef | null = project?.knowledgeModel ?? null;
    const active: ReleaseRef | null = pack?.knowledgeModel ?? null;
    const latestReady = releases.find((release: any) => release.status === 'ready') ?? null;

    const stagedContent = staged ? await this.releaseContent(scope.tenantId, scope.environmentId, staged.releaseId) : null;
    const activeContent = active
      ? (active.releaseId === staged?.releaseId ? stagedContent : await this.releaseContent(scope.tenantId, scope.environmentId, active.releaseId))
      : null;
    const draftVsStaged: KnowledgeDiff | null = draft && stagedContent ? diffKnowledge(stagedContent, draft.content) : null;
    const stagedVsActive: KnowledgeDiff | null = stagedContent ? diffKnowledge(activeContent, stagedContent) : null;

    const sameRelease = (a: ReleaseRef | null, b: ReleaseRef | null) => (a && b ? a.releaseId === b.releaseId && a.checksum === b.checksum : null);
    const state = {
      draftHasChanges: draftVsStaged ? !draftVsStaged.identical : draft ? true : null,
      stagedIsLatestRelease: staged && latestReady ? staged.releaseId === latestReady.releaseId && staged.checksum === latestReady.checksum : null,
      activeIsStaged: staged ? (active ? sameRelease(active, staged) : false) : null,
      knowledgeRequiredByPack: active ? Boolean(active.required) : null,
    };
    let nextStep: 'write_draft' | 'publish_release' | 'stage_release' | 'publish_pack' | 'none' = 'none';
    if (!draft && !staged) nextStep = 'write_draft';
    else if (draft && (state.draftHasChanges || !staged)) nextStep = latestReady && !state.draftHasChanges ? 'stage_release' : 'publish_release';
    else if (staged && state.stagedIsLatestRelease === false && latestReady) nextStep = 'stage_release';
    else if (staged && state.activeIsStaged !== true) nextStep = 'publish_pack';

    return {
      ...scope,
      draft: draft ? {
        revision: draft.revision, valid: Boolean(draft.validation?.valid), issues: draft.validation?.issues?.length ?? 0, checksum: draft.checksum ?? null,
        updatedAt: draft.updatedAt ?? null, updatedBy: draft.updatedBy ?? null, concepts: draft.content?.concepts?.length ?? 0,
      } : null,
      releases: releases.slice(0, 10).map((release: any) => ({
        releaseId: release.releaseId, version: release.version, checksum: release.checksum, status: release.status,
        publishedAt: release.publishedAt ?? null, publishedBy: release.publishedBy ?? null,
      })),
      staged: staged ? { releaseId: staged.releaseId, version: staged.version, checksum: staged.checksum, required: Boolean(staged.required), failurePolicy: staged.failurePolicy ?? null } : null,
      active: pack ? {
        packVersion: pack.version, publishedAt: pack.publishedAt, publishedBy: pack.publishedBy, currency: pack.currency, hasCatalogMapping: pack.hasCatalogMapping,
        knowledge: active ? { releaseId: active.releaseId, version: active.version, checksum: active.checksum, required: Boolean(active.required) } : null,
      } : null,
      state,
      changes: { draftVsStaged, stagedVsActive },
      nextStep,
    };
  }

  /** The mapping saved on the project and the platform defaults it falls back to, field by field. */
  async catalogMappingState(projectId: string) {
    this.scope(projectId, 'production');
    const project = await this.projectProvider(projectId);
    return { saved: project?.catalogMapping ?? null, defaults: resolveCatalogMapping() };
  }

  /**
   * Checks a catalogue mapping (the one being edited, or the saved one) against products spread evenly across the tenant's
   * catalogue, so a person sees what the mapping would read before it is saved.
   */
  async checkCatalogMapping(projectId: string, mappingInput: unknown | undefined, options: { sample?: number } = {}): Promise<MappingCheckResult & { catalogueProducts: number }> {
    const { tenantId } = this.scope(projectId, 'production');
    const saved = (await this.projectProvider(projectId))?.catalogMapping;
    const candidate = mappingInput === undefined ? saved : mappingInput;
    // The sample is read with the platform defaults' ownership fields unless the candidate mapping itself is valid.
    let mapping: ResolvedCatalogMapping;
    try { mapping = resolveCatalogMapping(candidate ?? undefined); } catch { mapping = resolveCatalogMapping(); }
    const db = await this.dbProvider();
    const filter = this.baseFilterOwnershipOnly(mapping, tenantId);
    const total = await db.collection(PRODUCTS).countDocuments(filter);
    const wanted = Math.max(1, Math.min(options.sample ?? SAMPLE_PRODUCTS, 1000));
    const slices = Math.min(10, wanted);
    const per = Math.ceil(wanted / slices);
    const sample: any[] = [];
    for (let index = 0; index < slices && sample.length < wanted; index++) {
      const skip = total <= wanted ? 0 : Math.floor((index * total) / slices);
      const rows = await db.collection(PRODUCTS).find(filter).skip(skip).limit(per).toArray();
      sample.push(...rows);
      if (total <= wanted) break;
    }
    const stripped = sample.slice(0, wanted).map(({ _id, ...rest }: any) => ({ ...rest, ...(_id !== undefined ? { _id: String(_id) } : {}) }));
    return { ...checkCatalogMapping(candidate ?? {}, stripped, { rowLimit: SAMPLE_ROWS }), catalogueProducts: total };
  }

  private baseFilterOwnershipOnly(mapping: ResolvedCatalogMapping, tenantId: string) {
    return { $or: mapping.tenantFields.map((path) => ({ [path]: tenantId })) };
  }

  /**
   * "What would the assistant use for this message?" — the draft's decision plus the live products each scope selects, the
   * live products behind each "Have you considered?" suggestion, and the pin the conversation would be held to.
   */
  async previewWithCatalogue(
    projectId: string,
    input: { message: string; knownFacts?: Record<string, unknown>; intentCandidates?: string[]; forceShowResults?: boolean },
    environmentId = 'production',
  ) {
    const scope = this.scope(projectId, environmentId);
    const preview: any = await this.authoring.previewDraft(projectId, input, scope.environmentId);
    if (!preview.previewable) return preview;
    const decision = preview.decision;
    const draft = await this.authoring.getDraft(projectId, scope.environmentId);
    const concepts = new Map<string, any>((draft?.content?.concepts ?? []).map((concept: any) => [concept.conceptId, concept]));
    const mapping = await this.mappingFor(projectId);
    const db = await this.dbProvider();
    const base = this.baseFilter(mapping, scope.tenantId);

    const live = async (target: { categoryIds?: string[]; categoryPaths?: string[][]; excludeCategoryIds?: string[] }, limit = 3) => {
      const filter: Record<string, any> = { ...base, $and: [...(base.$and ?? []), ...buildCategoryScopeClauses(mapping, target)] };
      if (filter.$and.length === 0) delete filter.$and;
      const [products, rows] = await Promise.all([
        db.collection(PRODUCTS).countDocuments(filter),
        db.collection(PRODUCTS).find(filter).limit(limit).toArray(),
      ]);
      return {
        products,
        sample: rows.map((row: any) => {
          const item = normalizeCatalogProduct(row, mapping, { title: 'Product', category: '' });
          return { sku: item.sku, title: item.title, category: item.category, priceCents: item.priceCents, currency: item.currency, inStock: item.inStock };
        }),
      };
    };

    const retrieval = decision.retrieval ?? {};
    const hasScope = (retrieval.categoryIds?.length ?? 0) + (retrieval.categoryPaths?.length ?? 0) > 0;
    const liveScope = retrieval.permission === 'allowed' && hasScope ? await live(retrieval) : null;
    const groups = retrieval.permission === 'allowed'
      ? await Promise.all((retrieval.groups ?? []).map(async (group: any) => ({ conceptId: group.conceptId, label: group.label, ...(await live(group, 2)) })))
      : [];
    const suggestions = await Promise.all((decision.suggestions ?? []).map(async (suggestion: any) => ({
      conceptId: suggestion.conceptId, name: suggestion.name, label: suggestion.label, ...(await live(suggestion, suggestion.maxItems ?? 2)),
    })));

    return {
      ...preview,
      conceptName: decision.conceptId ? concepts.get(decision.conceptId)?.name ?? null : null,
      live: { scope: liveScope, groups, suggestions },
    };
  }
}
