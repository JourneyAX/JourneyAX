import { Injectable } from '@nestjs/common';

/**
 * RenderService (AUG-21 / AUG-29) — turn a design into a real garment.
 *
 * The pipeline, verified end to end against the brand's own tooling:
 *
 *   design ─► Scene7 composites a TEXTURE ATLAS: every cut panel of the garment
 *             laid flat, with the design line, colours and lettering burned in.
 *             This is the same artwork that drives the sublimation printer.
 *          ─► the atlas is applied as `map_Kd` to a per-style 3D MESH
 *             ({style}.obj + {style}.mtl, exported from Blender) whose UVs place
 *             each panel where it belongs.
 *          ─► the browser renders that mesh with orbit controls.
 *
 * Corrections to earlier assumptions, each of which cost a real bug:
 *
 *  1. `preview-prod-{style}-l` is NOT "a finished flat photo". It IS the texture
 *     atlas, it is publicly fetchable, and it is what belongs on the mesh. The
 *     `preview-{style}_front` id is a different, older namespace that exists for
 *     only a minority of styles.
 *  2. Both id patterns exist and NEITHER covers the whole catalogue, so the
 *     usable pattern is resolved per style at ingest and stored — never guessed
 *     at request time. A style with no atlas is not renderable, and we say so
 *     rather than emitting a URL that hangs.
 *  3. Colours are brand-palette NAMES ("RA TRUE RED"), not generic English
 *     ("Scarlet") and not hex. An unknown name does not error — Scene7 quietly
 *     substitutes a default, which is how a customer ends up shown a colour they
 *     never chose. Validation therefore happens before we ever build a URL.
 *  4. The body only fills once a design line layer is switched on
 *     (`setAttr.{designLine}={visible=true}`). Colours alone leave it blank.
 *
 * Everything vendor-specific — hosts, id patterns, the palette, zone names —
 * is per-project config, because the next tenant names all of it differently.
 */

export interface GarmentGeometry {
  /** Preferred mesh: glTF binary. Roughly a third the size of the OBJ. */
  glb: string;
  /**
   * Legacy mesh, kept for styles that predate the glTF export.
   *
   * Optional because headwear has no OBJ at all — it is published only as
   * glTF. Emitting a constructed `.obj` URL to satisfy the type would put a
   * link that 404s in front of the viewer's fallback path.
   */
  obj?: string;
  /** Materials for the OBJ path; its map_Kd is replaced with the atlas. */
  mtl?: string;
  /** Normal map — gives the fabric its weave instead of a flat diffuse. */
  normalMap?: string;
  /** HDR environment map for lighting. */
  envMap?: string;
  /** Which mesh the viewer should actually load. Not every style has a glTF. */
  format?: 'glb' | 'obj';
}

export interface RendererConfig {
  /** e.g. https://service.momentecbrands.com/w2p/api/is */
  textureBase?: string;
  /**
   * Ordered atlas id patterns to try; {style} is substituted. Resolution order
   * matters — the first that exists for a style wins.
   */
  texturePatterns?: string[];
  /** Where {style}.obj / {style}.mtl are served from. */
  modelBase?: string;
  envMap?: string;
  /** Atlas width. Print needs ~2000; on-screen preview is fine at 1200. */
  width?: number;
  /** Colour zone names, in layer order (from the style's .mtl). */
  colourSlots?: string[];
  /** Text zones: which garment location each text field maps to. */
  textSlots?: { key: string; slot: string; fontSize?: number; weight?: number }[];
  defaultFont?: string;
  /**
   * The brand colour palette. Requests are validated against it, because an
   * unrecognised name renders as a silent substitution rather than an error.
   */
  palette?: string[];
  /**
   * The style's captured cap configuration, when it has one (CAP-1).
   *
   * Present only for headwear that the capture stage confirmed is configurable:
   * colours AND a mesh both resolved. Its presence is what switches this
   * service from composing a texture to returning a per-mesh colour map.
   */
  cap?: {
    meshUrl?: string;
    meshes?: string[];
    colours?: { code: string; name?: string; meshes: Record<string, string> }[];
  };
  /** Resolved at request time by the geometry probe, not authored in config. */
  meshFormat?: 'glb' | 'obj';
  /** This style's catalogue photograph, resolved at request time. */
  catalogueImage?: string;
  /** Text-zone UV rectangles, resolved at request time (AUG-37). */
  textZones?: { key: string; slot: string; uv: [number, number, number, number] }[];
  /**
   * This style's design lines and the colour zones each exposes, resolved at
   * request time from the catalogue API (AUG-23). Keyed by layer slug.
   * When present it OVERRIDES colourSlots — a fixed slot list is wrong, because
   * zones differ per style and per design line.
   */
  designLines?: Record<string, { label: string; zones: string[] }>;
  /** Lettering positions this style prints (AUG-45) — empty means it takes none. */
  letteringSlots?: string[];
}

