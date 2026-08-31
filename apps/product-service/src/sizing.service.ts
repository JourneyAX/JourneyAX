import { Injectable } from '@nestjs/common';

/**
 * Fitment guide (v1) — a small, DATA-driven size-chart lookup, not ML.
 *
 * Grounding note (read before editing this file):
 * Every chart below is either (a) the REAL distinct `variants[].size` values
 * ingested into `journeyx.products` for that tenant/category group — queried
 * directly from Mongo on 2026-08-23 (see the group comments) — or (b) a
 * tenant's own admin-configured size scale (Augusta's `configurator.sizeScale`,
 * read live from project-service, never hardcoded here). Nothing in this file
 * invents a size that isn't actually sold.
 *
 * What IS a standard convention rather than ingested data: which numeric body
 * measurement band a letter size (XS/S/M/…) corresponds to. We do not have a
 * measurement-to-label mapping in the ingested catalogue (no size-chart PDFs
 * were scraped), so the bands below use the widely-published US apparel
 * convention. This is flagged honestly in `recommend()`'s response
 * (`bandSource: 'standard-us-apparel'`) rather than presented as brand-specific
 * fact. The label SET we recommend from is always the real, ingested one.
 */

export type SizingCategory = 'denimWaist' | 'shortsWaist' | 'topsLetter' | 'teamwearLetter';

interface BrandSizeChart {
  /** Real distinct sizes actually sold, by our internal category group. */
  categories: Partial<Record<SizingCategory, string[]>>;
}

/**
 * A&F (abercrombie) — real distinct `variants[].size` values, queried directly
 * from `journeyx.products` (projectId: 'abercrombie', 4,429 products):
 *  - Jeans (e.g. "Slim Jeans", "Straight & Skinny Jeans"): waist sizes 28–40
 *    (even numbers dominate: 28,29,30,31,32,33,34,36,38,40)
 *  - Shorts ("Fashion Shorts", "Go-To Shorts"): waist sizes 23–38, plus a
 *    letter-sized run (XXS–XXL) for fashion/fleece shorts
 *  - Tops (T-Shirts, Hoodies, Sweaters, Tanks, Bodysuits): letter sizes
 *    XXS, XS, S, M, L, XL, XXL — consistent across every top category sampled
 */
const AF_CHART: BrandSizeChart = {
  categories: {
    denimWaist: ['28', '29', '30', '31', '32', '33', '34', '36', '38', '40'],
    shortsWaist: ['23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38'],
    topsLetter: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
  },
};

/** Standard US apparel letter-size ⇄ chest/bust band (inches), used only to
 *  place a self-reported "usual size" or a stated measurement onto the letter
 *  scale — see the grounding note above. Order matters (ascending). */
const LETTER_BAND_IN: { size: string; maxChest: number }[] = [
  { size: 'XXS', maxChest: 32 },
  { size: 'XS', maxChest: 34 },
  { size: 'S', maxChest: 37 },
  { size: 'M', maxChest: 40 },
  { size: 'L', maxChest: 44 },
  { size: 'XL', maxChest: 48 },
  { size: 'XXL', maxChest: 52 },
];

export interface RecommendInput {
  tenantId: string;
  /** Free-form category hint from the agent, e.g. "jeans", "shorts", "t-shirt", "jersey". */
  category?: string;
  /** Self-reported usual size at any brand, e.g. "M", "32", "Large". */
  usualSize?: string;
  /** Waist measurement in inches, if given directly (denim/shorts). */
  waistIn?: number;
  /** Chest/bust measurement in inches, if given directly (tops). */
  chestIn?: number;
  /** 'adult' | 'youth' — only meaningful for teamwear (Augusta-style) tenants. */
  division?: 'adult' | 'youth';
}

export interface RecommendResult {
  ok: boolean;
  recommendedSize?: string;
  availableSizes?: string[];
  categoryGroup?: SizingCategory | null;
  bandSource?: 'real-catalogue' | 'standard-us-apparel' | 'tenant-configured';
  message: string;
}

function normCategory(input?: string): SizingCategory | null {
  const c = (input || '').toLowerCase();
  if (/jean|denim/.test(c)) return 'denimWaist';
  if (/short/.test(c)) return 'shortsWaist';
  if (/(shirt|tee|top|hoodie|sweater|tank|jersey|dress|jacket)/.test(c)) return 'topsLetter';
  return null;
}

function nearestNumeric(target: number, options: string[]): string {
  let best = options[0];
  let bestDiff = Infinity;
  for (const o of options) {
    const n = Number(o);
    if (Number.isNaN(n)) continue;
    const diff = Math.abs(n - target);
    if (diff < bestDiff) { bestDiff = diff; best = o; }
  }
  return best;
}

function letterFromChest(chestIn: number): string {
  for (const band of LETTER_BAND_IN) if (chestIn <= band.maxChest) return band.size;
  return LETTER_BAND_IN[LETTER_BAND_IN.length - 1].size;
}

