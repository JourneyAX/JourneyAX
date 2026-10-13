import { normalizePhrase } from './slug';

/**
 * SKUs a document says it is about, found without any pattern built from data: a document names them either as
 * "for SKU 1234567" / "SKU: 1234567" in its text, or as a leading number in its title ("1294422 spec …").
 */
export function extractSkus(text: string, title = '', options: { minDigits?: number; maxDigits?: number } = {}): string[] {
  const min = options.minDigits ?? 5;
  const max = options.maxDigits ?? 10;
  const isSku = (token: string) => token.length >= min && token.length <= max && /^\d+$/.test(token);
  const found = new Set<string>();
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].toLowerCase() !== 'sku' && words[i].toLowerCase() !== 'skus') continue;
    for (let j = i + 1; j < Math.min(words.length, i + 6) && isSku(words[j]); j++) found.add(words[j]);
  }
  const lead = title.trim().split(/[^A-Za-z0-9]+/)[0];
  if (lead && isSku(lead)) found.add(lead);
  return [...found];
}

export interface DocumentKindRule { kind: string; anyOf: string[] }

/** First rule whose phrase occurs in the title or opening text wins; rules are the tenant's, in priority order. */
export function classifyDocument(title: string, opening: string, rules: DocumentKindRule[], fallback = 'document'): string {
  const haystack = ` ${normalizePhrase(`${title} ${opening}`)} `;
  for (const rule of rules) {
    if (rule.anyOf.some((phrase) => haystack.includes(` ${normalizePhrase(phrase)} `))) return rule.kind;
  }
  return fallback;
}
