/**
 * What a customer sees when they open one product: the catalogue record turned into plain, display-ready facts.
 *
 * Nothing here is written by a model. Every field is read from the product's own record (or its related products' records) and
 * only cleaned: markup removed, measure codes spelt out, empty and duplicate entries dropped, lists capped so the card stays
 * readable. A field the record does not carry is simply absent, so the card shows only what is known.
 */

export interface ProductDetailRelated {
  sku: string;
  title: string;
  price?: number | null;
  currency?: string;
  imageUrl?: string | null;
}

export interface ProductDetail {
  integrity?: import('@journeyax/business-pack').CatalogIntegrity;
  sku: string;
  title: string;
  brand?: string;
  category?: string;
  categoryPath?: string[];
  description?: string;
  imageUrl?: string | null;
  price?: number | null;
  currency?: string;
  features: string[];
  specs: Array<{ label: string; value: string }>;
  documents: Array<{ title: string; url: string; kind?: string }>;
  /** What the catalogue itself suggests alongside this product ("Have you considered?"). Suggestions only, never a statement of fit. */
  suggested: ProductDetailRelated[];
  /** Similar products and other sizes of the same line. */
  related: ProductDetailRelated[];
  /** Branch availability as the record states it. `inStock` is true when at least one branch has it. */
  availability?: { label: string; inStock?: boolean; source: 'catalogue'; branchChecked: false; branchesWithStock: number; branchCount: number };
  productUrl?: string;
  /** The catalogue's own rating, only when the record carries one (a few products do). */
  rating?: { value: number; count?: number };
}

const MAX_DESCRIPTION_CHARS = 900;
const MAX_FEATURES = 10;
const MAX_FEATURE_CHARS = 220;
const MAX_SPECS = 12;
const MAX_DOCUMENTS = 6;
export const MAX_RELATED = 4;

import { humanizeMeasure as displayMeasure } from '@journeyax/shared-types';
import { normalizeCatalogProduct, readPath, resolveCatalogMapping, type ResolvedCatalogMapping } from '@journeyax/business-pack';

