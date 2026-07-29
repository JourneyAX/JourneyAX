/**
 * CSV product-feed connector (Momentec/Augusta standard data feeds).
 *
 * The authoritative catalogue source: official CSV feeds carrying every SKU with
 * price, cost, colour+hex, size, UPC/GTIN, images, size-chart and video URLs —
 * plus a parallel CAD feed and a live inventory feed.
 *
 * It produces ONE canonical product per `Parent_SKU`, with:
 *   - dual price books (USD + CAD)
 *   - every variant (colour × size) as structured, exactly-queryable data
 *   - de-duplicated image/video/size-chart assets
 *   - live stock per variant, joined from the inventory feed
 *
 * Design note: variants stay STRUCTURED (exact lookup: price, stock, size
 * availability). Only the parent-level narrative gets embedded for vector search.
 * Facts are queried; understanding is retrieved.
 */
import { parse } from 'csv-parse';
import { createReadStream, existsSync, mkdirSync, statSync } from 'fs';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';

export interface FeedUrls {
  productUS?: string;
  sublimationUS?: string;
  productCAD?: string;
  sublimationCAD?: string;
  inventory?: string;
}

export interface Variant {
  itemSku: string;
  color?: string;
  colorHex?: string;
  size?: string;
  upc?: string;
  gtin?: string;
  msrpUSD?: number;
  costUSD?: number;
  msrpCAD?: number;
  weight?: string;
  casePack?: string;
  status?: string;
  mainImage?: string;
  stock?: number;               // joined from inventory feed
}