export interface RenderRequest {
  style: string;
  /** Ordered brand-palette colour names, mapped onto colourSlots. */
  colours?: string[];
  /** Text by key: { teamName: 'SCARLET HAWKS', number: '23' } */
  text?: Record<string, string>;
  /** Lettering fill / outline. Explicit — never derived from colour position. */
  textColour?: string;
  outlineColour?: string;
  font?: string;
  /** Pattern layer to switch on, e.g. 'serpentine'. Without it the body is blank. */
  designLine?: string;
  width?: number;
}

export interface RenderResult {
  style: string;
  /** True only when we know an atlas exists for this style. */
  renderable: boolean;
  /**
   * Which mechanism produced this result (CAP-1).
   *
   * Set to 'cap' when the garment is coloured client-side from a per-mesh map
   * rather than by a composed texture. The viewer branches on this rather than
   * on the absence of `texture`, so a genuine texture failure is never
   * mistaken for a cap.
   */
  decorationSystem?: 'cap';
  /** The colourway to apply, mesh name → hex. Caps only. */
  capColourway?: { code: string; name?: string; meshes: Record<string, string> };
  /** Every colourway this cap is made in, for the picker. */
  capColours?: { code: string; name?: string }[];
  /** False when the requested colour is not one this cap is made in. */
  colourMatched?: boolean;
  /** The composed texture atlas — this is what goes on the mesh. */
  texture?: string;
  /** Mesh + materials, when this style has geometry. */
  geometry?: GarmentGeometry;
  /** Colours that are not in the brand palette; never silently substituted. */
  rejectedColours?: string[];
  /** Design lines this style actually offers, so the agent can offer real ones. */
  designLines?: { slug: string; label: string; zones: string[] }[];
  /** The design line actually rendered (may be a fallback the caller did not ask for). */
  appliedDesignLine?: string;
  designLineDefaulted?: boolean;
  /** Count of zones that reused a colour to avoid leaving a factory default. */
  zonesFilledByRepeat?: number;
  /** Lettering positions this style prints. Empty/absent means the garment
   *  takes no name or number, and the UI must not offer those fields. */
  letteringSlots?: string[];
  /** The zones the requested design line exposes, in the order colours map onto. */
  zones?: string[];
  /**
   * Where each text zone sits on the garment, in atlas UV space, so a click on
   * the mesh can be resolved to the thing the customer actually touched.
   */
  textZones?: { key: string; slot: string; uv: [number, number, number, number] }[];
  /**
   * Machine-readable reason the preview is limited, for the UI to write its own
   * customer-facing copy from. `notes` are DIAGNOSTICS for developers and must
   * never be shown to a customer verbatim — they contain instructions to us.
   */
  reason?: 'no-atlas' | 'design-line-not-on-style' | 'no-body-zone' | 'no-design-line' | 'no-mesh'
    | 'colour-not-on-style';
  /** Catalogue photograph, when the style cannot be previewed live. */
  catalogueImage?: string;
  notes: string[];
}

const DEFAULTS = {
  width: 1200,
  colourSlots: [
    'SUB_FIRST_BODY_COLOR',
    'SUB_FIRST_ACCENT_1',
    'SUB_FIRST_ACCENT_2',
    'SUB_FIRST_ACCENT_3',
  ],
  defaultFont: 'Stinger',
  texturePatterns: ['preview-prod-{style}-l', 'preview-{style}_front'],
  textSlots: [
    { key: 'teamName', slot: 't2', fontSize: 78.06, weight: 1.5 },
    { key: 'number', slot: 't7', fontSize: 208.16, weight: 4 },
    { key: 'numberSmall', slot: 't21', fontSize: 104.08, weight: 2 },
  ],
};

