/**
 * How many of a product a customer needs for an area, worked out only from numbers that are really known:
 *   - the customer's own area (any unit they give, converted to square metres),
 *   - the size of one piece, read from the product's own name (a 400 x 400 x 50mm paver covers 0.16 m2), or
 *   - the coverage of one pack, when the product's record states it or the customer reads it off the pack.
 * A product that states neither gets no number: the answer says what is missing, and the agent asks for it. The allowance for cuts
 * and waste, and the wording that finds a coverage statement in a record, are the tenant's own data (pack `extensions.quantityHelper`).
 */

export interface QuantityHelperConfig {
  /** Merchant-authored category IDs/names whose piece dimensions actually represent material coverage. Empty means no inference. */
  pieceAreaCategories?: string[];
  /** Extra to buy for cuts and waste, as a percentage of what the area needs; the tenant decides, none when absent. */
  allowancePercent?: number;
  /** Case-insensitive patterns whose first capture group is an area in square metres one pack covers, tried against the product's own text. */
  coveragePatterns?: string[];
  /** A side shorter than this (mm) is a board or section sold by length, not a piece that covers an area. */
  minPieceSideMm?: number;
  /** Units of area the shop understands, each as square metres per unit, keyed by the unit written plainly ("ft2", "sqft"). */
  areaUnits?: Record<string, number>;
}

export function permitsPieceArea(product: { category?: string; categoryPath?: string[] }, config: QuantityHelperConfig): boolean {
  const categories = new Set([product.category, ...(product.categoryPath || [])].filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()));
  return (config.pieceAreaCategories || []).some(value => categories.has(value.trim().toLowerCase()));
}

export interface EstimateInput {
  /** The customer's area in square metres. */
  areaM2: number;
  /** Square metres one pack covers, given by the customer or read from the product's record. */
  coveragePerPack?: number;
  /** How many coats or layers the area gets (1 when not given). */
  coats?: number;
  /** Overrides the tenant's allowance, e.g. when the customer says what they want to add. */
  allowancePercent?: number;
}

export type QuantityBasis = 'piece_size' | 'pack_coverage';

export type QuantityEstimate =
  | {
      ok: true;
      basis: QuantityBasis;
      units: number;
      /** Units needed with no allowance. */
      exactUnits: number;
      areaM2: number;
      allowancePercent: number;
      coats: number;
      /** Square metres one piece (piece_size) or one pack (pack_coverage) covers. */
      coveragePerUnitM2: number;
      pieceSizeMm?: { length: number; width: number };
      /** Where the coverage figure came from, so the answer can say it. */
      coverageSource: 'product_name' | 'product_record' | 'customer';
    }
  | { ok: false; missing: Array<'area' | 'coverage_per_pack'>; reason: 'no_area' | 'no_coverage' | 'bad_input' };

/** A unit as the customer wrote it, reduced so "sq ft", "Sq. Ft" and "ft²" read the same ("sqft", "ft2"). */
export function normaliseUnit(unit: string): string {
  return String(unit || '').toLowerCase().replace(/[\s.^]/g, '').replace(/²/g, '2');
}

/**
 * The customer's area in square metres from the number and unit they used. The units a shop understands, and how many square
 * metres each is, are its own data (pack `extensions.quantityHelper.areaUnits`); a number with no unit is taken as square metres,
 * and a unit the shop does not list is not guessed (the answer is no area, so the customer is asked again).
 */
export function areaToSquareMetres(value: number, unit: string | undefined, areaUnits: Record<string, number> = {}): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (!unit || !String(unit).trim()) return value;
  const factor = areaUnits[normaliseUnit(unit)];
  return typeof factor === 'number' && factor > 0 ? value * factor : undefined;
}

/** One piece's length and width in mm from a name like "Forum Paver 400 x 400 x 50mm Glacier"; undefined when the name carries no such size. */
export function pieceSizeFromName(title: string, minSideMm = 100): { length: number; width: number } | undefined {
  const match = String(title || '').match(/(\d{2,4}(?:\.\d+)?)\s*[xX×*]\s*(\d{2,4}(?:\.\d+)?)(?:\s*[xX×*]\s*\d{1,4}(?:\.\d+)?)?\s*(mm|cm|m)?\b/);
  if (!match) return undefined;
  const scale = match[3] === 'cm' ? 10 : match[3] === 'm' ? 1000 : 1;
  const length = Number(match[1]) * scale;
  const width = Number(match[2]) * scale;
  if (!(length >= minSideMm && width >= minSideMm)) return undefined;
  return { length, width };
}

/** Square metres one pack covers, when the product's own text says so in the words the tenant's patterns look for. */
export function statedCoverage(texts: Array<string | undefined>, patterns: string[] | undefined): number | undefined {
  for (const source of patterns || []) {
    let regex: RegExp;
    try { regex = new RegExp(source, 'i'); } catch { continue; }
    for (const text of texts) {
      const match = text ? regex.exec(text) : null;
      const value = match ? Number(match.slice(1).find((group) => group !== undefined)) : NaN;
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

const roundUp = (value: number) => Math.ceil(value - 1e-9);

export function estimateQuantity(
  product: { title?: string; texts?: Array<string | undefined>; category?: string; categoryPath?: string[] },
  input: Partial<EstimateInput>,
  config: QuantityHelperConfig = {},
): QuantityEstimate {
  const areaM2 = input.areaM2;
  if (areaM2 === undefined) return { ok: false, missing: ['area'], reason: 'no_area' };
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return { ok: false, missing: ['area'], reason: 'bad_input' };
  const allowancePercent = Math.max(0, Math.min(100, input.allowancePercent ?? config.allowancePercent ?? 0));
  const coats = Math.max(1, Math.min(10, Math.floor(input.coats ?? 1)));
  const factor = 1 + allowancePercent / 100;

  const fromCustomer = input.coveragePerPack !== undefined && Number.isFinite(input.coveragePerPack) && input.coveragePerPack > 0;
  const fromRecord = fromCustomer ? undefined : statedCoverage([...(product.texts || [])], config.coveragePatterns);
  const piece = fromCustomer || fromRecord !== undefined || !permitsPieceArea(product, config) ? undefined : pieceSizeFromName(product.title || '', config.minPieceSideMm);

  if (fromCustomer || fromRecord !== undefined) {
    const coveragePerUnitM2 = fromCustomer ? input.coveragePerPack! : fromRecord!;
    const exactUnits = roundUp((areaM2 * coats) / coveragePerUnitM2);
    return {
      ok: true, basis: 'pack_coverage', units: Math.max(1, roundUp((areaM2 * coats * factor) / coveragePerUnitM2)), exactUnits: Math.max(1, exactUnits),
      areaM2, allowancePercent, coats, coveragePerUnitM2, coverageSource: fromCustomer ? 'customer' : 'product_record',
    };
  }
  if (piece) {
    const coveragePerUnitM2 = (piece.length / 1000) * (piece.width / 1000);
    return {
      ok: true, basis: 'piece_size', units: Math.max(1, roundUp((areaM2 * coats * factor) / coveragePerUnitM2)), exactUnits: Math.max(1, roundUp((areaM2 * coats) / coveragePerUnitM2)),
      areaM2, allowancePercent, coats, coveragePerUnitM2, pieceSizeMm: piece, coverageSource: 'product_name',
    };
  }
  return { ok: false, missing: ['coverage_per_pack'], reason: 'no_coverage' };
}
