/**
 * The side-by-side table for two or three products, built only from the catalogue's own records of them.
 *
 * Rows where the products differ come first, because that is what a customer comparing them is looking for; rows where they all
 * agree follow. A fact a product does not list is shown as a dash, never guessed. Which one fits the customer is not decided here:
 * that is the consultant's reply, written from the same records.
 */
import { usableImage } from './mappers';
import type { ServerProductDetail } from './productDetail';

export interface CompareWords {
  price: string;
  availability: string;
  rating: string;
  features: string;
  priceOnRequest: string;
  missing: string;
  summary: (differences: number, same: number) => string;
}

export const DEFAULT_COMPARE_WORDS: CompareWords = {
  price: 'Price',
  availability: 'Availability',
  rating: 'Rating',
  features: 'Key features',
  priceOnRequest: 'Price on request',
  missing: '—',
  summary: (differences, same) => `${differences} ${differences === 1 ? 'difference' : 'differences'}, ${same} ${same === 1 ? 'thing' : 'things'} the same`,
};

export interface CompareSource {
  sku: string;
  title: string;
  imageUrl?: string | null;
  price?: number | null;
  currency?: string;
  features?: string[];
  specs?: Array<{ label: string; value: string }>;
  availabilityLabel?: string;
  rating?: number;
  ratingCount?: number;
}

const MAX_SPEC_ROWS = 10;
const MAX_FEATURES = 3;

const money = (price: number | null | undefined, currency: string | undefined, none: string): string => {
  if (typeof price !== 'number' || !(price > 0)) return none;
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price) : price.toFixed(2);
  } catch {
    return price.toFixed(2);
  }
};

/** A tapped tile completed with the catalogue's record of it, in the shape the table is built from. */
export function toCompareSource(tile: { sku: string; title?: string; name?: string; imageUrl?: string | null; price?: number | null; rating?: number; ratingCount?: number } | undefined, detail: ServerProductDetail | null, sku: string): CompareSource {
  return {
    sku,
    title: detail?.title || tile?.title || tile?.name || sku,
    imageUrl: usableImage(detail?.imageUrl) || usableImage(tile?.imageUrl) || null,
    price: detail?.price ?? tile?.price ?? null,
    currency: detail?.currency,
    features: detail?.features,
    specs: detail?.specs,
    availabilityLabel: detail?.availability?.label,
    rating: detail?.rating?.value ?? tile?.rating,
    ratingCount: detail?.rating?.count ?? tile?.ratingCount,
  };
}

export function buildComparisonCard(sources: CompareSource[], words: CompareWords = DEFAULT_COMPARE_WORDS): Record<string, unknown> {
  const rows: Array<[string, ...string[]]> = [];
  const cells = (read: (source: CompareSource) => string | undefined): string[] => sources.map((source) => read(source) || words.missing);

  rows.push([words.price, ...cells((s) => (typeof s.price === 'number' && s.price > 0 ? money(s.price, s.currency, words.priceOnRequest) : words.priceOnRequest))]);
  if (sources.some((s) => s.availabilityLabel)) rows.push([words.availability, ...cells((s) => s.availabilityLabel)]);
  if (sources.some((s) => typeof s.rating === 'number')) {
    rows.push([words.rating, ...cells((s) => (typeof s.rating === 'number' ? `${s.rating.toFixed(1)}${typeof s.ratingCount === 'number' ? ` (${s.ratingCount})` : ''}` : undefined))]);
  }
  const labels: string[] = [];
  for (const source of sources) for (const spec of source.specs || []) if (spec?.label && !labels.includes(spec.label)) labels.push(spec.label);
  for (const label of labels.slice(0, MAX_SPEC_ROWS)) {
    rows.push([label, ...cells((s) => (s.specs || []).find((spec) => spec.label === label)?.value)]);
  }
  if (sources.some((s) => (s.features || []).length > 0)) {
    rows.push([words.features, ...cells((s) => ((s.features || []).slice(0, MAX_FEATURES).join('; ') || undefined))]);
  }

  const differs = (row: string[]) => new Set(row.slice(1).map((cell) => cell.trim().toLowerCase())).size > 1;
  const different = rows.filter(differs);
  const same = rows.filter((row) => !differs(row));
  const ordered = [...different, ...same];

  return {
    products: sources.map((s) => ({ sku: s.sku, title: s.title, imageUrl: s.imageUrl ?? null, price: s.price ?? null, currency: s.currency, addLabel: 'Add' })),
    dimensions: ordered.map((row) => row[0]),
    columns: ['', ...sources.map((s) => s.title)],
    rows: ordered,
    intro: words.summary(different.length, same.length),
  };
}
