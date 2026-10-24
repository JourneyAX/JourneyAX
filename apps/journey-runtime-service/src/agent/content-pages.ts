/**
 * The shop's own web pages as text the agent can read: project how-tos, inspiration, compliance notes, trade-tool pages.
 *
 * A page is found by the words of the customer's question (titles, headings, summaries and categories count for more than the
 * body), then read with the same passage machinery as a product's guide (product-guides.ts). The products a page features are
 * kept as identifiers only; the tool checks each against the catalogue before the agent may show it.
 */
import { createHash } from 'node:crypto';
import { tidyGuideText, type ProductGuideRecord } from './product-guides';

export interface ContentPageRecord {
  tenantId: string;
  /** A stable id of the page: the same address always gives the same id. */
  pageId: string;
  url: string;
  title: string;
  summary?: string;
  /** The labels the site files the page under (category, job, section of the address). */
  categories: string[];
  headings: string[];
  text: string;
  textChars: number;
  /** True when the page was longer than the store keeps and the text stops short of its end. */
  truncated?: boolean;
  /** The products the page features, by catalogue identifier. */
  products: Array<{ sku: string; name?: string }>;
  updatedAt?: Date;
}

export interface PageHit { pageId: string; title: string; summary?: string; url: string; categories: string[]; products: number; score: number }

export const contentPageId = (url: string): string => createHash('sha1').update(url.trim()).digest('hex').slice(0, 32);

const MAX_PAGE_CHARS = 120_000;
const MAX_PRODUCTS_PER_PAGE = 40;

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const labelsOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map(clean).filter(Boolean);

/** A page as the loader keeps it, from one row of the crawled content file; a row with no title, address or text is not a page. */
export function contentPageFromRow(row: any): Omit<ContentPageRecord, 'tenantId'> | undefined {
  const url = clean(row?.url);
  const title = clean(row?.title) || clean(row?.displayTitle);
  const full = tidyGuideText(row?.text);
  if (!/^https?:\/\//i.test(url) || !title || !full) return undefined;
  const text = full.length > MAX_PAGE_CHARS ? full.slice(0, MAX_PAGE_CHARS) : full;
  const seen = new Set<string>();
  const products: ContentPageRecord['products'] = [];
  for (const entry of Array.isArray(row?.featuredProducts) ? row.featuredProducts : []) {
    const sku = clean(entry?.sku);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    products.push({ sku, ...(clean(entry?.name) ? { name: clean(entry.name) } : {}) });
    if (products.length >= MAX_PRODUCTS_PER_PAGE) break;
  }
  const headings = (Array.isArray(row?.headings) ? row.headings : []).map((heading: any) => clean(typeof heading === 'string' ? heading : heading?.text)).filter(Boolean);
  const categories: string[] = [];
  for (const label of [...labelsOf(row?.contentCategory), ...labelsOf(row?.job), ...labelsOf(row?.urlCategory)]) {
    if (!categories.some((known) => known.toLowerCase() === label.toLowerCase())) categories.push(label);
  }
  return {
    pageId: contentPageId(url), url, title, ...(clean(row?.summary) ? { summary: clean(row.summary) } : {}), categories, headings, text, textChars: text.length,
    ...(text.length < full.length ? { truncated: true } : {}), products,
  };
}

const wordsOf = (value: string): string[] => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => word.length > 2);
const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.length - short.length <= 5 && long.startsWith(short);
};

interface Indexed { title: string[]; outline: string[]; body: Set<string> }
const indexes = new WeakMap<ContentPageRecord, Indexed>();
const indexOf = (page: ContentPageRecord): Indexed => {
  let found = indexes.get(page);
  if (!found) {
    found = {
      title: [...new Set(wordsOf(page.title))],
      outline: [...new Set(wordsOf([page.summary || '', ...page.headings, ...page.categories].join(' ')))],
      body: new Set(wordsOf(page.text)),
    };
    indexes.set(page, found);
  }
  return found;
};

/** The pages that best match the question, best first. A word counts for more the fewer pages hold it, and most when it is in the title. */
export function searchPages(pages: ContentPageRecord[], question: string, limit = 5): PageHit[] {
  const wanted = [...new Set(wordsOf(question))];
  if (wanted.length === 0 || pages.length === 0) return [];
  const indexed = pages.map(indexOf);
  const field = (page: Indexed, token: string): number => (page.title.some((w) => sameWord(w, token)) ? 3 : page.outline.some((w) => sameWord(w, token)) ? 2 : page.body.has(token) ? 1 : 0);
  const held = indexed.map((page) => wanted.map((token) => field(page, token)));
  const weight = wanted.map((_, i) => {
    const holding = held.filter((row) => row[i] > 0).length;
    return holding > 0 ? Math.log(1 + pages.length / holding) : 0;
  });
  return pages
    .map((page, index) => ({ page, score: held[index].reduce((sum, level, i) => sum + level * weight[i], 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.title.length - b.page.title.length)
    .slice(0, Math.max(1, limit))
    .map(({ page, score }) => ({ pageId: page.pageId, title: page.title, summary: page.summary, url: page.url, categories: page.categories, products: page.products.length, score: Math.round(score * 100) / 100 }));
}

/** One page by what the model has: its id (or the start of it), its address, its exact title, or a title only one page contains. */
export function findPage(pages: ContentPageRecord[], reference: string): ContentPageRecord | { error: 'not_found' | 'ambiguous'; candidates: string[] } {
  const ref = reference.trim();
  const lower = ref.toLowerCase();
  if (!ref) return { error: 'not_found', candidates: [] };
  const exact = pages.find((page) => page.pageId === ref || page.url.toLowerCase() === lower)
    || (ref.length >= 6 ? pages.find((page) => page.pageId.startsWith(lower)) : undefined)
    || pages.filter((page) => page.title.toLowerCase() === lower)[0];
  if (exact) return exact;
  const containing = pages.filter((page) => page.title.toLowerCase().includes(lower));
  if (containing.length === 1) return containing[0];
  return { error: containing.length > 1 ? 'ambiguous' : 'not_found', candidates: containing.slice(0, 5).map((page) => page.title) };
}

/** A page in the shape the passage reader takes. */
export function pageAsGuide(page: ContentPageRecord): ProductGuideRecord {
  return { tenantId: page.tenantId, docId: page.pageId, title: page.title, kind: 'page', url: page.url, text: page.text, textChars: page.textChars, truncated: page.truncated, skus: [] };
}