@Injectable()
export class RenderService {
  /** Scene7 wants colour as an XML fill fragment naming a palette entry. */
  private colourXml(name: string): string {
    return `<fill><SolidColor s7:colorName='${name}' s7:colorValue='#FF' s7:colorspace='defined'/></fill>`;
  }

  private textXml(text: string): string {
    return `<content><p><span>${text}</span></p></content>`;
  }

  /**
   * Text styling is a nested query string INSIDE a parameter value, so its
   * separators must stay literal `&` — encoding them breaks the whole element
   * silently (the lettering simply vanishes from the render).
   */
  private textAttr(font: string, colour: string, outline: string, size: number, weight: number): string {
    return `{visible=true&s7:colorName=${colour}&s7:strokeColorName=${outline}`
      + `&fontFamily=${font}&ATE:C_horizontalScale=0.50`
      + `&fontSize=${size}&s7:maxFontSize=${size}&s7:weight=${weight}`
      + `&x_movement=0&y_movement=0}`;
  }

  /**
   * Colours the palette does not contain are dropped, not passed through.
   * Scene7 substitutes a default for an unknown name instead of failing, so
   * passing one through means quoting a customer a garment in a colour nobody
   * picked. With no palette configured we cannot check, and say so.
   */
  private vet(colours: string[], palette?: string[]): { ok: string[]; rejected: string[] } {
    if (!palette?.length) return { ok: colours, rejected: [] };
    const known = new Map(palette.map((p) => [p.trim().toUpperCase(), p]));
    const ok: string[] = [];
    const rejected: string[] = [];
    for (const c of colours) {
      const hit = known.get(c.trim().toUpperCase());
      if (hit) ok.push(hit);
      else rejected.push(c);
    }
    return { ok, rejected };
  }

  /**
   * The colour zones for THIS style and design line.
   *
   * Falls back to the configured slot list only when the catalogue could not be
   * read — never as a default, because guessing zones is what made garments
   * render blank in the first place.
   */
  private zonesFor(req: RenderRequest, cfg: RendererConfig): string[] {
    const map = this.designLineMap(cfg);
    const slug = req.designLine?.trim().toLowerCase();
    const known = slug ? map?.[slug] : undefined;
    if (known?.zones?.length) return known.zones;
    return cfg.colourSlots?.length ? cfg.colourSlots : DEFAULTS.colourSlots;
  }

  /**
   * Design lines only count when they were resolved for THIS style. Project
   * config may also carry a hand-authored list, but that is an array and
   * belongs to whichever style it was copied from — treating it as the
   * per-style map would key off array indices and silently mis-report which
   * design lines a garment offers.
   */
  /** Set while composing a texture; read when building the response. */
  private appliedLine?: string;
  /** How many zones had to reuse a colour because fewer were supplied. */
  private zonesFilledByRepeat = 0;

  private designLineMap(cfg: RendererConfig): Record<string, { label: string; zones: string[] }> | null {
    const dl = cfg.designLines as unknown;
    if (!dl || typeof dl !== 'object' || Array.isArray(dl)) return null;
    return dl as Record<string, { label: string; zones: string[] }>;
  }