const stripMarkup = (text: unknown): string =>
  String(text ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const tidy = (text: unknown): string => stripMarkup(text).replace(/\s+/g, ' ').trim();
export function humanizeMeasure(value: unknown): string { return displayMeasure(tidy(value)); }

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${(stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s]+$/, ''))}…`;
}

const isHttp = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url.trim());

function documentTitle(doc: any): string {
  const given = tidy(doc?.title);
  if (given) return given.replace(/\.(pdf|docx?|xlsx?)$/i, '');
  try {
    const last = decodeURIComponent(new URL(doc.url).pathname.split('/').filter(Boolean).pop() || '');
    return last.replace(/\.(pdf|docx?|xlsx?)$/i, '').replace(/[-_]+/g, ' ').trim() || doc.url;
  } catch {
    return String(doc.url);
  }
}

export function toRelated(doc: any, mapping = resolveCatalogMapping()): ProductDetailRelated | undefined {
  const normalized = normalizeCatalogProduct(doc, mapping, { title: '', category: '' });
  if (!normalized.integrity.identityConsistent || normalized.availability === 'excluded') return undefined;
  const sku = normalized.sku.trim();
  const title = tidy(normalized.title);
  if (!sku || !title) return undefined;
  const amount = normalized.price;
  return {
    sku,
    title,
    price: typeof amount === 'number' ? amount : null,
    ...(normalized.currency ? { currency: normalized.currency } : {}),
    imageUrl: isHttp(normalized.imageUrl) ? normalized.imageUrl : null,
  };
}

/** True for a record the catalogue no longer sells. */
export const isRetired = (doc: any): boolean =>
  doc?.discontinued === true || doc?.delisted === true || ['discontinued', 'delisted', 'retired'].includes(String(doc?.status || '').toLowerCase());

export function buildProductDetail(input: any, linked: { related?: any[]; suggested?: any[] } = {}, mapping: ResolvedCatalogMapping = resolveCatalogMapping()): ProductDetail {
  const canonical = normalizeCatalogProduct(input, mapping, { title: '', category: '' });
  if (!canonical.integrity.identityConsistent) return { sku: canonical.sku, title: canonical.sku, integrity: canonical.integrity, price: null, features: [], specs: [], documents: [], suggested: [], related: [] };
  const doc = { ...input, parentSku: canonical.sku, name: canonical.title, description: canonical.description, narrative: undefined, priceUSD: undefined, price: canonical.price, currency: canonical.currency,
    brand: mapping.brandPaths.map(path => readPath(input, path)).find(value => typeof value === 'string'), brandCode: undefined, category: canonical.category, categoryPath: canonical.categoryTrail,
    rating: canonical.rating === undefined ? undefined : { value: canonical.rating, count: canonical.ratingCount },
    stock: canonical.branchesTotal === undefined || canonical.branchesAvailable === undefined ? undefined : { branchCount: canonical.branchesTotal, availableBranchCount: canonical.branchesAvailable },
    imageUrl: canonical.imageUrl, specs: canonical.specs, documents: canonical.documents, featuresList: [...canonical.highlights, ...canonical.cautions] };
  const amount = doc?.priceUSD?.min ?? doc?.price?.amount ?? (typeof doc?.price === 'number' ? doc.price : undefined);

  const features: string[] = [];
  const seen = new Set<string>();
  const rawFeatures = Array.isArray(doc?.featuresList) ? doc.featuresList : Array.isArray(doc?.features) ? doc.features : [];
  for (const entry of rawFeatures) {
    const text = clip(tidy(typeof entry === 'string' ? entry : entry?.text ?? entry?.title), MAX_FEATURE_CHARS);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    features.push(text);
    if (features.length >= MAX_FEATURES) break;
  }

  const specs: ProductDetail['specs'] = [];
  const rawSpecs = doc?.specs && typeof doc.specs === 'object' && !Array.isArray(doc.specs) ? doc.specs : {};
  for (const [key, raw] of Object.entries(rawSpecs)) {
    const label = tidy(key);
    const value = humanizeMeasure(raw);
    if (!label || !value || value === 'null' || value === 'undefined') continue;
    specs.push({ label, value });
    if (specs.length >= MAX_SPECS) break;
  }

  const documents: ProductDetail['documents'] = [];
  const urls = new Set<string>();
  for (const entry of Array.isArray(doc?.documents) ? doc.documents : []) {
    if (!entry || !isHttp(entry.url)) continue;
    // A link to the maker's home page is not a document a customer can read about this product.
    if (String(entry.kind || entry.type || '').toLowerCase() === 'supplier') continue;
    const url = entry.url.trim();
    if (urls.has(url)) continue;
    urls.add(url);
    documents.push({ title: documentTitle(entry), url, ...(entry.kind || entry.type ? { kind: String(entry.kind || entry.type) } : {}) });
    if (documents.length >= MAX_DOCUMENTS) break;
  }

  const self = String(doc?.parentSku ?? doc?.sku ?? '');
  // Other products named by the record: skip this product, retired ones, repeats and anything shown in an earlier list.
  const shown = new Set<string>([self]);
  const products = (docs: any[] = []): ProductDetailRelated[] => {
    const out: ProductDetailRelated[] = [];
    for (const candidate of docs) {
      if (isRetired(candidate)) continue;
      const item = toRelated(candidate, mapping);
      if (!item || shown.has(item.sku)) continue;
      shown.add(item.sku);
      out.push(item);
      if (out.length >= MAX_RELATED) break;
    }
    return out;
  };
  const suggested = products(linked.suggested);
  const related = products(linked.related);

  const stock = doc?.stock;
  let availability: ProductDetail['availability'];
  if (stock && Number.isFinite(stock.branchCount) && stock.branchCount > 0 && Number.isFinite(stock.availableBranchCount)) {
    const branchCount = Number(stock.branchCount);
    const branchesWithStock = Number(stock.availableBranchCount);
    availability = {
      source: 'catalogue', branchChecked: false,
      branchesWithStock,
      branchCount,
      label: `Catalogue lists ${branchesWithStock} of ${branchCount} branches; current stock not checked`,
    };
  }

  // A record's description often ends with the same bullet points its feature list repeats; they are shown once, as features.
  let fullDescription = tidy(doc?.description) || tidy(doc?.narrative);
  const firstFeature = features.map((f) => fullDescription.indexOf(f)).filter((i) => i > 40).sort((a, b) => a - b)[0];
  if (firstFeature !== undefined) fullDescription = fullDescription.slice(0, firstFeature).replace(/[\s,;:–-]+$/, '').trim();
  const description = clip(fullDescription, MAX_DESCRIPTION_CHARS);
  const path = Array.isArray(doc?.categoryPath) ? doc.categoryPath.map(String) : undefined;
  const productUrl = canonical.sourceUrl;
  const ratingValue = Number(doc?.rating?.value);
  const ratingCount = Number(doc?.rating?.count);
  const rating: ProductDetail['rating'] = Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 5
    ? { value: ratingValue, ...(Number.isFinite(ratingCount) && ratingCount > 0 ? { count: ratingCount } : {}) }
    : undefined;

  return {
    sku: self,
    integrity: canonical.integrity,
    title: tidy(doc?.name ?? doc?.title) || self,
    ...(tidy(doc?.brand ?? doc?.brandCode) ? { brand: tidy(doc?.brand ?? doc?.brandCode) } : {}),
    ...(doc?.category || path?.length ? { category: String(doc?.category || path![path!.length - 1]) } : {}),
    ...(path?.length ? { categoryPath: path } : {}),
    ...(description ? { description } : {}),
    imageUrl: isHttp(doc?.imageUrl) ? doc.imageUrl : null,
    price: typeof amount === 'number' ? amount : null,
    ...(doc?.currency ? { currency: String(doc.currency) } : {}),
    features,
    specs,
    documents,
    suggested,
    related,
    ...(availability ? { availability } : {}),
    ...(productUrl ? { productUrl } : {}),
    ...(rating ? { rating } : {}),
  };
}
