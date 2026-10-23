/**
 * Which products a reply is about, so they are always shown on a card.
 *
 * The agent writes the words; the products it names (or, when it names none, the ones its search just found) are shown as a
 * card after them. Leaving that to a separate model call cost a round trip on every recommendation and sometimes did not
 * happen at all, so a reply could recommend a product the customer could not see or add. Only products the tools returned
 * this turn can be chosen, so nothing here can introduce a product the agent did not look up.
 */

/** The products the most recent product lookup of the turn returned, best first. */
export interface LastProducts {
  skus: string[];
  /** True when the search had to drop part of what was asked to find anything: those are alternatives, not matches. */
  relaxed: boolean;
}

const MAX_NAMED = 6;
const MAX_SEARCHED = 4;
/** A title shorter than this is too generic to count as a mention (it would match any sentence that uses the word). */
const MIN_TITLE_CHARS = 12;

const normalise = (text: unknown): string =>
  ` ${String(text ?? '').toLowerCase().replace(/[®™]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** Where in the (normalised) reply this product is first named, by SKU or by title; -1 when it is not named. */
function mentionedAt(haystack: string, sku: string, title: unknown): number {
  const skuKey = normalise(sku);
  if (skuKey.trim()) {
    const at = haystack.indexOf(skuKey);
    if (at >= 0) return at;
  }
  const titleKey = normalise(title);
  const words = titleKey.trim().split(' ').filter(Boolean);
  if (titleKey.trim().length >= MIN_TITLE_CHARS) {
    const whole = haystack.indexOf(titleKey);
    if (whole >= 0) return whole;
    // A reply often drops the tail of a long title ("... Taper Edge/Square Edge"): the leading words still name the product.
    if (words.length >= 5) {
      const lead = ` ${words.slice(0, Math.max(4, Math.ceil(words.length * 0.6))).join(' ')} `;
      const partial = haystack.indexOf(lead.trimEnd());
      if (partial >= 0 && /\d/.test(lead)) return partial;
    }
  }
  return -1;
}

export function chooseCardSkus(input: {
  text: string;
  /** Every product the tools returned this turn, in the order they came. */
  turnSkus: Iterable<string>;
  catalog: Map<string, any>;
  last?: LastProducts;
}): { skus: string[]; basis: 'named' | 'searched' | 'none' } {
  const haystack = normalise(input.text);
  const named = [...input.turnSkus]
    .map((sku) => {
      const product = input.catalog.get(sku);
      return { sku, at: mentionedAt(haystack, sku, product?.title ?? product?.name) };
    })
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_NAMED)
    .map((entry) => entry.sku);
  if (named.length > 0) return { skus: named, basis: 'named' };

  // Nothing named: show what the last lookup found, but not alternatives the search had to settle for.
  if (input.last && !input.last.relaxed && input.last.skus.length > 0) {
    return { skus: input.last.skus.slice(0, MAX_SEARCHED), basis: 'searched' };
  }
  return { skus: [], basis: 'none' };
}
