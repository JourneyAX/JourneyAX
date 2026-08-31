import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { CdlTemplateService, MatchQuery } from './cdl-template.service';
import { AnalyzeInput, CdlAnalyzeService } from './cdl-analyze.service';
import { TryOnService } from './tryon.service';
import { FabricService } from './fabric.service';
import { RetextureService } from './retexture.service';
import { ProductService } from './product.service';

/** In-memory store for generated design concepts. A generated concept is a big
 *  data URL (~1–2MB) — too large to push through the chat/LLM. We stash the bytes
 *  here and hand back a short URL the panel and the analyser can both fetch. LRU-
 *  capped so a long-running dev server can't grow unbounded. Fine for a POC; swap
 *  for the per-project GCS bucket (AUG-8) in production. */
const CONCEPTS = new Map<string, { buf: Buffer; mime: string }>();
const CONCEPT_CAP = 200;
function storeConcept(dataUrl: string): string {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/);
  const mime = m ? m[1] : 'image/png';
  const buf = Buffer.from(m ? m[2] : '', 'base64');
  const id = randomUUID();
  CONCEPTS.set(id, { buf, mime });
  while (CONCEPTS.size > CONCEPT_CAP) CONCEPTS.delete(CONCEPTS.keys().next().value as string);
  return id;
}

/**
 * CDL design-review lifecycle (the "artist remains the production authority"
 * gate). A design — whether it landed on an existing template (use) or needs a
 * brand-new pattern (create) — is submitted for review and moves through:
 *
 *   pending_artist → artist_approved  → customer_agreed → ready_for_print
 *                 ↘ changes_requested (back to the customer/agent to revise)
 *
 * Two authorities, neither can act for the other: the ARTIST signs off that it
 * is producible (and, for a 'create', that cut pieces exist at all sizes); the
 * CUSTOMER agrees to the proof. Only when both have happened is it ready to
 * print. In-memory for the POC (swap for a Mongo `cdl_reviews` collection in
 * production — same shape). */
type ReviewStatus = 'pending_artist' | 'changes_requested' | 'artist_approved' | 'customer_agreed' | 'ready_for_print';
interface CdlReview {
  jobId: string; projectId: string; sessionId: string;
  kind: 'use' | 'create';           // use = existing template; create = new cut pieces needed
  sku?: string; conceptId?: string; brief?: string; summary?: string;
  sizes?: string[]; customer?: string;
  /** Coach team-order journey: the roster this order is for (name/number/size),
   *  and the four flat-view concept ids the coach approved before submitting. */
  roster?: { name?: string; number?: string; size?: string }[];
  flatViews?: { frontId?: string; backId?: string; leftId?: string; rightId?: string };
  status: ReviewStatus;
  artist?: { by?: string; notes?: string };
  history: { at: string; event: string; note?: string }[];
}
const REVIEWS = new Map<string, CdlReview>();
const REVIEW_CAP = 500;
function nowIso() { return new Date().toISOString(); }

/**
 * Map a described colour ("navy blue", "royal") onto a brand-palette-style name
 * ("NAVY", "ROYAL"). The render service vets the final name against the real
 * palette and drops anything it doesn't stock, so this only has to get the
 * common cases right — its job is to stop compound/English names from being
 * silently dropped, which is what left generated designs rendering a single
 * accent colour. Returns '' when no colour word is recognised.
 */
const COLOUR_WORDS: [RegExp, string][] = [
  [/\bnavy\b/, 'NAVY'], [/\broyal\b/, 'ROYAL'], [/\borange\b/, 'ORANGE'],
  [/\bwhite\b/, 'WHITE'], [/\bblack\b/, 'BLACK'], [/\bscarlet\b/, 'SCARLET'],
  [/\bcardinal\b/, 'CARDINAL'], [/\bmaroon\b/, 'MAROON'], [/\bpurple\b/, 'PURPLE'],
  [/\bbrown\b/, 'BROWN'], [/\b(vegas ?)?gold\b/, 'VEGAS GOLD'], [/\bgold\b/, 'VEGAS GOLD'],
  [/\b(grey|gray)\b/, 'RA BASEBALL GREY'], [/\bsilver\b/, 'RA BASEBALL GREY'],
  [/\b(red|crimson)\b/, 'SCARLET'], [/\b(blue|columbia|carolina|sky)\b/, 'ROYAL'],
  [/\bgreen\b/, 'GREEN'], [/\bkelly\b/, 'GREEN'], [/\bteal\b/, 'ROYAL'],
  [/\byellow\b/, 'VEGAS GOLD'], [/\bpink\b/, 'PINK'],
];
function normaliseColour(name: string): string {
  const s = (name || '').toLowerCase().trim();
  if (!s) return '';
  const up = s.toUpperCase();
  // A single palette word already? keep it.
  if (/^[A-Z][A-Z ]*$/.test(up) && up.split(' ').length <= 2 && !/\b(BLUE|LIGHT|DARK)\b/.test(up)) {
    // fall through to word map anyway to canonicalise common ones
  }
  for (const [re, out] of COLOUR_WORDS) if (re.test(s)) return out;
  return up; // let the render service's palette check decide
}

