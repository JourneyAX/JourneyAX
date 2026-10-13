import type { ConversationPolicy } from './policy';
import type { Constraint, Product, QuestionOption, QuestionPlan } from './types';
import { stem, tokens } from './text';
import { brandOf } from './relevance';

interface Candidate { kind: 'term' | 'brand' | 'price'; options: QuestionOption[]; sets: Set<number>[]; expectedRemaining: number }

const nice = (x: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(x));
  const norm = x / magnitude;
  const best = [1, 2, 5, 10].reduce((a, b) => (Math.abs(b - norm) < Math.abs(a - norm) ? b : a));
  return best * magnitude;
};
const money = (value: number, currency?: string): string => {
  try { return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value) : String(value); } catch { return String(value); }
};
const fillLabel = (template: string, a: string, b: string) => template.replace('{a}', a).replace('{b}', b);
const remaining = (groups: Set<number>[], N: number): number => {
  const union = new Set(groups.flatMap((group) => [...group]));
  return groups.reduce((sum, group) => sum + (group.size / N) ** 2, 0) + ((N - union.size) / N) ** 2;
};

export interface FacetContext { needTerms: string[]; conceptWords: Set<string>; asked: string[]; policy: ConversationPolicy }

/**
 * The question that would narrow THESE products most. Built only from what the candidates themselves say (what their titles are
 * made of, their brands, their prices), so it works in any department and is never a guess about what a category means. Each kind
 * is asked at most once, and only when the answer would meaningfully cut the list down.
 */
export function facetQuestion(items: Product[], ctx: FacetContext): QuestionPlan | undefined {
  const { policy } = ctx;
  const f = policy.facets;
  const N = items.length;
  if (!f.enabled || N < f.minCandidatesToAsk) return undefined;
  const candidates: Candidate[] = [];

  if (!ctx.asked.includes('term')) {
    const skip = new Set([...policy.stopwords, ...policy.fillerWords, ...policy.genericProductWords].map((word) => stem(word, policy)));
    for (const word of ctx.conceptWords) skip.add(stem(word, policy));
    for (const term of ctx.needTerms) skip.add(term);
    for (const item of items) for (const word of tokens(brandOf(item) ?? '')) skip.add(stem(word, policy));
    const df = new Map<string, Set<number>>();
    const surface = new Map<string, string>();
    items.forEach((item, index) => {
      for (const word of tokens(item.title)) {
        const root = stem(word, policy);
        if (root.length < 4 || /\d/.test(root) || skip.has(root)) continue;
        if (!df.has(root)) df.set(root, new Set());
        df.get(root)!.add(index);
        if (!surface.has(root)) surface.set(root, word);
      }
    });
    const eligible = [...df.entries()].filter(([, set]) => set.size / N >= f.minShare && set.size / N <= f.maxTermShare)
      .sort((a, b) => Math.abs(a[1].size / N - 0.35) - Math.abs(b[1].size / N - 0.35));
    const chosen: Array<[string, Set<number>]> = [];
    const covered = new Set<number>();
    for (const entry of eligible) {
      if (chosen.length >= f.maxOptions) break;
      const overlap = [...entry[1]].filter((index) => covered.has(index)).length;
      if (overlap > entry[1].size * 0.5) continue;
      chosen.push(entry);
      entry[1].forEach((index) => covered.add(index));
    }
    if (chosen.length >= 2) {
      candidates.push({
        kind: 'term', sets: chosen.map(([, set]) => set), expectedRemaining: remaining(chosen.map(([, set]) => set), N),
        options: chosen.map(([root]) => { const label = surface.get(root)!.replace(/^./, (c) => c.toUpperCase()); return { value: label, label, constraint: { terms: [root] } }; }),
      });
    }
  }

  if (!ctx.asked.includes('brand')) {
    const byBrand = new Map<string, Set<number>>();
    items.forEach((item, index) => { const brand = brandOf(item); if (brand) { const key = brand.toLowerCase(); if (!byBrand.has(key)) byBrand.set(key, new Set()); byBrand.get(key)!.add(index); } });
    const top = [...byBrand.entries()].filter(([, set]) => set.size / N >= f.minShare).sort((a, b) => b[1].size - a[1].size).slice(0, f.maxOptions);
    if (top.length >= 2) {
      candidates.push({
        kind: 'brand', sets: top.map(([, set]) => set), expectedRemaining: remaining(top.map(([, set]) => set), N),
        options: top.map(([key]) => {
          const label = items.map(brandOf).find((brand) => brand?.toLowerCase() === key)!;
          return { value: label, label, constraint: { brand: key } };
        }),
      });
    }
  }

  if (!ctx.asked.includes('price')) {
    const priced = items.map((item, index) => ({ price: Number(item.price), index })).filter((entry) => Number.isFinite(entry.price) && entry.price > 0).sort((a, b) => a.price - b.price);
    if (priced.length >= 4 && priced[priced.length - 1].price / priced[0].price >= f.price.minRatio) {
      const c1 = nice(priced[Math.floor(priced.length / 3)].price);
      const c2 = nice(priced[Math.floor((2 * priced.length) / 3)].price);
      if (c1 > 0 && c2 > c1) {
        const sets = [
          new Set(priced.filter((entry) => entry.price < c1).map((entry) => entry.index)),
          new Set(priced.filter((entry) => entry.price >= c1 && entry.price <= c2).map((entry) => entry.index)),
          new Set(priced.filter((entry) => entry.price > c2).map((entry) => entry.index)),
        ];
        if (sets.every((set) => set.size > 0)) {
          const currency = items.find((item) => item.currency)?.currency;
          const [a, b] = [money(c1, currency), money(c2, currency)];
          candidates.push({
            kind: 'price', sets, expectedRemaining: remaining(sets, priced.length),
            options: [
              { value: fillLabel(f.priceLabels.under, a, b), label: fillLabel(f.priceLabels.under, a, b), constraint: { priceMax: c1 } },
              { value: fillLabel(f.priceLabels.between, a, b), label: fillLabel(f.priceLabels.between, a, b), constraint: { priceMin: c1, priceMax: c2 } },
              { value: fillLabel(f.priceLabels.over, a, b), label: fillLabel(f.priceLabels.over, a, b), constraint: { priceMin: c2 } },
            ],
          });
        }
      }
    }
  }

  const viable = candidates.filter((candidate) => candidate.expectedRemaining <= f.maxExpectedRemaining)
    .sort((a, b) => a.expectedRemaining + f.priority[a.kind] - (b.expectedRemaining + f.priority[b.kind]));
  const best = viable[0];
  if (!best) return undefined;
  return {
    source: 'facet', factKey: `facet_${best.kind}`, question: f.questions[best.kind], uiInputType: 'card_choice',
    options: [...best.options, { value: policy.ask.noPreference, label: policy.ask.noPreference, constraint: { any: true } }],
  };
}

/** Does a product satisfy what the customer has already narrowed it by? */
export function satisfies(item: Product, constraints: { brands: string[]; priceMin?: number; priceMax?: number }): boolean {
  if (constraints.brands.length > 0 && !constraints.brands.includes((brandOf(item) ?? '').toLowerCase())) return false;
  const price = Number(item.price);
  if (constraints.priceMin !== undefined && !(price >= constraints.priceMin)) return false;
  if (constraints.priceMax !== undefined && !(price <= constraints.priceMax)) return false;
  return true;
}

export type { Constraint };
