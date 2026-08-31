import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CDL Template Library + Match service.
 *
 * The backbone of the Custom Design Line "check the templates" step
 * (docs/augusta-cdl-spec.md, step 3). It holds Augusta's designable garment
 * catalogue — one entry per Parent_SKU, extracted from Augusta's public
 * sublimation feed — and answers the only question that matters at intake:
 *
 *   "Given what the customer uploaded, do we already have a matching template
 *    WITH ALL THE SIZES?  Yes → use it.  No → create it."
 *
 * The library itself is built by data/cdl/build-probe.py from the feed; this
 * service just loads the resulting template-library.json and ranks matches.
 * See docs/augusta-cdl-template-library-howto.md.
 */

export interface CdlTemplate {
  parentSku: string;
  name: string;
  division: string;        // Adult | Youth | Ladies | Girls
  sport: string;           // BASEBALL | BASKETBALL | HOCKEY | …
  garmentType: string;     // TOP | BOTTOM | …
  category: string;        // raw "Division | Sport | Type"
  sizes: string[];
  coreSizesPresent: boolean;
  colorCount: number;
  msrp: string;
  image: string;
  w2pTemplate: string;     // preview-prod-{sku}-l
  w2pUrlBase: string;      // …/preview-prod-{sku}-{size}?fmt=png&wid=2000
  renderable?: boolean | null;
  renderSize?: string;
}

export interface MatchQuery {
  sport?: string;
  garmentType?: string;
  division?: string;
  /** Free text from the design analysis (garment name / features). */
  keywords?: string;
  /** Sizes the order needs; defaults to the core run S/M/L/XL. */
  sizes?: string[];
  limit?: number;
  /**
   * The 3D-editable CDL path can only put artwork on a style that ships a real
   * mesh. When set, the matcher considers ONLY renderable templates, so a design
   * never lands on a style we cannot show on the garment. The closest renderable
   * garment (e.g. a V-neck hockey jersey vs a lace-up) is honest 3D; a flat photo
   * is not. The tradeoff (collar/closure) is surfaced to the customer upstream.
   */
  requireRenderable?: boolean;
}

export interface MatchResult {
  template: CdlTemplate;
  score: number;
  sizeOk: boolean;
  missingSizes: string[];
}

export interface MatchResponse {
  /** True when the top match is confident AND has all requested sizes → "use it". */
  exists: boolean;
  decision: 'use' | 'create';
  best: MatchResult | null;
  results: MatchResult[];
  libraryCount: number;
}

const CORE = ['S', 'M', 'L', 'XL'];

@Injectable()
export class CdlTemplateService {
  private readonly log = new Logger('CdlTemplateService');
  private templates: CdlTemplate[] = [];
  private loadedFrom = '';

  constructor() {
    this.load();
  }

  /** Find template-library.json wherever the service is launched from. */
  private resolvePath(): string | null {
    const rel = 'data/cdl/template-library.json';
    const candidates: string[] = [];
    if (process.env.CDL_LIBRARY_PATH) candidates.push(process.env.CDL_LIBRARY_PATH);
    candidates.push(path.resolve(process.cwd(), rel));
    // Walk up from this file to the monorepo root (data/cdl lives there).
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, rel));
      dir = path.dirname(dir);
    }
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
  }

  private load(): void {
    const p = this.resolvePath();
    if (!p) {
      this.log.warn('CDL template library not found — match will return empty (set CDL_LIBRARY_PATH).');
      return;
    }
    try {
      this.templates = JSON.parse(fs.readFileSync(p, 'utf8'));
      this.loadedFrom = p;
      this.log.log(`Loaded ${this.templates.length} CDL templates from ${p}`);
    } catch (e) {
      this.log.error(`Failed to load CDL library: ${(e as Error).message}`);
    }
  }

  /** Hot-reload the library (after a feed refresh rebuilds the JSON). */
  reload(): number {
    this.load();
    return this.templates.length;
  }

  all(): CdlTemplate[] { return this.templates; }
  count(): number { return this.templates.length; }
  source(): string { return this.loadedFrom; }
  get(sku: string): CdlTemplate | null {
    return this.templates.find((t) => t.parentSku === sku) || null;
  }

  /** Distinct sports/garment types in the library (for UI filters / the analyzer prompt). */
  facets(): { sports: string[]; garmentTypes: string[]; divisions: string[] } {
    const s = new Set<string>(), g = new Set<string>(), d = new Set<string>();
    for (const t of this.templates) {
      if (t.sport) s.add(t.sport);
      if (t.garmentType) g.add(t.garmentType);
      if (t.division) d.add(t.division);
    }
    return { sports: [...s].sort(), garmentTypes: [...g].sort(), divisions: [...d].sort() };
  }

  private norm(s?: string): string { return (s || '').toLowerCase().trim(); }

  /**
   * Rank the library against the analysed design. Deterministic scoring —
   * sport is the dominant signal, then garment type, division, and name keywords.
   */
  match(q: MatchQuery): MatchResponse {
    const sport = this.norm(q.sport);
    const gtype = this.norm(q.garmentType);
    const division = this.norm(q.division);
    const kw = this.norm(q.keywords).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const wantSizes = (q.sizes && q.sizes.length ? q.sizes : CORE).map((s) => s.toUpperCase());

    // The 3D-editable path can only paint onto styles that ship a mesh.
    const pool = q.requireRenderable ? this.templates.filter((t) => t.renderable) : this.templates;

    const scored: MatchResult[] = pool
      .map((t): MatchResult => {
        const ts = this.norm(t.sport), tg = this.norm(t.garmentType), td = this.norm(t.division), tn = this.norm(t.name);
        let score = 0;
        if (sport) {
          if (ts === sport) score += 50;
          else if (ts && (ts.includes(sport) || sport.includes(ts))) score += 28;
          else if (tn.includes(sport)) score += 12;
        }
        if (gtype && (tg === gtype || tn.includes(gtype))) score += 18;
        if (division && td === division) score += 14;
        for (const w of kw) if (tn.includes(w)) score += 6;
        if (t.coreSizesPresent) score += 3;
        if (t.renderable) score += 2;

        const have = new Set(t.sizes.map((s) => s.toUpperCase()));
        const missingSizes = wantSizes.filter((s) => !have.has(s));
        return { template: t, score, sizeOk: missingSizes.length === 0, missingSizes };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        (b.template.renderable ? 1 : 0) - (a.template.renderable ? 1 : 0) ||
        b.template.colorCount - a.template.colorCount,
      );

    const results = scored.slice(0, q.limit || 8);
    const best = results[0] || null;
    // "Use it" only when we're confident (strong score = right sport at least) AND
    // the template carries every size the order needs. Otherwise → create.
    const exists = !!best && best.score >= 50 && best.sizeOk;
    return {
      exists,
      decision: exists ? 'use' : 'create',
      best,
      results,
      libraryCount: this.templates.length,
    };
  }
}
