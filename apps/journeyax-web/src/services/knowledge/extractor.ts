/**
 * Generic PDP extractor (Playwright). Runs entirely in the page context and is
 * BRAND-AGNOSTIC — it harvests whatever a product/detail page exposes through
 * standards (schema.org JSON-LD, OpenGraph, microdata) plus resilient DOM
 * heuristics, so the same code captures a bathroom brand, a sportswear brand or
 * any other e-commerce catalogue with no per-site rules.
 *
 * Captured (best-effort, only what the page actually shows):
 *   title, brand, sku, category, collection
 *   price / priceMin / priceMax / currency, availability, inventory
 *   images (og + JSON-LD + gallery, incl. lazy data-src/srcset, absolute + deduped)
 *   options (Size, Colour, …), variants (sku/finish/availability)
 *   description (long) + shortDescription
 *   specs (spec tables + definition lists + "key: value" lines)
 *   documents (PDFs / guides / manuals / size-guide / how-to / where-to-buy links)
 *   rating + reviewCount
 *   bodyText (full readable text, for embedding)
 */
import type { Page } from 'playwright';

export interface ExtractedPage {
  title: string;
  brand?: string;
  sku?: string;
  category?: string;
  collection?: string;
  price?: number;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  availability?: string;
  inventory?: number;
  images: string[];
  options: Record<string, string[]>;
  variants: { sku: string; finish?: string; availability?: string }[];
  description?: string;
  shortDescription?: string;
  specs: Record<string, string>;
  documents: { title: string; url: string; kind?: string }[];
  rating?: number;
  reviewCount?: number;
  isProduct: boolean;
  bodyText: string;
}

