/**
 * What a group of products can be told apart by, read from the products themselves.
 *
 * A customer who names only a kind of thing ("pavers", "a shed", "tap") is asked what they want. Questions are only worth asking
 * when the shop's own range can answer them, so the options offered are the real values the matched products differ in: their
 * brands, the sizes and ratings the tenant's catalogue mapping extracts, a pack size, and the words that end the product names of
 * siblings in one range (a colour, a finish, a size). Nothing here names a product kind: every value comes from the products.
 */

export interface OptionProduct {
  title?: string;
  name?: string;
  brand?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OptionValue { value: string; count: number }
export interface OptionFacet {
  /** `brand`, a tenant attribute name, `pack` or `variant`. */
  name: string;
  /** What the values are, in plain words for the agent. */
  about: string;
  /** Share of the matched products that carry this facet (0..1). */
  coverage: number;
  values: OptionValue[];
}

export interface OptionSummary {
  matched: number;
  facets: OptionFacet[];
}

export interface SummariseDeps {
  /** Pulls the tenant's catalogue-mapping attributes (size, rating, ...) out of a product name. */
  attributesFromTitle?: (title: string) => Record<string, string>;
  /** Largest number of values listed per facet. */
  maxValues?: number;
}

const DEFAULT_MAX_VALUES = 10;
const MAX_VARIANT_TAIL_WORDS = 3;
const MAX_VARIANT_LENGTH = 28;
/** A volume or weight in a product name, such as 4L, 450ml or 25kg: the pack the customer would buy. */
const PACK_PATTERN = /\b(\d+(?:\.\d+)?)\s?(ml|l|litres?|liters?|kg|g)\b/i;

const titleOf = (product: OptionProduct): string => String(product.title || product.name || '').replace(/\s+/g, ' ').trim();

function tally(values: string[], maxValues: number): OptionValue[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = value.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1; else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, maxValues);
}

/** One pack size per product, written the same way whatever the spelling (4 L, 4l, 4 litres become 4L). */
function packOf(title: string): string | undefined {
  const match = title.match(PACK_PATTERN);
  if (!match) return undefined;
  const unit = match[2].toLowerCase();
  const normalised = unit === 'ml' ? 'ml' : unit.startsWith('l') ? 'L' : unit;
  return `${Number(match[1])}${normalised}`;
}

/**
 * The words that end the names of products sharing the rest of their name. Of "Forum Paver 400 x 400 x 50mm Glacier" and
 * "Forum Paver 400 x 400 x 50mm Volcanic Ash", the shared start makes them one range and the ending ("Glacier", "Volcanic Ash")
 * is what tells them apart. A range needs at least two members and two different endings; endings with digits are left out.
 */
export function variantLabels(titles: string[]): { labels: string[]; products: number } {
  const families = new Map<string, Array<{ tail: string; index: number }>>();
  titles.forEach((title, index) => {
    const words = title.split(' ').filter(Boolean);
    for (let tailWords = 1; tailWords <= Math.min(MAX_VARIANT_TAIL_WORDS, words.length - 1); tailWords++) {
      const tail = words.slice(-tailWords).join(' ');
      if (!/^[A-Za-z][A-Za-z '&-]*$/.test(tail) || tail.length > MAX_VARIANT_LENGTH) continue;
      const start = words.slice(0, -tailWords).join(' ').toLowerCase();
      if (!families.has(start)) families.set(start, []);
      families.get(start)!.push({ tail, index });
    }
  });
  // Each product is counted once, under the ending of the range with the most different endings (the colour range, not a single word of it).
  const best = new Map<number, { tail: string; spread: number }>();
  for (const members of families.values()) {
    const spread = new Set(members.map((member) => member.tail.toLowerCase())).size;
    if (members.length < 2 || spread < 2) continue;
    for (const member of members) {
      const current = best.get(member.index);
      if (!current || spread > current.spread) best.set(member.index, { tail: member.tail, spread });
    }
  }
  return { labels: [...best.values()].map((entry) => entry.tail), products: best.size };
}

export function summariseOptions(products: OptionProduct[], deps: SummariseDeps = {}): OptionSummary {
  const maxValues = deps.maxValues ?? DEFAULT_MAX_VALUES;
  const matched = products.length;
  const facets: OptionFacet[] = [];
  const share = (count: number) => (matched === 0 ? 0 : Math.round((count / matched) * 100) / 100);
  const titles = products.map(titleOf);

  const brands = products.map((product) => String(product.brand || '').trim()).filter(Boolean);
  if (new Set(brands.map((brand) => brand.toLowerCase())).size >= 2) {
    facets.push({ name: 'brand', about: 'who makes the product', coverage: share(brands.length), values: tally(brands, maxValues) });
  }

  if (deps.attributesFromTitle) {
    const byAttribute = new Map<string, string[]>();
    for (const title of titles) {
      for (const [name, value] of Object.entries(deps.attributesFromTitle(title))) {
        if (value) (byAttribute.get(name) || byAttribute.set(name, []).get(name)!).push(String(value));
      }
    }
    for (const [name, values] of byAttribute) {
      if (new Set(values.map((value) => value.toLowerCase())).size >= 2) {
        facets.push({ name, about: `the ${name} the product name states`, coverage: share(values.length), values: tally(values, maxValues) });
      }
    }
  }

  const packs = titles.map(packOf).filter((pack): pack is string => !!pack);
  if (new Set(packs).size >= 2) {
    facets.push({ name: 'pack', about: 'the pack size (volume or weight) in the product name', coverage: share(packs.length), values: tally(packs, maxValues) });
  }

  const variants = variantLabels(titles);
  if (new Set(variants.labels.map((label) => label.toLowerCase())).size >= 2) {
    facets.push({
      name: 'variant',
      about: 'what the otherwise identical products in a range differ by, the last words of their names (usually a colour, a finish or a size)',
      coverage: share(variants.products),
      values: tally(variants.labels, maxValues),
    });
  }

  return { matched, facets };
}
