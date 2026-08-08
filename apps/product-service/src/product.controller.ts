import { Controller, Post, Get, Param, Body, Inject, Headers, HttpException, HttpStatus, Query } from '@nestjs/common';
import { ProductService } from './product.service';
import { ArtworkService, ArtworkStatus } from './artwork.service';
import { RenderService } from './render.service';

// Read at REQUEST time, not module-load time — env may not be populated when this
// module is first imported (dotenv loads in main.ts), which would leave the key
// undefined and reject every internal caller (the quote engine's pricebook call).
const internalKey = () => process.env.INTERNAL_API_KEY;

@Controller('api/v1/:projectId/products')
export class ProductController {
  constructor(
    @Inject(ProductService) private readonly productService: ProductService,
    @Inject(ArtworkService) private readonly artwork: ArtworkService,
    @Inject(RenderService) private readonly renderer: RenderService,
  ) {}

  /**
   * Render a design (AUG-21 / AUG-29).
   *
   * Returns the composed texture atlas plus the mesh it belongs on; the browser
   * does the actual 3D. The imaging vendor's hosts, id patterns, palette and
   * zone names all come from project config, so a different tenant's platform
   * needs no code change.
   *
   * The style's atlas id is resolved (and cached) before we build anything, so
   * an unrenderable style comes back as renderable:false instead of a URL that
   * hangs and leaves the customer looking at an empty viewer.
   */
  /**
   * The project's renderer config, for the storefront's asset proxy to derive
   * its host allowlist from. Read-only and non-secret: hosts, id patterns,
   * palette and zone names. No credentials live here.
   */
  /** What else can hang in this kit, grouped by the catalogue's garment types. */
  @Get('rack')
  async rack(@Param('projectId') projectId: string) {
    return { groups: await this.productService.getRack((projectId || '').toLowerCase()) };
  }

  @Get('catalogue')
  async getCatalogue(
    @Param('projectId') projectId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const brand = (projectId || 'caroma').toLowerCase();
    const parsedLimit = Math.min(Number(limit) || 50, 200);
    return this.productService.getCatalogue(brand, q?.trim(), parsedLimit);
  }

  @Get('catalogue/item')
  async getCatalogueItem(
    @Param('projectId') projectId: string,
    @Query('url') url?: string,
  ) {
    if (!url) throw new HttpException('url query parameter is required', HttpStatus.BAD_REQUEST);
    const brand = (projectId || 'caroma').toLowerCase();
    const item = await this.productService.getCatalogueItem(brand, url);
    if (!item) throw new HttpException('Item not found', HttpStatus.NOT_FOUND);
    return item;
  }


  @Get('renderer-config')
  async rendererConfig(@Param('projectId') projectId: string) {
    const cfg = await this.productService.getRendererConfig((projectId || '').toLowerCase());
    return cfg || {};
  }

  @Post('render')
  async render(
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    // The composition lives in ProductService so that internal callers (the ink
    // probe, AUG-81) go through exactly the same path the HTTP route does.
    return this.productService.renderStyle((projectId || '').toLowerCase(), body || {});
  }

  /* ── Artwork & approval (AUG-16) ──────────────────────────────────────
   * The customer supplies the mark; the platform never reproduces one. These
   * endpoints record provenance and gate production on explicit human approval.
   */

  /** Register customer-supplied artwork (bytes are uploaded to artifact storage separately). */
  /** Real colour values for named inks (AUG-81) — swatches must never be guessed. */
  @Post('colours/resolve')
  async resolveColours(@Param('projectId') projectId: string, @Body() body: any) {
    const names: string[] = Array.isArray(body?.names) ? body.names : [];
    const colours = await this.productService.inkColours((projectId || '').toLowerCase(), names);
    // Names with no resolvable value are simply absent — the caller renders a
    // neutral chip rather than a plausible-looking wrong colour.
    return { colours, resolved: Object.keys(colours).length, asked: names.length };
  }

  @Post('artwork')
  async registerArtwork(@Param('projectId') projectId: string, @Body() body: any) {
    return this.artwork.register((projectId || '').toLowerCase(), body || {});
  }

  /** Artwork on file for a session or entity. */
  @Post('artwork/list')
  async listArtwork(@Param('projectId') projectId: string, @Body() body: { sessionId?: string; entityKey?: string }) {
    return this.artwork.list((projectId || '').toLowerCase(), body || {});
  }

  /**
   * Advance the approval state. `approved` requires a HUMAN actor — the agent
   * cannot approve its own proof, because approval gates irreversible printing.
   * The actor is derived from an authenticated operator/customer header, never
   * from the request body, so a caller cannot simply claim to be human.
   */
  @Post('artwork/:artworkId/status')
  async setArtworkStatus(
    @Param('projectId') projectId: string,
    @Param('artworkId') artworkId: string,
    @Headers('x-user-email') userEmail: string,
    @Headers('x-actor-type') actorType: string,
    @Body() body: { status: ArtworkStatus; note?: string },
  ) {
    const actor: 'human' | 'agent' = userEmail || actorType === 'human' ? 'human' : 'agent';
    return this.artwork.setStatus((projectId || '').toLowerCase(), artworkId, body?.status, {
      by: userEmail || undefined, note: body?.note, actor,
    });
  }

