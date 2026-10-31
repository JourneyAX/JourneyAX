/**
 * What buyers often mention about a kind of product, for the product's details panel. The words come from the shop's pack
 * (extension buyerFeedback), never from the model: a rule applies when the product's category, or a word of its name, is one of the
 * rule's `when` words (any case). The first rule that applies wins.
 */
export interface FeedbackRule { when: string[]; mentions: string[]; watchFor?: string[] }

export interface ProductFeedback {
  hasFeedback: true;
  feedbackText: string;
  hasWatch: boolean;
  watchText: string;
}

const bullets = (lines: string[]) => lines.map((line) => `- ${line}`).join('\n');

export function matchBuyerFeedback(rules: FeedbackRule[] | undefined, product: { title?: string; category?: string }): ProductFeedback | undefined {
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const category = String(product.category || '').trim().toLowerCase();
  const words = new Set(String(product.title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const rule = rules.find((entry) => Array.isArray(entry.when) && entry.when.some((word) => {
    const w = String(word).trim().toLowerCase();
    return Boolean(w) && (category === w || words.has(w));
  }));
  if (!rule || !Array.isArray(rule.mentions) || rule.mentions.length === 0) return undefined;
  const watch = Array.isArray(rule.watchFor) ? rule.watchFor.filter(Boolean) : [];
  return { hasFeedback: true, feedbackText: bullets(rule.mentions), hasWatch: watch.length > 0, watchText: bullets(watch) };
}