export interface CanonicalProduct {
  parentSku: string;
  name: string;
  brandCode?: string;
  division?: string;
  description?: string;
  category?: string;
  features?: string;
  countryOfOrigin?: string;
  launchDate?: string;
  ribbon?: string;
  isSublimation: boolean;
  colors: { name: string; hex?: string }[];
  sizes: string[];
  images: string[];
  swatchImages: string[];
  sizeChartImages: string[];
  videos: string[];
  priceUSD?: { min: number; max: number; cost?: number };
  priceCAD?: { min: number; max: number };
  variants: Variant[];
  variantCount: number;
  totalStock?: number;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** Download a feed to a local cache (resumable across runs); returns the path. */
export async function cacheFeed(url: string, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, path.basename(new URL(url).pathname));
  // Re-use a cached file if it looks complete (non-trivial size).
  if (existsSync(file) && statSync(file).size > 1024) return file;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`feed download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
  return file;
}

/** Stream a CSV, invoking `onRow` per record (keeps 40MB+ feeds off the heap). */
export async function streamCsv(file: string, onRow: (row: Record<string, string>) => void): Promise<number> {
  let n = 0;
  const parser = createReadStream(file).pipe(parse({ columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true }));
  for await (const row of parser) { onRow(row as Record<string, string>); n++; }
  return n;
}

const num = (v?: string): number | undefined => {
  if (!v) return undefined;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const clean = (v?: string) => (v || '').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const pushUniq = (arr: string[], v?: string) => { const s = (v || '').trim(); if (s && !arr.includes(s)) arr.push(s); };

/** Fold one CSV row into the canonical product map. */
function foldRow(map: Map<string, CanonicalProduct>, row: Record<string, string>, opts: { currency: 'USD' | 'CAD'; sublimation: boolean }) {
  const parent = clean(row.Parent_SKU);
  if (!parent) return;
  let p = map.get(parent);
  if (!p) {
    p = {
      parentSku: parent,
      name: clean(row.Item_Name) || parent,
      brandCode: clean(row.Brand) || undefined,
      division: clean(row.Division) || undefined,
      description: clean(row.Item_Description) || undefined,
      category: clean(row.Category) || undefined,
      features: clean(row.Features) || undefined,
      countryOfOrigin: clean(row.Country_Of_Origin) || undefined,
      launchDate: clean(row.Launch_Date) || undefined,
      ribbon: clean(row.Ribbon) || undefined,
      isSublimation: opts.sublimation,
      colors: [], sizes: [], images: [], swatchImages: [], sizeChartImages: [], videos: [],
      variants: [], variantCount: 0,
    };
    map.set(parent, p);
  }
  if (opts.sublimation) p.isSublimation = true;

  // Assets (parent-level, de-duplicated)
  pushUniq(p.images, clean(row.Main_Image_URL));
  pushUniq(p.images, clean(row.Other_Image_URL));
  pushUniq(p.swatchImages, clean(row.Swatch_Image_URL));
  pushUniq(p.sizeChartImages, clean(row.Size_Chart_Image_URL));
  pushUniq(p.videos, clean(row.ProductVideoUrl));

  // Colour / size vocabularies
  const color = clean(row.Color), hex = clean(row.Color_Hex_Value), size = clean(row.Size);
  if (color && !p.colors.some((c) => c.name === color)) p.colors.push({ name: color, hex: hex || undefined });
  if (size && !p.sizes.includes(size)) p.sizes.push(size);

  const msrp = num(row.MSRP), cost = num(row.Cost);
  const itemSku = clean(row.Item_SKU);

  // Variants are tracked from the USD feed; the CAD feed only adds CAD prices.
  if (opts.currency === 'USD') {
    if (itemSku && !p.variants.some((v) => v.itemSku === itemSku)) {
      p.variants.push({
        itemSku, color: color || undefined, colorHex: hex || undefined, size: size || undefined,
        upc: clean(row.UPC_Code) || undefined, gtin: clean(row.GTIN) || undefined,
        msrpUSD: msrp, costUSD: cost, weight: clean(row.Weight) || undefined,
        casePack: clean(row.Case_Pack_Qty) || undefined, status: clean(row.Status) || undefined,
        mainImage: clean(row.Main_Image_URL) || undefined,
      });
    }
    if (msrp != null) {
      p.priceUSD = p.priceUSD
        ? { min: Math.min(p.priceUSD.min, msrp), max: Math.max(p.priceUSD.max, msrp), cost: p.priceUSD.cost ?? cost }
        : { min: msrp, max: msrp, cost };
    }
  } else {
    if (msrp != null) {
      p.priceCAD = p.priceCAD ? { min: Math.min(p.priceCAD.min, msrp), max: Math.max(p.priceCAD.max, msrp) } : { min: msrp, max: msrp };
    }
    const v = itemSku ? p.variants.find((x) => x.itemSku === itemSku) : undefined;
    if (v && msrp != null) v.msrpCAD = msrp;
  }
}

/** Build the full canonical catalogue from the configured feeds. */
export async function buildCatalogue(
  feeds: FeedUrls,
  cacheDir: string,
  log: (m: string) => void = () => {},
): Promise<Map<string, CanonicalProduct>> {
  const map = new Map<string, CanonicalProduct>();

  const passes: { url?: string; currency: 'USD' | 'CAD'; sublimation: boolean; label: string }[] = [
    { url: feeds.productUS, currency: 'USD', sublimation: false, label: 'US product' },
    { url: feeds.sublimationUS, currency: 'USD', sublimation: true, label: 'US sublimation' },
    { url: feeds.productCAD, currency: 'CAD', sublimation: false, label: 'CAD product' },
    { url: feeds.sublimationCAD, currency: 'CAD', sublimation: true, label: 'CAD sublimation' },
  ];
  for (const pass of passes) {
    if (!pass.url) continue;
    const file = await cacheFeed(pass.url, cacheDir);
    const n = await streamCsv(file, (row) => foldRow(map, row, { currency: pass.currency, sublimation: pass.sublimation }));
    log(`${pass.label}: ${n.toLocaleString()} rows → ${map.size.toLocaleString()} products`);
  }

  // Live inventory join (Item_SKU → qty), summed across warehouses.
  if (feeds.inventory) {
    const file = await cacheFeed(feeds.inventory, cacheDir);
    const stock = new Map<string, number>();
    const n = await streamCsv(file, (row) => {
      const sku = clean(row.Item_SKU); const q = num(row.Item_Qty);
      if (sku && q != null) stock.set(sku, (stock.get(sku) || 0) + q);
    });
    let joined = 0;
    for (const p of map.values()) {
      let total = 0;
      for (const v of p.variants) {
        const q = stock.get(v.itemSku);
        if (q != null) { v.stock = q; total += q; joined++; }
      }
      if (total > 0) p.totalStock = total;
    }
    log(`inventory: ${n.toLocaleString()} rows → ${joined.toLocaleString()} variants stocked`);
  }

  for (const p of map.values()) p.variantCount = p.variants.length;
  return map;
}