/**
 * From the analysis + the matched template, build a deterministic configurator
 * config: every analysed colour mapped onto a body/accent/outline zone (so the
 * garment renders in ALL the customer's colours, not just one), plus any legible
 * team name / number. The render service picks the style's design line when none
 * is named, so we leave that to it. Only built for a 'use' match with a real SKU.
 */
/** Rough hue family, so the accent is picked to CONTRAST with the body rather
 *  than being a second shade of the same colour (navy body + royal accent reads
 *  as one blur; navy body + orange accent reads as the intended two-tone). */
function hueFamily(c: string): string {
  const u = c.toUpperCase();
  if (/NAVY|ROYAL|BLUE|COLUMBIA|CAROLINA|TEAL/.test(u)) return 'blue';
  if (/SCARLET|RED|CARDINAL|MAROON|CRIMSON/.test(u)) return 'red';
  if (/ORANGE/.test(u)) return 'orange';
  if (/GOLD|YELLOW/.test(u)) return 'gold';
  if (/GREEN|KELLY/.test(u)) return 'green';
  if (/PURPLE/.test(u)) return 'purple';
  if (/BROWN/.test(u)) return 'brown';
  if (/GREY|GRAY|SILVER/.test(u)) return 'grey';
  if (/WHITE/.test(u)) return 'white';
  if (/BLACK/.test(u)) return 'black';
  if (/PINK/.test(u)) return 'pink';
  return u;
}

function suggestConfig(analysis: any, match: any): any {
  const bestT = match?.best?.template || match?.best;
  const sku = bestT?.parentSku;
  if (!sku) return null;
  const mapped: string[] = [];
  for (const c of (analysis?.colors || [])) {
    const n = normaliseColour(String(c));
    if (n && !mapped.includes(n)) mapped.push(n);
  }
  const cfg: any = { sku };
  const base = mapped[0];
  if (base) cfg.baseColor = base;
  // Accent: the first mapped colour in a DIFFERENT hue family from the body
  // (and not plain white, which reads as no accent). Falls back to the next
  // colour, then to white, so a single-colour design still renders.
  const rest = mapped.slice(1);
  const accent = rest.find((c) => hueFamily(c) !== hueFamily(base) && c !== 'WHITE')
    || rest.find((c) => c !== 'WHITE') || rest[0];
  if (accent) cfg.accentColor = accent;
  // Outline: a remaining colour that is neither base nor accent (often white).
  const outline = mapped.find((c) => c !== base && c !== accent);
  if (outline) cfg.outlineColour = outline;
  // White reads best for lettering; else the accent, else the base.
  cfg.textColour = mapped.find((c) => c === 'WHITE') || accent || base || 'WHITE';
  const t = analysis?.text || {};
  if (t.teamName) cfg.name = t.teamName;
  if (t.number) cfg.number = String(t.number);
  // Ordered body → accent → outline, then any remaining colours.
  cfg.colours = [base, accent, outline, ...mapped].filter((c, i, a) => c && a.indexOf(c) === i);
  // The design's real extracted palette (name + hex + role) — the editable
  // swatch set the panel shows, so the customer can recolour with confidence.
  if (Array.isArray(analysis?.palette) && analysis.palette.length) cfg.palette = analysis.palette;
  if (analysis?.aesthetic) cfg.aesthetic = analysis.aesthetic;
  // If the matched garment differs in collar/closure from what was uploaded,
  // say so plainly rather than pretending it's identical.
  const gname = String(bestT?.name || '');
  cfg.garmentName = gname || undefined;
  return cfg;
}