/** Extract a rich structured record from the current page. */
export async function extractPage(page: Page, pageUrl: string): Promise<ExtractedPage> {
  const raw = await page.evaluate((pageUrl: string) => {
    const abs = (u?: string | null): string | undefined => {
      if (!u) return undefined;
      try { return new URL(u, pageUrl).href; } catch { return undefined; }
    };
    const clean = (s?: string | null) => (s || '').replace(/\s+/g, ' ').trim();
    const num = (v: any): number | undefined => {
      if (v == null) return undefined;
      const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    };

    // ── JSON-LD: collect every node (flatten @graph) ─────────────────────
    const ld: any[] = [];
    for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const parsed = JSON.parse(el.textContent || '');
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of arr) {
          if (node && node['@graph'] && Array.isArray(node['@graph'])) ld.push(...node['@graph']);
          else if (node) ld.push(node);
        }
      } catch { /* ignore malformed */ }
    }
    const typeOf = (n: any) => ([] as string[]).concat(n?.['@type'] || []).map((t) => String(t).toLowerCase());
    const product = ld.find((n) => typeOf(n).some((t) => t === 'product' || t.endsWith('/product')));
    const breadcrumb = ld.find((n) => typeOf(n).includes('breadcrumblist'));

    const meta = (sel: string): string | undefined =>
      clean(document.querySelector(sel)?.getAttribute('content')) || undefined;

    // ── Offers / price ───────────────────────────────────────────────────
    let price: number | undefined, priceMin: number | undefined, priceMax: number | undefined, currency: string | undefined, availability: string | undefined;
    const offers = product?.offers ? ([] as any[]).concat(product.offers) : [];
    const offerList = offers.flatMap((o: any) => (o?.['@type']?.toString().toLowerCase().includes('aggregate') ? [] : [o]));
    const agg = offers.find((o: any) => o?.['@type']?.toString().toLowerCase().includes('aggregate'));
    if (agg) {
      priceMin = num(agg.lowPrice); priceMax = num(agg.highPrice); price = priceMin;
      currency = agg.priceCurrency; availability = clean(agg.availability);
    }
    for (const o of offerList) {
      const p = num(o.price ?? o.priceSpecification?.price);
      if (p != null) { price = price ?? p; priceMin = priceMin == null ? p : Math.min(priceMin, p); priceMax = priceMax == null ? p : Math.max(priceMax, p); }
      currency = currency || o.priceCurrency || o.priceSpecification?.priceCurrency;
      availability = availability || clean(o.availability);
    }
    price = price ?? num(meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]'));
    currency = currency || meta('meta[property="product:price:currency"]') || meta('meta[property="og:price:currency"]');
    availability = (availability || meta('meta[property="product:availability"]') || '').replace(/^https?:\/\/schema\.org\//i, '');

    // Visible-price fallback (sites without JSON-LD/meta — e.g. WebSphere Commerce):
    // read currency-number text out of price-labelled elements.
    if (price == null) {
      const SYM: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
      const priceText = Array.from(document.querySelectorAll('[itemprop="price"], [class*="price" i], [class*="Price"], [id*="price" i]'))
        .map((e) => (e as HTMLElement).innerText || '').join('  ');
      const found: number[] = [];
      let sym = '';
      for (const m of priceText.matchAll(/([$€£₹])\s?(\d[\d,]*\.?\d{0,2})/g)) {
        const v = num(m[2]); if (v != null && v > 0) { found.push(v); sym = sym || m[1]; }
      }
      if (found.length) {
        priceMin = Math.min(...found); priceMax = Math.max(...found); price = priceMin;
        currency = currency || SYM[sym];
      }
    }

    // ── Images: JSON-LD + OG + gallery (lazy-aware) ──────────────────────
    // Reject chrome/locale assets (flags, sprites, UI icons, payment logos) by
    // FILENAME pattern — not by CDN path, since product photos share the CDN.
    const badImg = (u?: string) => !u ||
      /(^|\/)(flags?|sprite|icons?|placeholder|spacer|payment|loading|blank)[-_./]|\/logo\/|logo[-_.]|flag\.|_flag|1x1|\.svg($|\?)/i.test(u);
    const imgs = new Set<string>();
    for (const im of ([] as any[]).concat(product?.image || [])) {
      const u = abs(typeof im === 'string' ? im : im?.url); if (u && !badImg(u)) imgs.add(u);
    }
    for (const el of Array.from(document.querySelectorAll('meta[property="og:image"], meta[name="og:image"]'))) {
      const u = abs(el.getAttribute('content')); if (u && !badImg(u)) imgs.add(u);
    }
    for (const el of Array.from(document.querySelectorAll('img'))) {
      const img = el as HTMLImageElement;
      // Prefer explicit large sources; skip obvious icons/sprites/logos by size.
      const cand = img.getAttribute('data-zoom-image') || img.getAttribute('data-large_image') ||
        img.getAttribute('data-src') || img.getAttribute('data-original') ||
        (img.getAttribute('srcset') || '').split(',').pop()?.trim().split(' ')[0] || img.currentSrc || img.src;
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      if ((w === 0 || w >= 200) && !badImg(cand || '')) {
        const u = abs(cand); if (u) imgs.add(u);
      }
    }

    // ── Options (Size, Colour, …) + variants ─────────────────────────────
    // Ignore site chrome selectors (language / currency / country / store).
    const CHROME_OPT = /lang|currenc|country|region|locale|store|nav|sort|quantity|qty|textdir|direction/i;
    const CHROME_VAL = /dollar|euro|pound|yen|won|zloty|leu|real|rupee|english|espa|fran|deutsch|português|中文|한국/i;
    const options: Record<string, string[]> = {};
    for (const sel of Array.from(document.querySelectorAll('select'))) {
      const label = clean(sel.getAttribute('aria-label') || sel.getAttribute('name') || sel.closest('label')?.textContent || (sel.previousElementSibling?.textContent ?? ''));
      const vals = Array.from(sel.querySelectorAll('option'))
        .map((o) => clean(o.textContent)).filter((v) => v && !/^(choose|select|please|--)/i.test(v));
      if (label && vals.length && !CHROME_OPT.test(label) && !CHROME_VAL.test(vals.slice(0, 3).join(' '))) {
        options[label.slice(0, 40)] = Array.from(new Set(vals)).slice(0, 60);
      }
    }
    // Swatch-style option groups (data-option / data-attribute).
    for (const grp of Array.from(document.querySelectorAll('[data-option-name], [data-attribute-name]'))) {
      const label = clean(grp.getAttribute('data-option-name') || grp.getAttribute('data-attribute-name'));
      const vals = Array.from(grp.querySelectorAll('[data-value], [data-option-value]'))
        .map((n) => clean(n.getAttribute('data-value') || n.getAttribute('data-option-value') || n.textContent)).filter(Boolean);
      if (label && vals.length) options[label.slice(0, 40)] = Array.from(new Set(vals)).slice(0, 60);
    }
    const variants: { sku: string; finish?: string; availability?: string }[] = [];
    for (const v of ([] as any[]).concat(product?.hasVariant || product?.model || [])) {
      const sku = clean(v?.sku || v?.mpn); if (sku) variants.push({ sku, finish: clean(v?.color || v?.name) || undefined, availability: clean(v?.offers?.availability) || undefined });
    }

    // ── Specs: tables + definition lists + "key: value" lines ────────────
    const specs: Record<string, string> = {};
    for (const row of Array.from(document.querySelectorAll('table tr'))) {
      const k = clean(row.querySelector('th')?.textContent);
      const v = clean(row.querySelector('td')?.textContent);
      if (k && v && k.length < 60) specs[k] = v.slice(0, 300);
    }
    const dls = Array.from(document.querySelectorAll('dl'));
    for (const dl of dls) {
      const dts = Array.from(dl.querySelectorAll('dt')); const dds = Array.from(dl.querySelectorAll('dd'));
      dts.forEach((dt, i) => { const k = clean(dt.textContent); const v = clean(dds[i]?.textContent); if (k && v && k.length < 60) specs[k] = v.slice(0, 300); });
    }
    if (product?.additionalProperty) {
      for (const p of ([] as any[]).concat(product.additionalProperty)) {
        const k = clean(p?.name); const v = clean(p?.value); if (k && v) specs[k] = v.slice(0, 300);
      }
    }
    for (const k of ['material', 'gtin', 'gtin13', 'mpn', 'weight', 'color', 'size']) {
      if (product?.[k]) specs[k[0].toUpperCase() + k.slice(1)] = clean(String(product[k]));
    }

    // ── Documents / guides / PDFs / how-to / where-to-buy / size guide ───
    const documents: { title: string; url: string; kind?: string }[] = [];
    const seenDoc = new Set<string>();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = abs((a as HTMLAnchorElement).getAttribute('href')); if (!href) continue;
      const label = clean(a.textContent) || href.split('/').pop() || 'document';
      const hay = (href + ' ' + label).toLowerCase();
      let kind: string | undefined;
      if (/\.pdf($|\?)/.test(href)) kind = 'pdf';
      else if (/size[-\s]?(guide|chart)|fit\s?guide|measurement/.test(hay)) kind = 'size-guide';
      else if (/install|assembly|manual|how[-\s]?to|instruction|user[-\s]?guide/.test(hay)) kind = 'guide';
      else if (/spec[-\s]?sheet|datasheet|technical|cad|drawing/.test(hay)) kind = 'spec';
      else if (/where[-\s]?to[-\s]?buy|store[-\s]?locator|find[-\s]?a[-\s]?(store|dealer|retailer)/.test(hay)) kind = 'where-to-buy';
      else if (/how[-\s]?to[-\s]?buy|ordering|quote|request[-\s]?a[-\s]?quote/.test(hay)) kind = 'how-to-buy';
      else if (/warranty|guarantee/.test(hay)) kind = 'warranty';
      if (kind && !seenDoc.has(href)) { seenDoc.add(href); documents.push({ title: label.slice(0, 120), url: href, kind }); }
    }

    // ── Descriptions + reviews + category ────────────────────────────────
    const description = clean(product?.description) || undefined;
    const shortDescription = meta('meta[name="description"]') || meta('meta[property="og:description"]');
    const rating = product?.aggregateRating ? num(product.aggregateRating.ratingValue) : undefined;
    const reviewCount = product?.aggregateRating ? num(product.aggregateRating.reviewCount ?? product.aggregateRating.ratingCount) : undefined;
    let category = clean(product?.category) || undefined;
    if (!category && breadcrumb?.itemListElement) {
      const items = ([] as any[]).concat(breadcrumb.itemListElement).map((i) => clean(i?.name || i?.item?.name)).filter(Boolean);
      category = items.slice(-2, -1)[0] || items.pop();
    }

    const brand = clean(product?.brand?.name || product?.brand) || meta('meta[property="og:site_name"]') || undefined;
    const sku = clean(product?.sku || product?.mpn || product?.gtin13) || undefined;
    const title = clean(product?.name) || meta('meta[property="og:title"]') || clean(document.title);
    const isProduct = !!product || price != null || /\/product|\/p\/|productdisplay|add to (cart|bag)/i.test((pageUrl + ' ' + (document.body?.innerText || '').slice(0, 3000)));
    const bodyText = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();

    return {
      title, brand, sku, category, collection: undefined as string | undefined,
      price, priceMin, priceMax, currency, availability, inventory: undefined as number | undefined,
      images: Array.from(imgs), options, variants,
      description, shortDescription, specs, documents, rating, reviewCount, isProduct, bodyText,
    };
  }, pageUrl);

  return raw as ExtractedPage;
}

