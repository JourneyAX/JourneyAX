import { DocumentType, DocumentMetadata } from './types';

// ── URL-based classification ───────────────────────────────────────────
const URL_PATTERNS: Array<{ pattern: RegExp; type: DocumentType; category?: string }> = [
  // Products by category
  { pattern: /\/basins?\//i, type: 'product', category: 'Basins' },
  { pattern: /\/toilets?|\/suites?\//i, type: 'product', category: 'Toilet Suites' },
  { pattern: /\/tapware\//i, type: 'product', category: 'Tapware' },
  { pattern: /\/showers?\//i, type: 'product', category: 'Showers' },
  { pattern: /\/baths?\//i, type: 'product', category: 'Baths' },
  { pattern: /\/accessories\//i, type: 'product', category: 'Accessories' },
  { pattern: /\/spare-parts?\//i, type: 'product', category: 'Spare Parts' },
  { pattern: /\/cisterns?\//i, type: 'product', category: 'Cisterns' },
  { pattern: /\/flush-plates?\//i, type: 'product', category: 'Flush Plates' },

  // Collections
  { pattern: /\/collections?\//i, type: 'collection' },
  { pattern: /urbane/i, type: 'collection' },
  { pattern: /liano/i, type: 'collection' },
  { pattern: /contura/i, type: 'collection' },
  { pattern: /luna/i, type: 'collection' },
  { pattern: /opal/i, type: 'collection' },

  // Design & Planning
  { pattern: /\/design[-_]?plan/i, type: 'design' },
  { pattern: /\/inspiration/i, type: 'design' },
  { pattern: /\/bathroom[-_]?design/i, type: 'design' },

  // Troubleshooting & Help
  { pattern: /\/help\//i, type: 'troubleshooting' },
  { pattern: /\/troubleshoot/i, type: 'troubleshooting' },
  { pattern: /\/support/i, type: 'troubleshooting' },
  { pattern: /\/faq/i, type: 'faq' },

  // Installation
  { pattern: /\/install/i, type: 'installation' },
  { pattern: /\/how[-_]?to/i, type: 'installation' },

  // PDFs
  { pattern: /\.pdf$/i, type: 'pdf' },
];

// ── Content-based classification ───────────────────────────────────────
const CONTENT_PATTERNS: Array<{ pattern: RegExp; type: DocumentType; category?: string }> = [
  // Product indicators
  { pattern: /\bSKU\b|\bproduct code\b|\bRRP\b|\$\d+/i, type: 'product' },
  { pattern: /\bWELS\b.*star|water rating/i, type: 'product' },
  { pattern: /\badd to cart\b|\bbuy now\b/i, type: 'product' },

  // Troubleshooting indicators
  { pattern: /\btroubleshoot/i, type: 'troubleshooting' },
  { pattern: /\bdiagnostic\b|\bsymptom\b|\bproblem\b.*\bsolution\b/i, type: 'troubleshooting' },
  { pattern: /\bleaking\b|\bdripping\b|\bblocked\b|\bnot flushing\b/i, type: 'troubleshooting' },
  { pattern: /\bstep\s*\d+\b.*\bcheck\b/i, type: 'troubleshooting' },

  // Installation indicators
  { pattern: /\binstallation\s*(guide|instructions?|manual)\b/i, type: 'installation' },
  { pattern: /\btools?\s*(required|needed)\b/i, type: 'installation' },
  { pattern: /\brough[-_]?in\b|\bplumbing\b/i, type: 'installation' },

  // FAQ indicators
  { pattern: /\bfrequently asked\b|\bfaq\b/i, type: 'faq' },
  { pattern: /\bQ:\s|A:\s/m, type: 'faq' },

  // Design indicators
  { pattern: /\bbathroom\s*(design|style|inspiration|layout)\b/i, type: 'design' },
  { pattern: /\bcollection\b.*\b(features?|range|includes?)\b/i, type: 'design' },
  { pattern: /\bbundle\b|\bpackage\b|\bsuite\b.*\bcomplete\b/i, type: 'design' },
];

/**
 * Classify a crawled page by its URL + content to determine document type.
 */
export function classifyPage(
  url: string,
  content: string,
  title: string
): { type: DocumentType; category?: string; collection?: string } {
  // 1. Try URL-based classification first (most reliable)
  for (const rule of URL_PATTERNS) {
    if (rule.pattern.test(url)) {
      return {
        type: rule.type,
        category: rule.category,
        collection: extractCollection(url, content),
      };
    }
  }

  // 2. Try content-based classification
  const contentSample = (title + ' ' + content.slice(0, 2000)).toLowerCase();
  for (const rule of CONTENT_PATTERNS) {
    if (rule.pattern.test(contentSample)) {
      return {
        type: rule.type,
        category: rule.category,
        collection: extractCollection(url, content),
      };
    }
  }

  // 3. Default to general
  return {
    type: 'general',
    collection: extractCollection(url, content),
  };
}

/**
 * Extract collection name from URL or content.
 */
function extractCollection(url: string, content: string): string | undefined {
  const collections = [
    'Urbane II', 'Urbane', 'Liano II', 'Liano',
    'Contura', 'Luna', 'Opal', 'Elvire',
    'Caroma Profile', 'GreenStar',
  ];

  const combined = url + ' ' + content.slice(0, 1000);
  for (const col of collections) {
    if (combined.toLowerCase().includes(col.toLowerCase())) {
      return col;
    }
  }
  return undefined;
}

/**
 * Classify an MD file from the GWA folder by its path and content.
 */
export function classifyMdFile(
  filePath: string,
  content: string
): { type: DocumentType; category?: string; collection?: string } {
  const path = filePath.toLowerCase();

  if (path.includes('trouble') || path.includes('diagnostic')) {
    return { type: 'troubleshooting', collection: extractCollection(filePath, content) };
  }
  if (path.includes('costbom') || path.includes('pricing') || path.includes('product')) {
    return { type: 'product', collection: extractCollection(filePath, content) };
  }
  if (path.includes('bathroom designer') || path.includes('bundle') || path.includes('collection')) {
    return { type: 'design', collection: extractCollection(filePath, content) };
  }
  if (path.includes('quote') || path.includes('customer_support') || path.includes('showroom')) {
    return { type: 'general', collection: extractCollection(filePath, content) };
  }

  // Fall back to content-based
  return classifyPage(filePath, content, '');
}

/**
 * Extract product metadata from content (price, SKU, images, finishes).
 */
// Known Caroma spec labels (longest-first so "item material" beats "item").
const SPEC_KEYS = [
  'item code', 'product types', 'item material', 'capacity size', 'capacity to overflow',
  'number of tap holes', 'independent living compliant', 'as1428.1 accessible',
  'wels rating', 'flow rate', 'installation type', 'range', 'brand', 'colour', 'color',
  'shape', 'overflow', 'material', 'finish', 'warranty', 'dimensions', 'width', 'height',
  'depth', 'weight', 'series',
].sort((a, b) => b.length - a.length);

/** Parse the "Specifications" block — key+value are concatenated per \n\n block. */
function parseSpecBlock(content: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const start = content.indexOf('Specifications');
  if (start === -1) return specs;
  const end = content.indexOf('Product Codes', start);
  const section = content.slice(start + 14, end === -1 ? start + 3000 : end);
  for (const block of section.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)) {
    const lower = block.toLowerCase();
    const key = SPEC_KEYS.find(k => lower.startsWith(k));
    if (!key) continue;
    let value = block.slice(key.length).trim();
    const link = value.match(/^\[([^\]]+)\]/); // range[Liano II](url) → Liano II
    if (link) value = link[1].trim();
    value = value.replace(/\\+/g, '').trim();
    if (value && value.length < 120) specs[key] = value;
  }
  return specs;
}

/** Pull the real product image from HTML, ranking PIM product thumbnails first. */
function extractProductImageFromHtml(html: string): string[] {
  if (!html) return [];
  const EXCLUDE = /logo|union\.svg|group_1156|sprite|icon|placeholder|favicon|swatch|banner|hero|carousel|landing|homepage/i;
  const urls = new Set<string>();
  const attrRe = /(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|avif))[^"']*["']/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const u = m[1];
    if (!/^https?:\/\//i.test(u) || EXCLUDE.test(u)) continue;
    urls.add(u);
  }
  // Rank: real product thumbnails (PIM asset store, keyed by SKU) first.
  return [...urls].sort((a, b) => {
    const score = (u: string) =>
      /pim-assets\/(?:productthumbnail|product)/i.test(u) ? 0 : /cdn\.caroma/i.test(u) ? 1 : 2;
    return score(a) - score(b);
  });
}

const DOC_EXT = 'pdf|dae|rfa|skp|dxf|obj|3ds';

/** Extract linked technical documents: install guide, CAD/3D files, spec/warranty PDFs. */
function extractLinkedDocs(content: string, html: string): { title: string; url: string; kind?: string }[] {
  const docs: { title: string; url: string; kind?: string }[] = [];
  const seen = new Set<string>();
  const push = (url: string, title: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const s = (title + ' ' + url).toLowerCase();
    const kind = /\.(dae|rfa|skp|dxf|obj|3ds)/.test(url) ? 'cad-3d'
      : /install/.test(s) ? 'installation'
      : /warrant/.test(s) ? 'warranty'
      : /spec|tech|tm_|datasheet/.test(s) ? 'spec-sheet' : 'document';
    docs.push({ url, title: title || kind, kind });
  };
  const all = `${content}\n${html || ''}`;
  const re = new RegExp(`(https?:\\/\\/[^\\s"')<>]+\\.(?:${DOC_EXT}))`, 'gi');
  let m;
  while ((m = re.exec(all)) !== null) push(m[1], '');
  return docs.slice(0, 12);
}

/** Parse the JSON-LD Product block — clean structured data (sku, price, specs, variants). */
function parseProductJsonLd(html: string): any | null {
  if (!html) return null;
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let d: any;
    try { d = JSON.parse(b[1].trim()); } catch { continue; }
    const items = Array.isArray(d) ? d : (d['@graph'] || [d]);
    for (const it of items) if (it && it['@type'] === 'Product') return it;
  }
  return null;
}

export function extractProductMetadata(content: string, html = ''): Partial<DocumentMetadata> {
  const result: Partial<DocumentMetadata> = {};

  // ── PRIMARY: JSON-LD Product (clean structured data) ──────────────
  const ld = parseProductJsonLd(html);
  if (ld) {
    if (ld.description) result.description = String(ld.description).slice(0, 500);
    if (ld.sku) result.sku = String(ld.sku);
    if (ld.category) result.category = String(ld.category);
    const img = typeof ld.image === 'string' ? ld.image
      : Array.isArray(ld.image) ? ld.image[0] : ld.image?.url;
    if (img) result.images = [img];
    const off = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    if (off?.price) { result.price = parseFloat(off.price); result.currency = off.priceCurrency || 'AUD'; }
    if (off?.availability) result.availability = String(off.availability).split('/').pop(); // InStock / OutOfStock
    const specsLd: Record<string, string> = {};
    for (const a of ld.additionalProperty || []) if (a?.name) specsLd[a.name] = String(a.value ?? '');
    if (Object.keys(specsLd).length) result.specs = specsLd;
    if (specsLd['Range']) result.collection = specsLd['Range'];
    const variants = ld.isVariantOf?.hasVariant || ld.model || [];
    if (Array.isArray(variants) && variants.length) {
      result.variants = variants.filter((v: any) => v?.sku).map((v: any) => ({
        sku: String(v.sku),
        finish: v.color || v.name,
        availability: v.offers?.availability ? String(v.offers.availability).split('/').pop() : undefined,
      }));
      result.finishes = variants.map((v: any) => v.color || v.name).filter(Boolean);
    }
  }

  // ── FALLBACK: markdown/regex for anything JSON-LD didn't provide ───
  // Price (AUD)
  if (result.price == null) {
    const priceMatch = content.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (priceMatch) { result.price = parseFloat(priceMatch[1].replace(/,/g, '')); result.currency = 'AUD'; }
  }

  // Structured technical specs (item code, material, WELS, dimensions, warranty…)
  const specs = result.specs || parseSpecBlock(content);
  if (!result.specs && Object.keys(specs).length) result.specs = specs;

  // SKU — Caroma labels it "item code"; keep SKU/Product Code as fallbacks
  if (!result.sku) {
    const sku = specs['item code'] ||
      content.match(/(?:item\s*code|SKU|product\s*code)[:\s]*([A-Za-z0-9][\w-]{3,})/i)?.[1];
    if (sku) result.sku = sku;
  }

  if (!result.category && specs['product types']) result.category = specs['product types'];
  if (!result.collection && (specs['range'] || specs['series'])) result.collection = specs['range'] || specs['series'];

  // Images — prefer real product images from HTML, fall back to markdown/CDN
  if (!result.images) {
  let images = extractProductImageFromHtml(html);
  if (images.length === 0) {
    const md: string[] = [];
    const imgRegex = /!\[.*?\]\((https?:\/\/[^\s)]+(?:\.(?:jpg|jpeg|png|webp|avif))[^\s)]*)\)/gi;
    let im;
    while ((im = imgRegex.exec(content)) !== null) {
      if (!/logo|union\.svg|group_1156|sprite|icon/i.test(im[1])) md.push(im[1]);
    }
    images = md;
  }
  if (images.length > 0) result.images = images.slice(0, 5);
  }

  // Linked technical documents (install guide, CAD/3D files, spec/warranty PDFs)
  const docs = extractLinkedDocs(content, html);
  if (docs.length > 0) result.documents = docs;

  // Finishes — fallback only if JSON-LD variants didn't supply them
  if (!result.finishes || result.finishes.length === 0) {
    const finishKeywords = [
      'Matte Black', 'Chrome', 'Brushed Brass', 'Brushed Nickel',
      'Gunmetal', 'Brushed Bronze', 'White', 'Gloss White',
    ];
    const finishes = finishKeywords.filter(f => content.toLowerCase().includes(f.toLowerCase()));
    if (finishes.length > 0) result.finishes = finishes;
    const primary = specs['colour'] || specs['color'] || specs['finish'];
    if (primary) result.finishes = [primary, ...(result.finishes || []).filter(x => x !== primary)];
  }

  return result;
}