/** Build a garment-concept generation prompt from a plain-language brief.
 *  Aims for a clean, single-garment, front-facing studio render so the result
 *  both looks good in chat AND analyses cleanly against the template library. */
function designPrompt(brief: string): string {
  return (
    `Design a single custom team sports jersey based on this brief: "${brief}". ` +
    `Render it as a clean, photorealistic product shot: one garment, front view, centred on a plain white studio background, no model, no mannequin, no props, no text watermark. ` +
    `Show the garment shape, collar, sleeves, colour-blocking and any pattern clearly. ` +
    `If the brief names a team, number or player name, include them tastefully on the jersey. ` +
    `Output only the jersey image.`
  );
}

/**
 * CDL (Custom Design Line) endpoints — the "check the templates" backbone.
 *
 *   POST  …/cdl/match       → analyse-result in, ranked templates + use/create decision
 *   GET   …/cdl/templates   → list / filter the library
 *   GET   …/cdl/templates/:sku → one template
 *   GET   …/cdl/facets      → sports / garment types / divisions (for filters + analyzer)
 *   POST  …/cdl/reload      → hot-reload after a feed refresh
 *
 * projectId is kept in the path for platform consistency; the library is global.
 */
@Controller('api/v1/:projectId/cdl')
export class CdlController {
  constructor(
    @Inject(CdlTemplateService) private readonly cdl: CdlTemplateService,
    @Inject(CdlAnalyzeService) private readonly analyzer: CdlAnalyzeService,
    @Inject(TryOnService) private readonly imagegen: TryOnService,
    @Inject(FabricService) private readonly fabric: FabricService,
    @Inject(RetextureService) private readonly retexture: RetextureService,
    @Inject(ProductService) private readonly products: ProductService,
  ) {}

  /**
   * Door A — "design it in chat". Generate a jersey concept from a text brief
   * (nano-banana), then analyse + match the concept to a make-able template in
   * one call. Body: { brief, referenceImage?(data URL for iteration), sizes?[] }.
   * Returns { concept(dataUrl), provider, analysis, match }. The concept is the
   * customer-facing look; match.best is the real style we actually produce.
   */
  @Post('design')
  async design(@Body() body: { brief?: string; referenceImage?: string; sizes?: string[] }) {
    const brief = (body?.brief || '').trim();
    if (!brief) return { ok: false, message: 'Describe the design you want (e.g. "navy and orange baseball jersey, team Cougars").' };
    const gen = await this.imagegen.generateFromPrompt(designPrompt(brief), body?.referenceImage);
    const analysis = await this.analyzer.analyze({ imageBase64: gen.imageDataUrl });
    const match = this.cdl.match({
      sport: analysis.sport,
      garmentType: analysis.garmentType,
      division: analysis.division,
      keywords: [analysis.summary, ...analysis.keywords].join(' '),
      sizes: body?.sizes,
      // The 3D-editable path can only paint onto a style that ships a mesh.
      requireRenderable: true,
    });
    const conceptId = storeConcept(gen.imageDataUrl);
    // conceptId is the short handle the chat/panel pass around (fetch the bytes at
    // GET …/cdl/concept/:id); `concept` is the full data URL kept for the
    // standalone /cdl studio page and for immediate display without a round-trip.
    return {
      ok: true, conceptId, concept: gen.imageDataUrl, provider: gen.provider, analysis, match,
      suggestedConfig: match?.decision === 'use' ? suggestConfig(analysis, match) : null,
    };
  }

  /**
   * Path A — the FAITHFUL proof. Reproduce the customer's uploaded design (all-
   * over artwork, logo, colours, number) onto our matched template's garment via
   * image generation, so the proof actually looks like their design — which a
   * flat photo mapped onto the mesh's cut-piece UV atlas cannot do.
   * Body: { sku, artworkUrl | artworkBase64 }. Returns { proofId } (served by
   * GET cdl/concept/:id, same store).
   */
  @Post('proof')
  async proof(@Body() body: { sku?: string; artworkUrl?: string; artworkBase64?: string }) {
    const sku = String(body?.sku || '').trim();
    const artwork = body?.artworkBase64 || body?.artworkUrl;
    if (!sku || !artwork) return { ok: false, message: 'sku and artwork (artworkUrl or artworkBase64) are required.' };
    const t = this.cdl.get(sku);
    const garmentImage = t?.image;
    if (!garmentImage) return { ok: false, message: `No garment reference image for style ${sku}.` };
    try {
      const out = await this.imagegen.applyArtworkToGarment(garmentImage, artwork);
      const proofId = storeConcept(out.imageDataUrl);
      return { ok: true, proofId, provider: out.provider };
    } catch (e: any) {
      return { ok: false, message: `Could not build the proof: ${e?.message || e}` };
    }
  }

