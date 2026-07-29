/**
 * Derive a product's option space from its own variant rows (AUG-41).
 *
 * The commerce platform models choice as `defining` attributes, and for most of
 * the catalogue it answers well. It does NOT answer for made-to-order goods:
 * of 442 products with no platform option space, 441 carry variant rows and 429
 * are sublimated — i.e. precisely the custom styles this product exists to sell.
 * Nothing was lost at ingest; the platform was simply asked a question it does
 * not hold the answer to for these items.
 *
 * The variant rows do hold it. Each row is a buyable SKU with its own colour and
 * size, so the set of distinct values across the rows IS the set of real choices
 * — derived from what can actually be bought, never invented.
 *
 * One subtlety that matters more than it looks. On a sublimated style the feed's
 * "Color" column does not carry a colour: it carries the DESIGN LINE — the
 * values are SERPENTINE, PICK AND ROLL, HARDWOOD PINSTRIPE. Filing those under
 * "Color" would have the agent offer "Swish" as a colour and then fail to find
 * it in the palette. They are labelled for what they are, so that a wrong answer
 * is not merely unlikely but unrepresentable.
 */

/** A variant row as the catalogue feed models it (see csv-feed.ts). */
export interface VariantLike {
  itemSku?: string;
  color?: string;
  colorHex?: string;
  size?: string;
  status?: string;
  mainImage?: string;
  stock?: number;
}

export type DefiningMap = Record<string, { value: string; swatchImage?: string }[]>;

export interface DerivedOptionSpace {
  defining: DefiningMap;
  /** How many variant rows the derivation saw — the audit trail for the counts. */
  derivedFrom: number;
}

/**
 * Size order is a property of the garment trade, not of the data: a feed lists
 * sizes in whatever order rows happened to arrive, and "2XL, 3XL, L, M, S, XL"
 * (alphabetical) is what a customer would be shown without this. Unknown tokens
 * keep their original position rather than being dropped or forced to the end.
 */
