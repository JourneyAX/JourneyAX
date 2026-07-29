/**
 * IBM WebSphere Commerce REST connector.
 *
 * Some enterprise stores (e.g. Momentec/Augusta) render products only via AJAX,
 * so generic HTML scraping can't reach the full catalogue. WebSphere exposes a
 * clean REST catalogue API instead — this connector walks the category tree and
 * paginates every product into a normalised shape, including the SKU
 * (`partNumber`) that HTML scraping can't recover.
 *
 * Config-driven (knowledgeSource): storeId, catalogId, optional categoryIds,
 * currency. The connector code is generic WebSphere; only those ids are config.
 *
 *   categoryview/@top?catalogId=…                     → top categories
 *   categoryview/byParentCategory/{id}?catalogId=…    → children (recursed)
 *   productview/byCategory/{id}?pageNumber=N&pageSize= → products (paginated)
 */

export interface WsProduct {
  productId: string;
  sku?: string;
  title: string;
  url: string;
  price: number | null;
  currency: string;
  images: string[];
  category?: string;
  shortDescription?: string;
  longDescription?: string;
  // ── enriched from byId detail ──
  manufacturer?: string;
  options?: Record<string, string[]>;   // Defining attrs: Color, Size, …
  specs?: Record<string, string>;        // Descriptive attrs: Decoration Methods, Fabric, Gender, …
  variants?: { sku?: string; attrs?: Record<string, string> }[]; // each SKU (colour/size)
  documents?: { title: string; url: string; kind?: string }[];
}

export interface WsConfig {
  base: string;        // e.g. https://www.momentecbrands.com
  storeId: string;
  catalogId: string;
  categoryIds?: string[];
  currency?: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const PAGE_SIZE = 50;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.json();
}

/** Walk the catalogue category tree; return every category id (top + descendants). */
export async function enumerateCategories(cfg: WsConfig, log?: (m: string) => void): Promise<string[]> {
  const { base, storeId, catalogId } = cfg;
  const ids = new Set<string>();
  const visit = async (parent: '@top' | string, depth: number): Promise<void> => {
    if (depth > 6) return; // guard against cycles / runaway depth
    const url = parent === '@top'
      ? `${base}/wcs/resources/store/${storeId}/categoryview/@top?catalogId=${catalogId}`
      : `${base}/wcs/resources/store/${storeId}/categoryview/byParentCategory/${parent}?catalogId=${catalogId}`;
    let data: any;
    try { data = await getJson(url); } catch { return; }
    const groups: any[] = data.CatalogGroupView || data.catalogGroupView || [];
    for (const g of groups) {
      const id = String(g.uniqueID || g.categoryId || '').trim();
      if (id && !ids.has(id)) { ids.add(id); await visit(id, depth + 1); }
    }
  };
  await visit('@top', 0);
  log?.(`enumerated ${ids.size} categories`);
  return [...ids];
}

function mapProduct(cfg: WsConfig, it: any): WsProduct {
  const offers: any[] = Array.isArray(it.Price) ? it.Price : [];
  const offer = offers.find((p) => /offer/i.test(p.priceUsage || '')) || offers[0];
  const priceVal = offer ? parseFloat(String(offer.priceValue).replace(/[^0-9.]/g, '')) : NaN;
  const abs = (u?: string) => (u ? (u.startsWith('http') ? u : new URL(u, cfg.base).href) : undefined);
  const images = Array.from(new Set([it.fullImage, it.thumbnail].map(abs).filter(Boolean) as string[]));
  const productId = String(it.uniqueID || '');
  return {
    productId,
    sku: it.partNumber ? String(it.partNumber) : undefined,
    title: String(it.name || it.partNumber || productId),
    url: `${cfg.base}/ProductDisplay?storeId=${cfg.storeId}&catalogId=${cfg.catalogId}&productId=${productId}&langId=-1`,
    price: Number.isFinite(priceVal) ? priceVal : null,
    currency: cfg.currency || 'USD',
    images,
    category: it.parentCategoryID ? String(it.parentCategoryID) : undefined,
    shortDescription: it.shortDescription ? String(it.shortDescription).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined,
    longDescription: it.longDescription ? String(it.longDescription).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined,
  };
}

/**
 * Enrich a product with its full detail (byId): defining attributes (Colour,
 * Size) → options; descriptive attributes (Decoration Methods, Fabric, Gender…)
 * → specs; every variant SKU; manufacturer; non-image attachments → documents.
 * Generic — uses each attribute's own `name`/`usage`, no per-store field names.
 */
/** A product's configurable option space, as the source platform models it.
 *  `defining` attributes form buyable variants (colour, size); `descriptive`
 *  are fixed characteristics (closure, crown, fabric). Deliberately NOT flattened
 *  into one bag — the agent must know which choices a customer can actually make. */