  /**
   * CDL-10 — DECOMPOSE a design into SEPARATE, editable layers so the layer
   * editor opens with no overlap. Given a stored design image (`sourceId` from
   * design/proof/concept), image-edit it into:
   *   - pattern: the all-over background with the logo, mascot, name & numbers
   *     REMOVED (filled with the surrounding pattern) — the clean base layer
   *   - logo: just the central crest/mascot + wordmark, isolated on white
   * Returns { patternId, logoId }, each served by GET cdl/concept/:id. The
   * editor then stacks pattern (base) + logo (movable) + live text — no baked
   * duplicates. Best-effort per layer.
   */
  @Post('decompose')
  async decompose(@Body() body: { sourceId?: string }) {
    const src = CONCEPTS.get(String(body?.sourceId || ''));
    if (!src) return { ok: false, message: 'source design not found (regenerate the design first).' };
    const dataUrl = `data:${src.mime};base64,${src.buf.toString('base64')}`;
    const patternPrompt =
      'From this jersey design, reproduce ONLY the all-over background pattern/texture. REMOVE the logo, mascot, crest, team name and any numbers, and fill those areas naturally with the surrounding pattern so it is seamless. ' +
      'Output a clean full-bleed all-over pattern with NO text, NO logo, NO numbers, NO garment shape — just the repeating artwork.';
    const logoPrompt =
      'From this jersey design, extract ONLY the central team logo/mascot/crest together with the team wordmark. Place it centered on a plain solid white background. ' +
      'NO jersey, NO all-over pattern, NO player number, NO fabric — just the isolated logo artwork, sticker style.';
    const out: any = { ok: true };
    // 1 — Gemini isolates the two rough layers in PARALLEL (~25-30s each).
    const [pat, logo] = await Promise.allSettled([
      this.imagegen.generateFromPrompt(patternPrompt, dataUrl),
      this.imagegen.generateFromPrompt(logoPrompt, dataUrl),
    ]);
    let patternUrl = pat.status === 'fulfilled' ? pat.value.imageDataUrl : null;
    let logoUrl = logo.status === 'fulfilled' ? logo.value.imageDataUrl : null;
    if (pat.status !== 'fulfilled') out.patternError = String(pat.reason?.message || pat.reason);
    if (logo.status !== 'fulfilled') out.logoError = String(logo.reason?.message || logo.reason);

    // 2 — FabricDiffusion refines them into production-clean ingredients:
    //     pattern → SEAMLESS tileable texture, logo → TRANSPARENT print.
    //     Run SEQUENTIALLY on purpose: the first call cold-starts the GPU (both
    //     checkpoints load in setup), and the second call then reuses that WARM
    //     instance in a couple of seconds — far better than firing both at once
    //     and cold-starting two instances that compete. Best-effort: on any
    //     miss we keep the Gemini layer.
    if (this.fabric.enabled) {
      if (patternUrl) {
        const ftex = await this.fabric.clean(patternUrl, 'texture');
        if (ftex) { patternUrl = ftex; out.refinedPattern = true; }
      }
      if (logoUrl) {
        const fprint = await this.fabric.clean(logoUrl, 'print');
        if (fprint) { logoUrl = fprint; out.refinedLogo = true; }
      }
    }

    if (patternUrl) out.patternId = storeConcept(patternUrl);
    if (logoUrl) out.logoId = storeConcept(logoUrl);
    if (!out.patternId && !out.logoId) return { ok: false, message: 'Could not separate the layers right now.' };
    return out;
  }

