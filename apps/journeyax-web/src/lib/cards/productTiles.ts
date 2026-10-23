/**
 * The words and flags a product row needs that depend on the numbers a product carries: whether it is ticked for comparison, how
 * many branches hold it, and what to ask when it has no published price. The template only decides where they go; the storefront
 * owns the wording.
 */
export interface TileWords {
  compare: string;
  comparing: string;
  availableAt: (branches: number, total: number) => string;
  askPrice: (title: string) => string;
}

export const DEFAULT_TILE_WORDS: TileWords = {
  compare: 'Compare',
  comparing: 'Comparing ✓',
  availableAt: (branches, total) => `Available at ${branches} of ${total} branches`,
  askPrice: (title) => `What would ${title} cost, and how do I get a price?`,
};

const HIGHLIGHT_SEPARATOR = ' · ';

type Row = Record<string, any>;

export function decorateProductRows(rows: Row[], input: { comparing: ReadonlySet<string>; words?: TileWords }): Row[] {
  const words = input.words ?? DEFAULT_TILE_WORDS;
  return rows.map((row) => {
    const sku = String(row?.sku ?? '');
    const title = String(row?.title ?? row?.name ?? sku);
    const highlights: string[] = Array.isArray(row?.highlights) ? row.highlights.filter((h: unknown) => typeof h === 'string' && h.trim()) : [];
    const caution = Array.isArray(row?.cautions) ? row.cautions.find((c: unknown) => typeof c === 'string' && c.trim()) : undefined;
    const branches = typeof row?.branchesAvailable === 'number' && typeof row?.branchesTotal === 'number' && row.branchesTotal > 0
      ? words.availableAt(row.branchesAvailable, row.branchesTotal) : undefined;
    const ticked = input.comparing.has(sku);
    const hasPrice = typeof row?.price === 'number' && row.price > 0;
    return {
      ...row,
      comparing: ticked,
      compareLabel: ticked ? words.comparing : words.compare,
      ...(highlights.length > 0 ? { highlightsText: highlights.join(HIGHLIGHT_SEPARATOR) } : {}),
      ...(caution ? { cautionText: caution } : {}),
      ...(!row?.stockLabel && branches ? { stockLabel: branches } : {}),
      priceMissing: !hasPrice,
      askPriceText: words.askPrice(title),
    };
  });
}