export interface WsOptionSpace {
  /** The sub-brand this item is sold under, as the platform states it — a
   *  multi-brand house sells several. Authoritative, so brand codes never have
   *  to be guessed from trademarked product names. */
  brand?: string;
  defining: Record<string, { value: string; swatchImage?: string }[]>;
  descriptive: Record<string, string>;
  /** Cross-sell / accessory links the platform already curates. */
  merchandising: { type?: string; sku?: string; name?: string }[];
  /** Alternate-angle renders (the assets the 3D viewer uses). */
  angleImages: string[];
  variantCount?: number;
}

/** Fetch the option space for one product by its platform id. Read-only, and
 *  returns null rather than throwing so a bulk pass degrades per-item. */
export async function fetchOptionSpace(cfg: WsConfig, productId: string): Promise<WsOptionSpace | null> {
  const url = `${cfg.base}/wcs/resources/store/${cfg.storeId}/productview/byId/${productId}?catalogId=${cfg.catalogId}&langId=-1&profileName=IBM_Store_ProductView_Details`;
  let ce: any;
  try {
    const d = await getJson(url);
    ce = (d.CatalogEntryView || d.catalogEntryView || [])[0];
  } catch { return null; }
  if (!ce) return null;

  const out: WsOptionSpace = { defining: {}, descriptive: {}, merchandising: [], angleImages: [] };
  if (ce.manufacturer) out.brand = String(ce.manufacturer).trim();

  for (const a of (ce.Attributes || []) as any[]) {
    const label = String(a.name || a.identifier || '').trim();
    if (!label) continue;
    const values = ((a.Values || []) as any[]).map((v) => {
      const ext = (v.extendedValue || []) as any[];
      // Swatch art lives in an extendedValue keyed Image1Path — the visual the
      // customer actually picks from, so keep it alongside the value.
      const img = ext.find((e) => /Image1Path/i.test(String(e.key)))?.value;
      return { value: String(v.values || v.identifier || '').trim(), swatchImage: img ? String(img) : undefined };
    }).filter((v) => v.value);
    if (!values.length) continue;
    if (String(a.usage).toLowerCase() === 'defining') out.defining[label] = values;
    else out.descriptive[label] = values.map((v) => v.value).join(', ').slice(0, 300);
  }

  for (const m of (ce.MerchandisingAssociations || []) as any[]) {
    out.merchandising.push({
      type: m.associationType ? String(m.associationType) : undefined,
      sku: m.partNumber ? String(m.partNumber) : undefined,
      name: m.name ? String(m.name) : undefined,
    });
  }

  for (const at of (ce.Attachments || []) as any[]) {
    if (!/ANGLEIMAGES/i.test(String(at.usage || ''))) continue;
    const path = at.attachmentAssetPathRaw || at.attachmentAssetPath || at.path || '';
    if (!path) continue;
    const abs = String(path).startsWith('http') ? String(path) : `${cfg.base}/${String(path).replace(/^\//, '')}`;
    if (!out.angleImages.includes(abs)) out.angleImages.push(abs);
  }

  if (ce.numberOfSKUs) out.variantCount = Number(ce.numberOfSKUs) || undefined;
  return out;
}

