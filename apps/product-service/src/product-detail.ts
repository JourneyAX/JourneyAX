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
  related: ProductDetailRelated[];
  /** Branch availability as the record states it. `inStock` is true when at least one branch has it. */
  availability?: { label: string; inStock: boolean; branchesWithStock: number; branchCount: number };
  productUrl?: string;
}

const MAX_DESCRIPTION_CHARS = 900;
const MAX_FEATURES = 10;
const MAX_FEATURE_CHARS = 220;
const MAX_SPECS = 12;
const MAX_DOCUMENTS = 6;
export const MAX_RELATED = 4;

/** Measure codes (UN/CEFACT Recommendation 20) as they appear after a number in catalogue specs, spelt out for a customer. */
const MEASURE_UNITS: Record<string, string> = {
  MMT: 'mm', CMT: 'cm', MTR: 'm', KMT: 'km', INH: 'in', FOT: 'ft', YRD: 'yd',
  MMK: 'mm²', CMK: 'cm²', MTK: 'm²', MMQ: 'mm³', CMQ: 'cm³', MTQ: 'm³',
  MLT: 'mL', LTR: 'L', GLL: 'gal',
  GRM: 'g', KGM: 'kg', TNE: 't', LBR: 'lb', ONZ: 'oz',
  ANN: 'years', MON: 'months', DAY: 'days', HUR: 'hours', MIN: 'min', SEC: 's',
  CEL: '°C', WTT: 'W', KWT: 'kW', VLT: 'V', AMP: 'A', BAR: 'bar', PAL: 'Pa', KPA: 'kPa', NEW: 'N',
  PCE: 'pieces', SET: 'set', PR: 'pairs', P1: '%',
};

const MEASURE = /^(-?\d+(?:[.,]\d+)?)\s*([A-Z0-9]{2,3})$/;

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

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${(stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s]+$/, ''))}…`;
}

/** "120 CMT" becomes "120 cm"; a value that is not a number and a known code is returned as written. */
export function humanizeMeasure(value: unknown): string {
  const raw = tidy(value);
  const match = raw.match(MEASURE);
  if (!match) return raw;
  const unit = MEASURE_UNITS[match[2]];
  return unit ? `${match[1]} ${unit}` : raw;
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

export function toRelated(doc: any): ProductDetailRelated | undefined {
  const sku = String(doc?.parentSku ?? doc?.sku ?? '').trim();
  const title = tidy(doc?.name ?? doc?.title);
  if (!sku || !title) return undefined;
  const amount = doc?.priceUSD?.min ?? doc?.price?.amount ?? (typeof doc?.price === 'number' ? doc.price : undefined);
  return {
    sku,
    title,
    price: typeof amount === 'number' ? amount : null,
    ...(doc?.currency ? { currency: String(doc.currency) } : {}),
    imageUrl: isHttp(doc?.imageUrl) ? doc.imageUrl : null,
  };
}

/** True for a record the catalogue no longer sells. */
export const isRetired = (doc: any): boolean =>
  doc?.discontinued === true || doc?.delisted === true || ['discontinued', 'delisted', 'retired'].includes(String(doc?.status || '').toLowerCase());

export function buildProductDetail(doc: any, relatedDocs: any[] = []): ProductDetail {
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
    if (String(entry.type || '').toLowerCase() === 'supplier') continue;
    const url = entry.url.trim();
    if (urls.has(url)) continue;
    urls.add(url);
    documents.push({ title: documentTitle(entry), url, ...(entry.type ? { kind: String(entry.type) } : {}) });
    if (documents.length >= MAX_DOCUMENTS) break;
  }

  const self = String(doc?.parentSku ?? doc?.sku ?? '');
  const related: ProductDetailRelated[] = [];
  for (const candidate of relatedDocs) {
    if (isRetired(candidate)) continue;
    const item = toRelated(candidate);
    if (item && item.sku !== self && !related.some((r) => r.sku === item.sku)) related.push(item);
    if (related.length >= MAX_RELATED) break;
  }

  const stock = doc?.stock;
  let availability: ProductDetail['availability'];
  if (stock && Number.isFinite(stock.branchCount) && stock.branchCount > 0 && Number.isFinite(stock.availableBranchCount)) {
    const branchCount = Number(stock.branchCount);
    const branchesWithStock = Number(stock.availableBranchCount);
    availability = {
      inStock: branchesWithStock > 0,
      branchesWithStock,
      branchCount,
      label: branchesWithStock > 0
        ? `Available at ${branchesWithStock} of ${branchCount} branches`
        : `Not showing as available at any of ${branchCount} branches`,
    };
  }

  const description = clip(tidy(doc?.description) || tidy(doc?.narrative), MAX_DESCRIPTION_CHARS);
  const path = Array.isArray(doc?.categoryPath) ? doc.categoryPath.map(String) : undefined;
  const productUrl = [doc?.web?.productUrl, doc?.url].find(isHttp);

  return {
    sku: self,
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
    related,
    ...(availability ? { availability } : {}),
    ...(productUrl ? { productUrl } : {}),
  };
}