  /** Build the Scene7 atlas URL for a resolved texture id. */
  buildTexture(req: RenderRequest, cfg: RendererConfig, textureId: string): string {
    const base = (cfg.textureBase || '').replace(/\/$/, '');
    const slots = this.zonesFor(req, cfg);
    const font = req.font || cfg.defaultFont || DEFAULTS.defaultFont;
    const width = req.width || cfg.width || DEFAULTS.width;

    const p = new URLSearchParams();
    p.set('fmt', 'png');
    p.set('wid', String(width));
    p.set('setAttr.swatch', '{visible=false}');
    /* Without a design line the pattern layer stays hidden and the body renders
     * blank no matter what colours are supplied. This was documented here and
     * then not guarded: a customer asked for a navy jersey, got a WHITE one with
     * navy lettering, and every check passed because the colours really were
     * sent — they simply had no visible layer to land on.
     *
     * So when the caller names no design line, the style's own widest one is
     * used and reported back, rather than shipping a blank garment. Showing a
     * real design the customer can change beats showing nothing and calling it
     * their colours. */
    const named = req.designLine?.trim().toLowerCase();
    const dlAll = this.designLineMap(cfg);
    const fallback = !named && dlAll
      ? Object.entries(dlAll).sort((a, b) => (b[1]?.zones?.length || 0) - (a[1]?.zones?.length || 0))
          .filter(([, v]) => (v?.zones?.length || 0) > 0)[0]?.[0]
      : undefined;
    const activeLine = named || fallback;
    if (activeLine) p.set(`setAttr.${activeLine}`, '{visible=true}');
    this.appliedLine = activeLine;

    const { ok } = this.vet(req.colours || [], cfg.palette);
    /* EVERY zone gets one of the customer's colours.
     *
     * Setting only as many zones as colours supplied leaves the rest on a
     * factory default, and the customer wears a colour they never chose: a
     * school asking for navy and Vegas gold received a jersey with an ORANGE
     * stripe, because the design had three zones and only two were set. The
     * same defect put a green band on a Mardi Gras jersey.
     *
     * Colours are therefore cycled across the remaining zones. Repeating a
     * chosen colour is always defensible — it is theirs — whereas an unset zone
     * is an unrequested colour on a garment someone will wear. */
    if (ok.length) {
      slots.forEach((slot, i) => {
        const c = ok[i % ok.length];
        if (c && slot) p.set(`setElement.${slot}`, this.colourXml(c));
      });
      this.zonesFilledByRepeat = Math.max(0, slots.length - ok.length);
    } else {
      this.zonesFilledByRepeat = 0;
    }

    const textSlots = cfg.textSlots?.length ? cfg.textSlots : DEFAULTS.textSlots;
    const fill = req.textColour || ok[1] || ok[0] || 'RA WHITE';
    const outline = req.outlineColour || ok[0] || 'RA BLACK';
    for (const t of textSlots) {
      const value = req.text?.[t.key];
      if (!value) continue;
      p.set(`setElement.${t.slot}`, this.textXml(value));
      p.set(`setAttr.${t.slot}`, this.textAttr(font, fill, outline, t.fontSize ?? 78, t.weight ?? 1.5));
    }
    p.set('isFontSizeCorrected', 'true');
    return `${base}/${textureId}?${p.toString()}`;
  }

  /**
   * A style is renderable only if an atlas id actually resolves. Ingest records
   * the winning pattern per style; `resolvedPattern` is that stored value.
   * Callers that pass nothing get renderable:false rather than a URL that hangs
   * forever on a missing template.
   */
  /**
   * Render a cap.
   *
   * The whole of the design-line and atlas machinery below is inapplicable
   * here: a cap has no design lines and no composed texture, only a set of
   * pre-authored colourways, each a map of mesh name → hex that the viewer
   * applies to the mesh it already loaded.
   *
   * The customer's colour is matched by NAME against the colourway names taken
   * from the variant rows. If their colour is not one this cap comes in, the
   * result says so and falls back to the style's first colourway rather than
   * silently rendering something close — showing a customer a navy cap when
   * they asked for royal is exactly the substitution AUG-27 forbids.
   */
  /* See pickCapColourway below — kept module-scope so it is unit-testable. */