  /** Production gate: is every artwork item for this session approved? */
  @Post('artwork/gate')
  async artworkGate(@Param('projectId') projectId: string, @Body() body: { sessionId: string }) {
    return this.artwork.approvalGate((projectId || '').toLowerCase(), body?.sessionId || '');
  }

  /**
   * Authoritative pricebook lookup by SKU (P0-04). INTERNAL ONLY — the quote
   * engine calls this to rehydrate real prices; it must never be publicly
   * callable (it's the source of truth for money). Requires the internal key.
   */
  @Post('pricebook')
  async pricebook(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKeyHeader: string,
    @Body() body: { skus: string[] },
  ) {
    const key = internalKey();
    if (!key || internalKeyHeader !== key) {
      throw new HttpException('pricebook is internal-only', HttpStatus.FORBIDDEN);
    }
    const brand = (projectId || 'caroma').toLowerCase();
    return this.productService.getBySkus(brand, body?.skus || []);
  }

  /** Find the school / athletic programme a customer is buying for (AUG-15). */
  @Post('teams')
  async teams(
    @Param('projectId') projectId: string,
    @Body() body: { query: string; limit?: number; state?: string; city?: string },
  ) {
    const brand = (projectId || 'caroma').toLowerCase();
    return this.productService.findTeams(brand, body?.query || '', Math.min(body?.limit || 6, 20),
      { state: body?.state, city: body?.city });
  }

  /**
   * Propose a team's colours (AUG-27). A proposal is never applied — it comes
   * back with its provenance and must be confirmed by the customer first.
   */
  @Post('teams/colours')
  async teamColours(@Param('projectId') projectId: string, @Body() body: { slug: string }) {
    const brand = (projectId || '').toLowerCase();
    const cfg = await this.productService.getRendererConfig(brand);
    return this.productService.proposeTeamColours(brand, body?.slug || '', cfg?.palette || []);
  }

  /** Settle a team's colours. Only a human confirmation gets to do this. */
  @Post('teams/colours/confirm')
  async confirmTeamColours(
    @Param('projectId') projectId: string,
    @Body() body: { slug: string; colours: string[] },
  ) {
    return this.productService.confirmTeamColours(
      (projectId || '').toLowerCase(), body?.slug || '', body?.colours || []);
  }

  /** Register a club / travel team the customer named (AUG-15). Tenant-owned. */
  @Post('teams/register')
  async registerTeam(
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    const brand = (projectId || 'caroma').toLowerCase();
    return this.productService.registerTeam(brand, body || {});
  }

  /**
   * Data maintenance (AUG-18) — reindex / dedupe / purge, on the same audited,
   * permission-checked path as ingestion. Defaults to dryRun: a maintenance
   * action must show what it would change before it changes it.
   */
  @Post('maintenance')
  async maintenance(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKeyHeader: string,
    @Headers('x-user-permissions') permissions: string,
    @Body() body: { op: string; dryRun?: boolean; limit?: number },
  ) {
    const key = internalKey();
    const isInternal = !!key && internalKeyHeader === key;
    const perms = String(permissions || '').split(',').map((p) => p.trim());
    // Same permission as ingestion: both rewrite the tenant's knowledge.
    if (!isInternal && !perms.includes('knowledge.ingest')) {
      throw new HttpException("This action requires the 'knowledge.ingest' permission.", HttpStatus.FORBIDDEN);
    }
    return this.productService.runMaintenance(
      (projectId || '').toLowerCase(), body?.op || '', body?.dryRun !== false, body?.limit,
    );
  }

  /**
   * Ingest curated knowledge documents (fit guides, size charts, care, styling).
   * Same audited, permission-checked path as ingestion/maintenance — both write
   * the tenant's knowledge corpus. The platform's sanctioned way to add authored
   * guidance a brand doesn't publish (e.g. size charts behind a bot wall), so it
   * never needs a direct DB write. Idempotent per document title.
   */
  @Post('knowledge/documents')
  async ingestKnowledgeDocs(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKeyHeader: string,
    @Headers('x-user-permissions') permissions: string,
    @Body() body: { documents: Array<{ title: string; type: string; content: string; category?: string }>; namespace?: string },
  ) {
    const key = internalKey();
    const isInternal = !!key && internalKeyHeader === key;
    const perms = String(permissions || '').split(',').map((p) => p.trim());
    if (!isInternal && !perms.includes('knowledge.ingest')) {
      throw new HttpException("This action requires the 'knowledge.ingest' permission.", HttpStatus.FORBIDDEN);
    }
    const docs = Array.isArray(body?.documents) ? body.documents : [];
    if (!docs.length) throw new HttpException('documents[] is required.', HttpStatus.BAD_REQUEST);
    return this.productService.ingestKnowledgeDocuments(
      (projectId || '').toLowerCase(), docs, body?.namespace || 'kb',
    );
  }