  /**
   * Faithful FLAT design texture (for the 3D projection). Body: { artworkBase64 |
   * artworkUrl }. Returns { flatId } — a flat, front-filling print of the design
   * that the 3D stage projects onto the mesh front.
   */
  @Post('flat')
  async flat(@Body() body: { artworkBase64?: string; artworkUrl?: string; sourceId?: string }) {
    // Accept a stored design handle (conceptId/proofId) OR raw artwork.
    let artwork = body?.artworkBase64 || body?.artworkUrl;
    if (!artwork && body?.sourceId) {
      const src = CONCEPTS.get(String(body.sourceId));
      if (src) artwork = `data:${src.mime};base64,${src.buf.toString('base64')}`;
    }
    if (!artwork) return { ok: false, message: 'artwork (artworkBase64, artworkUrl, or sourceId) is required.' };
    try {
      const out = await this.imagegen.makeFlatDesign(artwork);
      const flatId = storeConcept(out.imageDataUrl);
      return { ok: true, flatId, provider: out.provider };
    } catch (e: any) {
      return { ok: false, message: `Could not build the flat design: ${e?.message || e}` };
    }
  }

  /**
   * Coach team-order journey — FOUR FLAT VIEWS (front/back/left/right), cheap and
   * fast: plain image generation, no 3D bake. This is the first customer approval
   * checkpoint for a team design, well before any GLB is touched. Body:
   * { sourceId? | artworkBase64?, brief? }. Either a stored design handle
   * (sourceId — conceptId from /design) or raw artwork can seed the views; `brief`
   * is the running, accumulated description of edits ("make the body black,
   * orange shoulders...") re-applied each call so "edits" are really a fresh
   * regeneration from the updated brief, not a surgical pixel edit — be aware of
   * that limit before promising precision changes.
   * Returns { ok, frontId, backId, leftId, rightId } (best-effort per view; a
   * failed view is simply absent, never blocks the others). Each id is served by
   * the existing GET cdl/concept/:id.
   */
  @Post('flat-views')
  async flatViews(@Body() body: { sourceId?: string; artworkBase64?: string; artworkUrl?: string; brief?: string }) {
    let artwork = body?.artworkBase64 || body?.artworkUrl;
    if (!artwork && body?.sourceId) {
      const src = CONCEPTS.get(String(body.sourceId));
      if (src) artwork = `data:${src.mime};base64,${src.buf.toString('base64')}`;
    }
    if (!artwork && !body?.brief) {
      return { ok: false, message: 'sourceId, artwork (artworkBase64/artworkUrl), or a brief is required.' };
    }
    const brief = (body?.brief || '').trim();

    // View-specific prompts, same style as /decompose's pattern/logo prompts:
    // the reference (if any) supplies the design language; the brief text is the
    // accumulated edit instructions layered on top each call.
    const briefLine = brief ? `Apply these design instructions: "${brief}". ` : '';
    const prompts: Record<'front' | 'back' | 'left' | 'right', string> = {
      front: `${briefLine}Produce a FLAT, front-facing technical illustration of this team jersey design — front panel only, centred on a plain white background, no model, no mannequin, no 3D shading, no folds. Show the full front artwork edge to edge.`,
      back: `${briefLine}Produce a FLAT, back-facing technical illustration of the SAME team jersey design — back panel only (continue the colour blocking / pattern from the front; do NOT repeat the front's chest logo on the back), centred on a plain white background, no model, no mannequin, no 3D shading, no folds.`,
      left: `${briefLine}Produce a FLAT, left-side/sleeve technical illustration of the SAME team jersey design — left sleeve and side panel only, continuing the colour blocking and pattern flow (no logos or numbers on the sleeve), centred on a plain white background, no model, no 3D shading.`,
      right: `${briefLine}Produce a FLAT, right-side/sleeve technical illustration of the SAME team jersey design — right sleeve and side panel only, continuing the colour blocking and pattern flow (no logos or numbers on the sleeve), centred on a plain white background, no model, no 3D shading.`,
    };

    const views = ['front', 'back', 'left', 'right'] as const;
    const settled = await Promise.allSettled(
      views.map((v) => this.imagegen.generateFromPrompt(prompts[v], artwork)),
    );

    const out: any = { ok: true };
    settled.forEach((r, i) => {
      const v = views[i];
      if (r.status === 'fulfilled') {
        out[`${v}Id`] = storeConcept(r.value.imageDataUrl);
      } else {
        out[`${v}Error`] = String((r as PromiseRejectedResult).reason?.message || (r as PromiseRejectedResult).reason);
      }
    });
    if (!out.frontId && !out.backId && !out.leftId && !out.rightId) {
      return { ok: false, message: 'Could not generate the design views right now.' };
    }
    return out;
  }