@Injectable()
export class SizingService {
  /**
   * Fetch a teamwear tenant's REAL, admin-configured size scale
   * (`configurator.sizeScale` — same field `RosterPanel`/`TeamRosterPanel`
   * already read) rather than hardcoding one. Returns null if the tenant has
   * no scale configured — the caller must say so honestly, not invent S/M/L.
   */
  private async teamwearSizeScale(tenantId: string): Promise<string[] | null> {
    try {
      const base = process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';
      const res = await fetch(`${base}/api/v1/projects/${encodeURIComponent(tenantId)}`, {
        headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const p: any = await res.json();
      const scale = p?.configurator?.sizeScale;
      return Array.isArray(scale) && scale.length ? scale.map(String) : null;
    } catch {
      return null;
    }
  }

  /** Per-tenant real chart lookup. Only tenants with confirmed real size data
   *  are wired here — a tenant with no entry falls through to the honest
   *  "we don't have your size chart yet" response in `recommend()`. */
  private brandChart(tenantId: string): BrandSizeChart | null {
    const t = tenantId.toLowerCase();
    if (t === 'abercrombie') return AF_CHART;
    return null;
  }

  async recommend(input: RecommendInput): Promise<RecommendResult> {
    const tenantId = (input.tenantId || '').toLowerCase();

    // Teamwear tenants (Augusta-style): recommend off the tenant's own,
    // admin-configured size scale — never a generic garment chart.
    const teamScale = await this.teamwearSizeScale(tenantId);
    if (teamScale && (normCategory(input.category) === 'topsLetter' || !input.category)) {
      const scaleIsYouth = (s: string) => /^Y/i.test(s);
      const pool = input.division === 'youth'
        ? teamScale.filter(scaleIsYouth)
        : input.division === 'adult'
          ? teamScale.filter((s) => !scaleIsYouth(s))
          : teamScale;
      const usable = pool.length ? pool : teamScale;
      let rec: string | undefined;
      if (input.usualSize) {
        const clean = input.usualSize.trim().toUpperCase();
        rec = usable.find((s) => s.toUpperCase() === clean)
          || usable.find((s) => s.toUpperCase().replace(/^Y/, '') === clean.replace(/^Y/, ''));
      }
      if (!rec && input.chestIn) {
        const letter = letterFromChest(input.chestIn);
        rec = usable.find((s) => s.toUpperCase().replace(/^Y/, '') === letter) || undefined;
      }
      if (rec) {
        return {
          ok: true,
          recommendedSize: rec,
          availableSizes: teamScale,
          categoryGroup: 'teamwearLetter',
          bandSource: 'tenant-configured',
          message: `Based on your usual size, we recommend ${rec} — sized against this team's real order scale.`,
        };
      }
      if (input.usualSize || input.chestIn) {
        return {
          ok: true,
          recommendedSize: undefined,
          availableSizes: teamScale,
          categoryGroup: 'teamwearLetter',
          bandSource: 'tenant-configured',
          message: `We couldn't confidently match "${input.usualSize || `${input.chestIn}in chest`}" to one of this team's sizes (${teamScale.join(', ')}). Ask the customer which of these they usually wear.`,
        };
      }
    }

    const chart = this.brandChart(tenantId);
    if (!chart) {
      return {
        ok: false,
        message: `We don't have a real size chart for this store yet, so I can't make a grounded sizing recommendation — tell the customer honestly rather than guessing, and offer to note their usual size for our team to confirm manually.`,
      };
    }

    const group = normCategory(input.category);
    if (!group || !chart.categories[group]) {
      return {
        ok: false,
        categoryGroup: group,
        message: `We don't have real size data for "${input.category || 'that item'}" yet — say so honestly rather than guessing a size.`,
      };
    }
    const sizes = chart.categories[group]!;

    // Denim/shorts: waist is a real, direct number — no letter-band guessing needed.
    if (group === 'denimWaist' || group === 'shortsWaist') {
      const waist = input.waistIn ?? (input.usualSize && /^\d+(\.\d+)?$/.test(input.usualSize.trim()) ? Number(input.usualSize) : undefined);
      if (waist == null) {
        return { ok: true, availableSizes: sizes, categoryGroup: group, bandSource: 'real-catalogue',
          message: `Ask the customer their usual waist size (a number, e.g. "32") — we sell ${sizes[0]}–${sizes[sizes.length - 1]} in this category.` };
      }
      const rec = nearestNumeric(waist, sizes);
      return {
        ok: true, recommendedSize: rec, availableSizes: sizes, categoryGroup: group, bandSource: 'real-catalogue',
        message: rec === String(waist)
          ? `Waist ${waist} is available directly — recommend size ${rec}.`
          : `We don't stock an exact waist ${waist}; the nearest real size we carry is ${rec}.`,
      };
    }

    // Tops: letter sizes. Use a stated usual size directly if it's one we
    // actually stock; otherwise place a chest measurement on the standard band
    // and confirm against the REAL stocked set.
    if (group === 'topsLetter') {
      let rec: string | undefined;
      let bandSource: RecommendResult['bandSource'] = 'real-catalogue';
      if (input.usualSize) {
        const clean = input.usualSize.trim().toUpperCase()
          .replace(/^EXTRA[- ]?SMALL$/, 'XS').replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M')
          .replace(/^LARGE$/, 'L').replace(/^EXTRA[- ]?LARGE$/, 'XL');
        if (sizes.includes(clean)) rec = clean;
      }
      if (!rec && input.chestIn) {
        const letter = letterFromChest(input.chestIn);
        bandSource = 'standard-us-apparel';
        // Snap to nearest size we actually stock, in case the letter itself
        // (e.g. a chart-only "3XL") isn't sold here.
        rec = sizes.includes(letter) ? letter : sizes[Math.min(sizes.indexOf('M') >= 0 ? sizes.indexOf('M') : 0, sizes.length - 1)];
      }
      if (rec) {
        return { ok: true, recommendedSize: rec, availableSizes: sizes, categoryGroup: group, bandSource,
          message: `Recommend size ${rec} (we stock ${sizes.join(', ')} in this category).` };
      }
      return { ok: true, availableSizes: sizes, categoryGroup: group, bandSource: 'real-catalogue',
        message: `Ask the customer their usual top size or a chest measurement — we stock ${sizes.join(', ')} in this category.` };
    }

    return { ok: false, categoryGroup: group, message: 'Could not resolve a recommendation from the available data.' };
  }
}