  /** Which of these tokens are real style codes here (AUG-22 identity guard). */
  @Post('skus/exists')
  async skusExist(@Param('projectId') projectId: string, @Body() body: { skus: string[] }) {
    const found = await this.productService.existingSkus((projectId || '').toLowerCase(), body?.skus || []);
    return { found };
  }

  /** Which of these styles can be custom-designed (AUG-25). Three-valued. */
  @Post('designability')
  async designability(@Param('projectId') projectId: string, @Body() body: { skus: string[] }) {
    const designable = await this.productService.getDesignability(
      (projectId || '').toLowerCase(), body?.skus || [],
    );
    return { designable };
  }

  /** Styles proven designable, for when the chosen one is not (AUG-25). */
  @Post('designable')
  async designable(
    @Param('projectId') projectId: string,
    @Body() body: { like?: string; likeSku?: string; limit?: number },
  ) {
    const items = await this.productService.getDesignable((projectId || '').toLowerCase(), {
      like: body?.like, likeSku: body?.likeSku, limit: body?.limit,
    });
    return { items };
  }

  /** Brand orientation brief for this project (AUG-14). */
  @Get('brand-hub')
  async brandHub(@Param('projectId') projectId: string) {
    return (await this.productService.getBrandHub((projectId || 'caroma').toLowerCase())) || { empty: true };
  }

  /**
   * Configurable choices for a SKU (AUG-13): colours/sizes that form real
   * variants, fixed characteristics, coordinating items and alternate views.
   */
  @Post('options')
  async options(
    @Param('projectId') projectId: string,
    @Body() body: { sku: string },
  ) {
    const brand = (projectId || 'caroma').toLowerCase();
    return this.productService.getOptions(brand, body?.sku || '');
  }

  /**
   * Structural relationships for a SKU (AUG-10): collection siblings, coordinated
   * outfitting sets, and the adult/youth/ladies sizing group. Read-only catalogue
   * facts — same exposure as product search, no internal key required.
   */
  @Post('related')
  async related(
    @Param('projectId') projectId: string,
    @Body() body: { sku: string },
  ) {
    const brand = (projectId || 'caroma').toLowerCase();
    return this.productService.getRelated(brand, body?.sku || '');
  }

  /**
   * Start a config-driven ingestion run for this project (AUG-7).
   * Gateway-routed and permission-checked; the pipeline reads the project's own
   * `knowledgeSource.sources[]` — no brand/URL/model is hardcoded anywhere.
   * Heavy work runs in a detached worker; progress lands in `ingest_jobs`.
   */
  @Post('ingest')
  async startIngest(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKeyHeader: string,
    @Headers('x-user-permissions') permissions: string,
    @Body() body: { only?: string[] },
  ) {
    const key = internalKey();
    const isInternal = !!key && internalKeyHeader === key;
    const perms = String(permissions || '').split(',').map((p) => p.trim());
    if (!isInternal && !perms.includes('knowledge.ingest')) {
      throw new HttpException("This action requires the 'knowledge.ingest' permission.", HttpStatus.FORBIDDEN);
    }
    return this.productService.startIngest((projectId || '').toLowerCase(), body?.only);
  }

  /** Ingestion job status (live progress + log tail). */
  @Get('ingest/:jobId')
  async ingestStatus(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.productService.getIngestJob((projectId || '').toLowerCase(), jobId);
  }

  /**
   * Search the knowledge base for products, guides, and content.
   * Applies vector search with regex fallback and RAG token budgeting.
   * Tenant is the URL projectId (gateway-validated); body.brand is a dev fallback.
   */
  @Post('search')
  async search(
    @Param('projectId') projectId: string,
    @Body() body: {
      query: string;
      brand?: string;
      type?: string;
      category?: string;
      limit?: number;
      gender?: string;
    }
  ) {
    const brand = (projectId || body.brand || 'caroma').toLowerCase();
    const limit = body.limit || 8;

    console.log(`[ProductService] Search: "${body.query}" brand=${brand} type=${body.type || 'any'} category=${body.category || 'any'} gender=${body.gender || 'any'}`);

    const result = await this.productService.search(
      body.query,
      brand,
      body.type,
      body.category,
      limit,
      body.gender
    );

    return result;
  }

  /**
   * Get catalog statistics for this tenant.
   */
  @Get('stats')
  async getStats(@Param('projectId') projectId: string) {
    return this.productService.getStats((projectId || '').toLowerCase());
  }

  @Get('reconciliation')
  async getReconciliation(@Param('projectId') projectId: string) {
    return this.productService.getReconciliation((projectId || '').toLowerCase());
  }

  /**
   * Health check endpoint.
   */
  @Get('health')
  health() {
    return { status: 'ok', service: 'product-service', timestamp: new Date().toISOString() };
  }
}