  /**
   * P2 — FAITHFUL-IN-3D bake. Wrap the customer's design onto the REAL per-SKU
   * 3D mesh via the Python retexture-service: it renders the mesh per axis, has
   * Gemini paint the design onto each silhouette, and bakes the painted views
   * into a UV atlas → a `retextured.glb` that wraps collar, hem and sleeves.
   *
   * Body: { sku, front?|frontSourceId?, back?|backSourceId?, backText?, tier?, size? }
   *   - front/back: raw artwork (data URL or http URL); OR a stored concept
   *     handle via frontSourceId/backSourceId (conceptId/proofId/flatId).
   * Returns { ok, glbUrl, atlasUrl, previewUrl, diagnostics } — glbUrl is a real
   * URL the 3D panel loads directly. Falls back with ok:false (the caller keeps
   * the existing flat path) rather than throwing.
   */
  @Post('bake3d')
  async bake3d(
    @Param('projectId') projectId: string,
    @Body() body: {
      sku?: string; glbUrl?: string;
      front?: string; frontSourceId?: string;
      back?: string; backSourceId?: string;
      left?: string; leftSourceId?: string;
      right?: string; rightSourceId?: string;
      backText?: string; paintBack?: boolean; paintSides?: boolean;
      tier?: 'quality' | 'fast'; size?: number;
    },
  ) {
    const sku = String(body?.sku || '').trim();
    if (!sku) return { ok: false, message: 'sku is required.' };
    if (!this.retexture.enabled) {
      return { ok: false, message: 'The 3D bake service is not configured (RETEXTURE_SERVICE_URL).' };
    }

    // Resolve an artwork input (raw data/http URL, or a stored concept handle)
    // into the shape the retexture-service accepts: { url } or { base64 }.
    const resolveArt = (raw?: string, sourceId?: string): { url?: string; base64?: string } | null => {
      let art = raw;
      if (!art && sourceId) {
        const src = CONCEPTS.get(String(sourceId));
        if (src) art = `data:${src.mime};base64,${src.buf.toString('base64')}`;
      }
      if (!art) return null;
      if (art.startsWith('data:')) return { base64: art };          // service strips the data: prefix
      if (/^https?:\/\//.test(art)) return { url: art };
      return { base64: art };                                        // bare base64
    };

    const front = resolveArt(body?.front, body?.frontSourceId);
    if (!front) return { ok: false, message: 'front artwork is required (front, or frontSourceId).' };
    const back = resolveArt(body?.back, body?.backSourceId) || undefined;
    const left = resolveArt(body?.left, body?.leftSourceId) || undefined;
    const right = resolveArt(body?.right, body?.rightSourceId) || undefined;

    // The style's real 3D mesh URL — the shape authority for the bake. A caller
    // that already resolved the mesh (e.g. from a prior /products/render) can
    // pass glbUrl to skip the re-resolve; otherwise we resolve it from the SKU.
    // Only a renderable style ships a mesh; if it doesn't, say so plainly.
    let glbUrl = String(body?.glbUrl || '').trim();
    if (!glbUrl) {
      const render: any = await this.products.renderStyle((projectId || '').toLowerCase(), { style: sku });
      glbUrl = render?.geometry?.glb;
      if (!render?.renderable || !glbUrl) {
        const why = render?.reason || (render?.notes && render.notes[0]) || 'not-renderable';
        return { ok: false, message: `Style ${sku} has no 3D mesh, so it cannot be baked. (${why})` };
      }
    }

    const result = await this.retexture.bake({
      glb: { url: glbUrl },
      front,
      back,
      left,
      right,
      // With a roster the name/number is overlaid per player, so bake a
      // pattern-only back (paintBack) instead of baking one player's lettering.
      backText: body?.backText,
      paintBack: body?.paintBack ?? (!body?.backText && !back),
      // paintSides is OPT-IN, not default. Painting the flanks from the FRONT
      // design puts the front's bold graphics near the back seam, which back-
      // projects onto the shoulders/spine and corrupts an otherwise-clean back
      // (worse than a soft pure-profile side). The clean default = front + back
      // (+ roster overlay). Clean full-side coverage needs real 4-side art
      // (explicit left/right refs, which the pipeline paints and prefers).
      paintSides: body?.paintSides ?? false,
      tier: body?.tier || 'quality',
      size: body?.size || 4096,
      projectId: (projectId || '').toLowerCase(),
    });
    if (!result) {
      return { ok: false, message: `Could not bake the design onto the 3D garment (${this.retexture.lastReason}).` };
    }
    return { ok: true, sku, ...result };
  }

  /** Serve a generated concept image by id (from POST design). Public read. */
  @Get('concept/:id')
  concept(@Param('id') id: string, @Res() res: Response) {
    const c = CONCEPTS.get(id);
    if (!c) { res.status(404).send('not found'); return; }
    res.setHeader('Content-Type', c.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(c.buf);
  }

  // ── Design review (artist authority) ────────────────────────────────────
  /**
   * Submit the customer's design for artist review. Body: { sessionId, kind,
   * sku?, conceptId?, brief?, summary?, sizes?, customer? }. A 'create' (no
   * template) is flagged so the artist knows cut pieces must be generated at all
   * sizes before it can be approved. Returns the review record.
   */
  @Post('review')
  submitReview(@Param('projectId') projectId: string, @Body() body: any) {
    const sessionId = String(body?.sessionId || '').trim();
    const kind: 'use' | 'create' = body?.kind === 'create' ? 'create' : 'use';
    if (!sessionId) return { ok: false, message: 'sessionId is required.' };
    const jobId = randomUUID();
    const rev: CdlReview = {
      jobId, projectId, sessionId, kind,
      sku: body?.sku ? String(body.sku) : undefined,
      conceptId: body?.conceptId ? String(body.conceptId) : undefined,
      brief: body?.brief, summary: body?.summary,
      sizes: Array.isArray(body?.sizes) ? body.sizes : undefined,
      customer: body?.customer,
      roster: Array.isArray(body?.roster) ? body.roster : undefined,
      flatViews: body?.flatViews && typeof body.flatViews === 'object' ? body.flatViews : undefined,
      status: 'pending_artist',
      history: [{ at: nowIso(), event: 'submitted', note: kind === 'create' ? 'New design — cut pieces to be generated' : 'Design on existing template' }],
    };
    REVIEWS.set(jobId, rev);
    while (REVIEWS.size > REVIEW_CAP) REVIEWS.delete(REVIEWS.keys().next().value as string);
    return { ok: true, ...rev };
  }

  /** ARTIST action (back-office authority). Body: { approved, notes?, by? }.
   *  Approve → artist_approved; reject → changes_requested. */
  @Post('review/:jobId/artist')
  artistReview(@Param('jobId') jobId: string, @Body() body: any) {
    const rev = REVIEWS.get(jobId);
    if (!rev) return { ok: false, message: 'review not found' };
    const approved = !!body?.approved;
    rev.status = approved ? 'artist_approved' : 'changes_requested';
    rev.artist = { by: body?.by || 'artist', notes: body?.notes };
    rev.history.push({ at: nowIso(), event: approved ? 'artist_approved' : 'changes_requested', note: body?.notes });
    return { ok: true, ...rev };
  }

  /** CUSTOMER agrees to the proof. Only valid AFTER the artist approved — the
   *  two gates are independent and neither can act for the other. On agreement
   *  the design becomes ready_for_print. Body: { sessionId }. */
  @Post('review/:jobId/agree')
  agreeReview(@Param('jobId') jobId: string, @Body() body: any) {
    const rev = REVIEWS.get(jobId);
    if (!rev) return { ok: false, message: 'review not found' };
    if (rev.status !== 'artist_approved' && rev.status !== 'customer_agreed') {
      return { ok: false, status: rev.status, message: 'The artist has not approved this proof yet — cannot agree to print.' };
    }
    rev.status = 'ready_for_print';
    rev.history.push({ at: nowIso(), event: 'customer_agreed' }, { at: nowIso(), event: 'ready_for_print' });
    return { ok: true, ...rev };
  }

  /** Read one review record. */
  @Get('review/:jobId')
  getReview(@Param('jobId') jobId: string) {
    const rev = REVIEWS.get(jobId);
    return rev ? { ok: true, ...rev } : { ok: false, message: 'review not found' };
  }

  /**
   * Production JSON — a shaped read over the existing review record, no new data
   * model. This is what an Augusta artist (or a manufacturing handoff) actually
   * needs: garment identity, the approved flat views, and the full roster in one
   * object, rather than reconstructing it from separate API calls.
   */
  @Get('review/:jobId/production')
  getProduction(@Param('jobId') jobId: string) {
    const rev = REVIEWS.get(jobId);
    if (!rev) return { ok: false, message: 'review not found' };
    const t = rev.sku ? this.cdl.get(rev.sku) : undefined;
    return {
      ok: true,
      jobId: rev.jobId,
      status: rev.status,
      sku: rev.sku,
      sport: t?.sport,
      garmentType: t?.garmentType,
      garmentName: t?.name,
      brief: rev.brief,
      summary: rev.summary,
      artwork: rev.flatViews
        ? {
            front: rev.flatViews.frontId ? `/api/v1/${rev.projectId}/cdl/concept/${rev.flatViews.frontId}` : undefined,
            back: rev.flatViews.backId ? `/api/v1/${rev.projectId}/cdl/concept/${rev.flatViews.backId}` : undefined,
            left: rev.flatViews.leftId ? `/api/v1/${rev.projectId}/cdl/concept/${rev.flatViews.leftId}` : undefined,
            right: rev.flatViews.rightId ? `/api/v1/${rev.projectId}/cdl/concept/${rev.flatViews.rightId}` : undefined,
          }
        : rev.conceptId
          ? { concept: `/api/v1/${rev.projectId}/cdl/concept/${rev.conceptId}` }
          : undefined,
      roster: rev.roster || [],
      playerCount: rev.roster?.length || 0,
      sizes: rev.sizes,
      customer: rev.customer,
      artist: rev.artist,
      history: rev.history,
    };
  }

  /** List reviews for a session (agent/panel) or all pending (artist queue). */
  @Get('reviews')
  listReviews(@Query('sessionId') sessionId?: string, @Query('status') status?: string) {
    let list = [...REVIEWS.values()];
    if (sessionId) list = list.filter((r) => r.sessionId === sessionId);
    if (status) list = list.filter((r) => r.status === status);
    return { ok: true, count: list.length, reviews: list };
  }

  /**
   * Step 2 → Step 3 in one call: analyse the uploaded design, then match it to
   * the library. Body: { imageUrl | imageBase64, sizes?[] }.
   * Returns { analysis, match: { decision:'use'|'create', best, results } }.
   */
  @Post('analyze')
  async analyze(@Body() body: AnalyzeInput) {
    const analysis = await this.analyzer.analyze(body || {});
    const match = this.cdl.match({
      sport: analysis.sport,
      garmentType: analysis.garmentType,
      division: analysis.division,
      keywords: [analysis.summary, ...analysis.keywords].join(' '),
      sizes: body?.sizes,
      // The 3D-editable path can only paint onto a style that ships a mesh.
      requireRenderable: true,
    });
    return { analysis, match, suggestedConfig: match?.decision === 'use' ? suggestConfig(analysis, match) : null };
  }

  @Get('facets')
  facets() {
    return { libraryCount: this.cdl.count(), source: this.cdl.source(), ...this.cdl.facets() };
  }

  @Get('templates')
  templates(
    @Query('sport') sport?: string,
    @Query('garmentType') garmentType?: string,
    @Query('division') division?: string,
    @Query('q') q?: string,
    @Query('renderable') renderable?: string,
    @Query('limit') limit?: string,
  ) {
    const norm = (s?: string) => (s || '').toLowerCase().trim();
    let list = this.cdl.all();
    if (sport) list = list.filter((t) => norm(t.sport) === norm(sport) || norm(t.sport).includes(norm(sport)));
    if (garmentType) list = list.filter((t) => norm(t.garmentType) === norm(garmentType));
    if (division) list = list.filter((t) => norm(t.division) === norm(division));
    if (renderable === 'true') list = list.filter((t) => t.renderable === true);
    if (q) {
      const kw = norm(q);
      list = list.filter((t) => norm(t.name).includes(kw) || t.parentSku.includes(kw));
    }
    const n = Math.max(1, Math.min(Number(limit) || 100, 500));
    return { total: list.length, templates: list.slice(0, n) };
  }

  @Get('templates/:sku')
  template(@Param('sku') sku: string) {
    const t = this.cdl.get(sku);
    return t ? { found: true, template: t } : { found: false };
  }

  @Post('match')
  match(@Body() body: MatchQuery) {
    // body = the design-analysis output: { sport, garmentType, division, keywords, sizes[] }
    return this.cdl.match(body || {});
  }

  @Post('reload')
  reload() {
    return { reloaded: true, count: this.cdl.reload() };
  }
}