/** Compose a rich, embeddable text block from the extracted fields, so retrieval
 *  grounds on specs/variants/docs — not just the raw page dump. */
export function composeContent(x: ExtractedPage): string {
  const parts: string[] = [`# ${x.title}`];
  if (x.brand) parts.push(`Brand: ${x.brand}`);
  if (x.category) parts.push(`Category: ${x.category}`);
  if (x.sku) parts.push(`SKU: ${x.sku}`);
  if (x.price != null) parts.push(`Price: ${x.currency || ''} ${x.price}${x.priceMax && x.priceMax !== x.price ? `–${x.priceMax}` : ''}`.trim());
  if (x.availability) parts.push(`Availability: ${x.availability}`);
  if (x.shortDescription) parts.push(`\n${x.shortDescription}`);
  if (x.description && x.description !== x.shortDescription) parts.push(`\n${x.description}`);
  const optKeys = Object.keys(x.options);
  if (optKeys.length) parts.push(`\nOptions:\n${optKeys.map((k) => `- ${k}: ${x.options[k].join(', ')}`).join('\n')}`);
  const specKeys = Object.keys(x.specs);
  if (specKeys.length) parts.push(`\nSpecifications:\n${specKeys.map((k) => `- ${k}: ${x.specs[k]}`).join('\n')}`);
  if (x.documents.length) parts.push(`\nDocuments & guides:\n${x.documents.map((d) => `- [${d.kind || 'doc'}] ${d.title}: ${d.url}`).join('\n')}`);
  if (x.rating != null) parts.push(`\nRating: ${x.rating}${x.reviewCount ? ` (${x.reviewCount} reviews)` : ''}`);
  // Append the readable body last so anything the structured pass missed is still embedded.
  if (x.bodyText) parts.push(`\n---\n${x.bodyText}`);
  return parts.join('\n').slice(0, 32000);
}