async function enrichDetail(cfg: WsConfig, p: WsProduct): Promise<void> {
  const url = `${cfg.base}/wcs/resources/store/${cfg.storeId}/productview/byId/${p.productId}?catalogId=${cfg.catalogId}&langId=-1&profileName=IBM_Store_ProductView_Details`;
  let ce: any;
  try {
    const d = await getJson(url);
    ce = (d.CatalogEntryView || d.catalogEntryView || [])[0];
  } catch { return; }
  if (!ce) return;

  if (ce.manufacturer) p.manufacturer = String(ce.manufacturer);

  const options: Record<string, string[]> = {};
  const specs: Record<string, string> = {};
  for (const a of (ce.Attributes || []) as any[]) {
    const label = String(a.name || a.identifier || '').trim();
    if (!label) continue;
    const vals = ((a.Values || []) as any[]).map((v) => String(v.values || v.identifier || '').trim()).filter(Boolean);
    if (!vals.length) continue;
    if (String(a.usage).toLowerCase() === 'defining') options[label] = Array.from(new Set(vals)).slice(0, 80);
    else specs[label] = Array.from(new Set(vals)).join(', ').slice(0, 300);
  }
  if (Object.keys(options).length) p.options = options;
  if (Object.keys(specs).length) p.specs = specs;

  const variants: { sku?: string; attrs?: Record<string, string> }[] = [];
  for (const s of (ce.SKUs || []) as any[]) {
    if (variants.length >= 60) break; // cap to keep the doc bounded (count kept in specs)
    const attrs: Record<string, string> = {};
    for (const a of (s.Attributes || []) as any[]) {
      const label = String(a.name || a.identifier || '').trim();
      const val = ((a.Values || [])[0]?.values) || ((a.Values || [])[0]?.identifier);
      if (label && val) attrs[label] = String(val);
    }
    // Variant SKUs use partNumber when present, else the internal SKUUniqueID.
    const vsku = s.partNumber || s.SKUUniqueID;
    variants.push({ sku: vsku ? String(vsku) : undefined, attrs: Object.keys(attrs).length ? attrs : undefined });
  }
  if (variants.length) p.variants = variants;
  if (ce.numberOfSKUs) specs['Variant count'] = String(ce.numberOfSKUs);

  // Price fallback: sublimated items have no Offer price but do carry MSRP.
  if (p.price == null) {
    const msrp = specs['MSRP_USD'] || specs['MSRP'] || '';
    const v = parseFloat(String(msrp).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(v) && v > 0) { p.price = v; p.currency = cfg.currency || 'USD'; }
  }

  const docs: { title: string; url: string; kind?: string }[] = [];
  for (const at of (ce.Attachments || []) as any[]) {
    const path = at.attachmentAssetPathRaw || at.path || at.attachmentRelativePath || '';
    const usage = String(at.usage || '');
    if (!path || /IMAGE|THUMBNAIL/i.test(usage)) continue; // skip image attachments (already have images)
    const abs = String(path).startsWith('http') ? String(path) : `${cfg.base}/${String(path).replace(/^\//, '')}`;
    docs.push({ title: String(at.name || usage || 'document'), url: abs, kind: /\.pdf/i.test(abs) ? 'pdf' : 'attachment' });
  }
  if (docs.length) p.documents = docs;
}

/** Yield every product across all categories, deduped by SKU/productId, up to `cap`. */
export async function* iterateProducts(cfg: WsConfig, cap: number, log?: (m: string) => void): AsyncGenerator<WsProduct> {
  const cats = cfg.categoryIds?.length ? cfg.categoryIds : await enumerateCategories(cfg, log);
  const seen = new Set<string>();
  let count = 0;
  for (const catId of cats) {
    let page = 1;
    // Guard: a category is capped at ~40 pages (2000 products) to avoid loops.
    for (let guard = 0; guard < 40; guard++) {
      let data: any;
      // profileName=…_Details makes the list include Offer prices (the default
      // summary profile omits them).
      const url = `${cfg.base}/wcs/resources/store/${cfg.storeId}/productview/byCategory/${catId}?catalogId=${cfg.catalogId}&pageNumber=${page}&pageSize=${PAGE_SIZE}&langId=-1&profileName=IBM_Store_CatalogEntryList_Details`;
      try { data = await getJson(url); } catch (e) { log?.(`category ${catId} page ${page} failed: ${(e as Error).message}`); break; }
      const items: any[] = data.CatalogEntryView || data.catalogEntryView || [];
      if (items.length === 0) break;
      for (const it of items) {
        const key = String(it.partNumber || it.uniqueID || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const product = mapProduct(cfg, it);
        await enrichDetail(cfg, product); // full attributes / variants / docs
        yield product;
        if (++count >= cap) return;
      }
      if (data.recordSetComplete === true || data.recordSetComplete === 'true') break;
      page++;
    }
  }
  log?.(`iterated ${count} unique products across ${cats.length} categories`);
}

/** Compose an embeddable text block from a WebSphere product (incl. rich detail). */
export function composeWsContent(p: WsProduct): string {
  const parts = [`# ${p.title}`];
  if (p.manufacturer) parts.push(`Brand: ${p.manufacturer}`);
  if (p.sku) parts.push(`SKU: ${p.sku}`);
  if (p.price != null) parts.push(`Price: ${p.currency} ${p.price}`);
  if (p.shortDescription) parts.push(`\n${p.shortDescription}`);
  if (p.longDescription && p.longDescription !== p.shortDescription) parts.push(`\n${p.longDescription}`);
  if (p.options && Object.keys(p.options).length) {
    parts.push(`\nOptions:\n${Object.entries(p.options).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}`);
  }
  if (p.specs && Object.keys(p.specs).length) {
    parts.push(`\nDetails:\n${Object.entries(p.specs).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }
  if (p.variants && p.variants.length) {
    parts.push(`\nVariants: ${p.variants.length} (${p.variants.filter((v) => v.sku).map((v) => v.sku).slice(0, 20).join(', ')})`);
  }
  if (p.documents && p.documents.length) {
    parts.push(`\nDocuments:\n${p.documents.map((d) => `- [${d.kind}] ${d.title}: ${d.url}`).join('\n')}`);
  }
  return parts.join('\n').slice(0, 32000);
}
