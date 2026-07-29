/**
 * Product populators — one concern each, ordered, composable.
 *
 * Replaces the single procedural mapping function. Each populator can be tested
 * in isolation, reordered, or swapped per project without touching the others.
 *
 * SOURCE = a flat feed row (CSV column map). TARGET = the canonical product.
 */
import { Populator, ConversionContext } from '../ports';

export type FeedRow = Record<string, string>;

export interface ProductVariant {
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
  stock?: number;
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
  variants: ProductVariant[];
  variantCount: number;
  totalStock?: number;
}

/* ─────────────────────────── shared helpers ─────────────────────────── */
export const num = (v?: string): number | undefined => {
  if (!v) return undefined;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
export const clean = (v?: string) => (v || '').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const pushUniq = (arr: string[], v?: string) => { const s = (v || '').trim(); if (s && !arr.includes(s)) arr.push(s); };
const isCad = (ctx?: ConversionContext) => (ctx?.currency || 'USD').toUpperCase() === 'CAD';

/** Base identity/descriptive fields. Runs first so later populators can rely on them. */
export class IdentityPopulator implements Populator<FeedRow, CanonicalProduct> {
  readonly id = 'identity';
  readonly order = 10;
  populate(row: FeedRow, t: CanonicalProduct, ctx?: ConversionContext): void {
    t.name ||= clean(row.Item_Name) || t.parentSku;
    t.brandCode ||= clean(row.Brand) || undefined;
    t.division ||= clean(row.Division) || undefined;
    t.description ||= clean(row.Item_Description) || undefined;
    t.category ||= clean(row.Category) || undefined;
    t.features ||= clean(row.Features) || undefined;
    t.countryOfOrigin ||= clean(row.Country_Of_Origin) || undefined;
    t.launchDate ||= clean(row.Launch_Date) || undefined;
    t.ribbon ||= clean(row.Ribbon) || undefined;
    if (ctx?.flags?.sublimation) t.isSublimation = true;
  }
}

/** Parent-level media assets, de-duplicated across rows. */
export class ImagePopulator implements Populator<FeedRow, CanonicalProduct> {
  readonly id = 'images';
  readonly order = 20;
  populate(row: FeedRow, t: CanonicalProduct): void {
    pushUniq(t.images, clean(row.Main_Image_URL));
    pushUniq(t.images, clean(row.Other_Image_URL));
    pushUniq(t.swatchImages, clean(row.Swatch_Image_URL));
    pushUniq(t.sizeChartImages, clean(row.Size_Chart_Image_URL));
    pushUniq(t.videos, clean(row.ProductVideoUrl));
  }
}

/** Colour + size vocabularies (hex is what powers colour matching). */
export class ColourSizePopulator implements Populator<FeedRow, CanonicalProduct> {
  readonly id = 'colour-size';
  readonly order = 30;
  populate(row: FeedRow, t: CanonicalProduct): void {
    const color = clean(row.Color), hex = clean(row.Color_Hex_Value), size = clean(row.Size);
    if (color && !t.colors.some((c) => c.name === color)) t.colors.push({ name: color, hex: hex || undefined });
    if (size && !t.sizes.includes(size)) t.sizes.push(size);
  }
}

/** Price books — USD carries cost; CAD is an additive second book. */
export class PricePopulator implements Populator<FeedRow, CanonicalProduct> {
  readonly id = 'price';
  readonly order = 40;
  populate(row: FeedRow, t: CanonicalProduct, ctx?: ConversionContext): void {
    const msrp = num(row.MSRP);
    if (msrp == null) return;
    if (isCad(ctx)) {
      t.priceCAD = t.priceCAD
        ? { min: Math.min(t.priceCAD.min, msrp), max: Math.max(t.priceCAD.max, msrp) }
        : { min: msrp, max: msrp };
    } else {
      const cost = num(row.Cost);
      t.priceUSD = t.priceUSD
        ? { min: Math.min(t.priceUSD.min, msrp), max: Math.max(t.priceUSD.max, msrp), cost: t.priceUSD.cost ?? cost }
        : { min: msrp, max: msrp, cost };
    }
  }
}

/** Per-SKU variants. USD pass creates them; CAD pass only adds CAD pricing. */
export class VariantPopulator implements Populator<FeedRow, CanonicalProduct> {
  readonly id = 'variants';
  readonly order = 50;
  populate(row: FeedRow, t: CanonicalProduct, ctx?: ConversionContext): void {
    const itemSku = clean(row.Item_SKU);
    if (!itemSku) return;
    const msrp = num(row.MSRP);
    if (isCad(ctx)) {
      const v = t.variants.find((x) => x.itemSku === itemSku);
      if (v && msrp != null) v.msrpCAD = msrp;
      return;
    }
    if (t.variants.some((v) => v.itemSku === itemSku)) return;
    t.variants.push({
      itemSku,
      color: clean(row.Color) || undefined,
      colorHex: clean(row.Color_Hex_Value) || undefined,
      size: clean(row.Size) || undefined,
      upc: clean(row.UPC_Code) || undefined,
      gtin: clean(row.GTIN) || undefined,
      msrpUSD: msrp,
      costUSD: num(row.Cost),
      weight: clean(row.Weight) || undefined,
      casePack: clean(row.Case_Pack_Qty) || undefined,
      status: clean(row.Status) || undefined,
      mainImage: clean(row.Main_Image_URL) || undefined,
    });
  }
}

/** The default ordered set for a standard product feed. */
export const defaultProductPopulators = (): Populator<FeedRow, CanonicalProduct>[] => [
  new IdentityPopulator(),
  new ImagePopulator(),
  new ColourSizePopulator(),
  new PricePopulator(),
  new VariantPopulator(),
];