const SIZE_ORDER = [
  'YXS', 'YS', 'YM', 'YL', 'YXL', 'Y2XL',
  'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL', '6XL',
];
const sizeRank = (v: string): number => {
  const i = SIZE_ORDER.indexOf(v.trim().toUpperCase());
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

export function sortSizes(values: string[]): string[] {
  return values
    .map((v, i) => ({ v, i, r: sizeRank(v) }))
    // Numeric sizes (waist 30/32/34) sort numerically among themselves.
    .sort((a, b) => {
      const na = Number(a.v), nb = Number(b.v);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (a.r !== b.r) return a.r - b.r;
      return a.i - b.i;                     // unknown tokens: keep feed order
    })
    .map((x) => x.v);
}

/**
 * Which key the colour column belongs under.
 *
 * `isSublimation` is the feed's own flag, set by the pass that read the row, so
 * this is the catalogue's classification rather than a guess from the values.
 */
export function colourKeyFor(isSublimation: boolean | undefined): string {
  return isSublimation ? 'Design Line' : 'Color';
}

/**
 * Build the choice map from variant rows.
 *
 * Returns null when there is nothing to derive, so a caller can tell "no choices
 * exist" apart from "we did not look" — the same distinction the render path
 * makes, and for the same reason: an empty answer must never read as a denial.
 */
export function deriveOptionSpace(
  variants: VariantLike[] | undefined,
  opts: { isSublimation?: boolean } = {},
): DerivedOptionSpace | null {
  const rows = (variants || []).filter(Boolean);
  if (!rows.length) return null;

  /* Discontinued rows are excluded where the feed says so. A size that can no
     longer be bought must not be offered — that is an order that fails at
     fulfilment, after the customer has been told yes. Rows with no status are
     kept: absence of a status is not evidence of discontinuation. */
  const live = rows.filter((v) => !/discontinu|inactive|obsolete/i.test(String(v.status || '')));
  const usable = live.length ? live : rows;

  const colourKey = colourKeyFor(opts.isSublimation);
  const colours = new Map<string, { value: string; swatchImage?: string }>();
  const sizes = new Set<string>();

  for (const v of usable) {
    const c = String(v.color || '').trim();
    if (c && !colours.has(c.toUpperCase())) {
      colours.set(c.toUpperCase(), { value: c, swatchImage: v.mainImage || undefined });
    }
    const s = String(v.size || '').trim();
    if (s) sizes.add(s);
  }

  const defining: DefiningMap = {};
  if (colours.size) defining[colourKey] = [...colours.values()];
  if (sizes.size) defining['Available Sizes'] = sortSizes([...sizes]).map((value) => ({ value }));

  if (!Object.keys(defining).length) return null;
  return { defining, derivedFrom: usable.length };
}

/**
 * The garment type, when the commerce platform does not state one.
 *
 * The rack groups the kit by `optionSpace.descriptive.garmentType`, so a style
 * without one cannot appear in it at all. 110 of 112 headwear styles have no
 * garment type from the platform — the attribute feed covers the sublimated
 * apparel lines and not Pacific Headwear — so caps were invisible to the kit
 * despite being in the catalogue, priced, and stocked.
 *
 * The catalogue's own category string carries it. Jerseys read
 * "Adult | BASKETBALL | TOP" and caps "Misc | HEADWEAR | HEADWEAR ASB", so the
 * type is taken from the category rather than guessed from the product name —
 * a name match would classify "Cap Sleeve Jersey" as headwear.
 */
export function deriveGarmentType(
  category?: string,
  platformType?: string,
  itemType?: string,
): string | undefined {
  if (platformType) return platformType;              // platform wins, always

  const parts = String(category || '').split('|').map((p) => p.trim()).filter(Boolean);
  const joined = parts.join(' ').toUpperCase();
  // Headwear is its own kit slot: a cap is neither a top nor a bottom.
  if (/\bHEADWEAR\b/.test(joined)) return 'Headwear';
  const last = (parts[parts.length - 1] || '').toUpperCase();
  if (last === 'TOP') return 'Top';
  if (last === 'BOTTOM') return 'Bottom';

  return fromItemType(itemType);
}

/**
 * Garment type from the platform's `ItemType` attribute.
 *
 * The category path is the better source where it exists, but 378 products are
 * filed under MERCHANDISING categories instead — `BRANDS | Russell`,
 * `SPORT | Perfect Game`, `Samples`, `SALE` — which say who made a garment or
 * why it is on the site, never what it is. Resolving those category ids to
 * their names (they arrive as bare numbers) was tried and yields a garment type
 * for just 9 products, because the answer is genuinely not in that field.
 *
 * `ItemType` is the platform's own answer to the question, and it is present on
 * 1,356 of the 1,579 products that have no type. Its values are compound and
 * mix in decoration codes — "On-Field Tops", "T3, T0, Headwear" — so it is read
 * token by token rather than matched whole, and the codes simply never match.
 *
 * Outerwear and bags are kept as their own slots rather than folded into Top or
 * Accessories: a jacket is not a jersey, and a customer picking a kit should
 * see them as the separate things they are.
 */
function fromItemType(itemType?: string): string | undefined {
  const t = String(itemType || '').toUpperCase();
  if (!t) return undefined;
  /* Order matters where values overlap. "On-Field Bottoms" must not be read as
     a top merely because a broader rule ran first. */
  if (/HEADWEAR/.test(t)) return 'Headwear';
  if (/OUTERWEAR/.test(t)) return 'Outerwear';
  if (/BOTTOM/.test(t)) return 'Bottom';
  if (/TOP/.test(t)) return 'Top';
  if (/BAG/.test(t)) return 'Bags';
  if (/ACCESSOR/.test(t)) return 'Accessories';
  if (/APRON/.test(t)) return 'Aprons';
  return undefined;                                   // no evidence: never guess
}