  private buildCap(req: RenderRequest, cfg: RendererConfig): RenderResult {
    const notes: string[] = [];
    const cap = cfg.cap!;
    const colours = cap.colours || [];

    if (!colours.length || !cap.meshUrl) {
      notes.push('This cap has no captured colourways, so it cannot be previewed.');
      return {
        style: req.style, renderable: false, reason: 'no-atlas',
        catalogueImage: cfg.catalogueImage, notes,
      };
    }

    const wanted = (req.colours || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    const match = wanted.length ? pickCapColourway(colours, wanted) : undefined;

    /* No match must NOT render. The previous code fell through to colours[0] and
     * still returned renderable:true, so asking for orange showed a dark green
     * cap — a colour the customer never chose, presented as if it were theirs.
     * Showing the wrong colour is worse than showing none: refuse, say why, and
     * hand back the real colourways so the customer can pick one that exists. */
    if (wanted.length && !match) {
      const offered = colours.map((c) => c.name).filter(Boolean) as string[];
      notes.push(
        `This cap does not come in ${wanted.join(' or ')}. `
        + (offered.length ? `It is made in: ${offered.slice(0, 12).join(', ')}.` : 'Its colours are unnamed in the catalogue.'),
      );
      return {
        style: req.style,
        renderable: false,
        reason: 'colour-not-on-style',
        decorationSystem: 'cap',
        colourMatched: false,
        capColours: colours.map((c) => ({ code: c.code, name: c.name })),
        catalogueImage: cfg.catalogueImage,
        notes,
      };
    }
    const chosen = match || colours[0];

    return {
      style: req.style,
      renderable: true,
      /* The mesh is served with permissive CORS, same as the garment library,
         so the browser loads it directly. There is no texture to proxy. */
      geometry: { glb: cap.meshUrl, format: 'glb', envMap: cfg.envMap },
      capColourway: { code: chosen.code, name: chosen.name, meshes: chosen.meshes },
      capColours: colours.map((c) => ({ code: c.code, name: c.name })),
      /* Stated plainly so the caller never has to infer it from shape. */
      decorationSystem: 'cap',
      colourMatched: match ? true : wanted.length ? false : undefined,
      catalogueImage: cfg.catalogueImage,
      notes,
    };
  }

  build(req: RenderRequest, cfg: RendererConfig = {}, resolvedPattern?: string): RenderResult {
    // Headwear is configured by colourway, not by atlas — take that path first.
    if (cfg.cap) return this.buildCap(req, cfg);

    const notes: string[] = [];
    const { rejected } = this.vet(req.colours || [], cfg.palette);
    if (rejected.length) {
      notes.push(
        `Not in this brand's palette, so left unset rather than substituted: ${rejected.join(', ')}.`,
      );
    }
    if (!cfg.palette?.length) {
      notes.push('No palette configured for this project — colour names cannot be validated.');
    }
    // A design line the style does not offer leaves its layer hidden, so every
    // colour silently does nothing and the garment renders blank. Say which
    // ones exist rather than producing a plausible-looking empty jersey.
    let reason: RenderResult['reason'];
    const dlMap = this.designLineMap(cfg);
    const available = dlMap ? Object.keys(dlMap) : null;
    const slug = req.designLine?.trim().toLowerCase();
    if (!req.designLine) {
      notes.push(
        available?.length
          ? `No design line selected, so the body renders unfilled. This style offers: ${available.join(', ')}.`
          : 'No design line selected, so the body renders unfilled.',
      );
    } else if (available?.length && !available.includes(slug!)) {
      reason = 'design-line-not-on-style';
      notes.push(
        `"${req.designLine}" is not a design line on style ${req.style}, so nothing would be filled. `
        + `Available: ${available.join(', ')}.`,
      );
    } else if (available?.length) {
      const zones = dlMap![slug!].zones;
      // Some design lines genuinely have no solid body zone — "hitter" starts at
      // ACCENT_1. That is not a failure, but the customer should be told why the
      // body is not taking their colour.
      if (!zones.some((z) => /BODY_COLOR$/.test(z))) {
        reason = 'no-body-zone';
        notes.push(
          `The "${dlMap![slug!].label}" design has no solid body colour — `
          + `its colours are ${zones.join(', ')}.`,
        );
      }
    }

    if (!resolvedPattern) {
      notes.push('No texture atlas resolved for this style; fall back to the catalogue photo.');
      return {
        style: req.style, renderable: false, reason: 'no-atlas',
        catalogueImage: cfg.catalogueImage, rejectedColours: rejected, notes,
      };
    }

    const textureId = resolvedPattern.replace('{style}', req.style);
    const texture = this.buildTexture(req, cfg, textureId);

    let geometry: GarmentGeometry | undefined;
    if (cfg.modelBase) {
      // The mesh library is laid out one folder per style, each holding the
      // glTF, the legacy OBJ/MTL and a normal map. Unlike the imaging host this
      // CDN sends `access-control-allow-origin: *`, so the browser can load
      // geometry directly — only the texture has to go through our proxy.
      const dir = `${cfg.modelBase.replace(/\/$/, '')}/${req.style}`;
      geometry = {
        glb: `${dir}/${req.style}.glb`,
        obj: `${dir}/${req.style}.obj`,
        mtl: `${dir}/${req.style}.mtl`,
        normalMap: `${dir}/${req.style}-NormalMap.png`,
        envMap: cfg.envMap,
        format: cfg.meshFormat || 'glb',
      };
    } else {
      notes.push('No modelBase configured — the atlas can be shown flat but not on the garment.');
    }

    return {
      style: req.style,
      renderable: true,
      texture,
      geometry,
      rejectedColours: rejected.length ? rejected : undefined,
      designLines: dlMap
        ? Object.entries(dlMap).map(([s, v]) => ({ slug: s, label: v.label, zones: v.zones }))
        : undefined,
      zones: this.zonesFor(req, cfg),
      /* Which design line the garment is actually WEARING. When the caller
       * named none, this is the fallback that was chosen for them — the UI and
       * the agent need it so they describe the garment on screen rather than
       * the one that was asked for. */
      appliedDesignLine: this.appliedLine,
      designLineDefaulted: this.appliedLine && !req.designLine ? true : undefined,
      /* Zones that reused a supplied colour because the design has more zones
       * than the customer named — worth surfacing so they can choose a colour
       * for each rather than accept a repeat. */
      zonesFilledByRepeat: this.zonesFilledByRepeat || undefined,
      textZones: cfg.textZones,
      letteringSlots: cfg.letteringSlots,
      reason,
      catalogueImage: cfg.catalogueImage,
      notes,
    };
  }
}

/**
 * Pick the cap colourway the customer actually asked for.
 *
 * Cap colourways are compound: "BLACK/RED", "COLUMBIA BLUE/WHITE/COLUMBIA B",
 * "DARK GREEN/WHITE/DARK GREEN". The old matcher compared the WHOLE name to the
 * requested colour, so only single-word colourways (NAVY, BLACK, WHITE) ever
 * matched; "red" missed "BLACK/RED" and the caller then rendered an arbitrary
 * fallback. Match on components instead, and prefer the colourway where the
 * requested colour is DOMINANT — the first component is the crown colour, so
 * "red" should give RED/WHITE, not BLACK/RED where red is only the trim.
 *
 * Returns undefined when nothing genuinely matches, so the caller can refuse
 * rather than substitute.
 */
export function pickCapColourway<T extends { code: string; name?: string }>(
  colours: T[],
  wanted: string[],
): T | undefined {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wants = wanted.map(norm).filter(Boolean);
  if (!wants.length) return undefined;

  let best: T | undefined;
  let bestScore = 0;
  let bestParts = Infinity;

  for (const c of colours) {
    if (!c.name) continue;
    const full = norm(c.name);
    const parts = String(c.name).split('/').map(norm).filter(Boolean);
    let score = 0;
    for (const w of wants) {
      // Word-level membership inside a component: "orange" is genuinely present
      // in "BLAZE ORANGE", which whole-component comparison alone would miss.
      const inWords = parts.some((p) => p.split(' ').includes(w));
      if (full === w) score += 100;                       // exact whole colourway
      else if (parts[0] === w) score += 60;               // dominant (crown) colour
      else if (parts.includes(w)) score += 30;            // present as a component
      else if (parts[0]?.split(' ').includes(w)) score += 25; // word of the crown colour
      else if (inWords) score += 20;                      // word of some component
      else if (parts.some((p) => p.startsWith(w))) score += 15; // truncated feed value
    }
    if (!score) continue;
    // Tie-break toward the simpler colourway: a plain RED beats BLACK/RED/BLACK.
    if (score > bestScore || (score === bestScore && parts.length < bestParts)) {
      best = c; bestScore = score; bestParts = parts.length;
    }
  }
  return bestScore > 0 ? best : undefined;
}
