/**
 * FeedRow → CanonicalProduct converter, and the reverse direction.
 *
 * Forward: many feed rows fold into one canonical product (`convertInto`).
 * Reverse: canonical → an external DTO, which is what makes write-back possible
 * (pushing catalogue/inventory back to a PIM or partner feed). Having both
 * directions is the point of the converter pattern — mapping is never one-way.
 */
import { AbstractConverter } from './base.converter';
import { ConversionContext, Converter } from '../ports';
import {
  CanonicalProduct, FeedRow, clean, defaultProductPopulators,
} from '../populators/product.populators';

export class FeedRowToProductConverter extends AbstractConverter<FeedRow, CanonicalProduct> {
  readonly id = 'feed-row->product';

  constructor() {
    super(defaultProductPopulators());
  }

  createTarget(row: FeedRow, ctx?: ConversionContext): CanonicalProduct {
    return {
      parentSku: clean(row.Parent_SKU),
      name: clean(row.Item_Name) || clean(row.Parent_SKU),
      isSublimation: Boolean(ctx?.flags?.sublimation),
      colors: [], sizes: [], images: [], swatchImages: [], sizeChartImages: [], videos: [],
      variants: [], variantCount: 0,
    };
  }
}

/** Outbound DTO for partner/PIM export — the target→source direction. */
export interface ProductExportDto {
  sku: string;
  title: string;
  description?: string;
  category?: string;
  brand?: string;
  currency: string;
  price?: number;
  cost?: number;
  inStock: boolean;
  stockQty?: number;
  colours: { name: string; hex?: string }[];
  sizes: string[];
  media: { images: string[]; videos: string[]; sizeCharts: string[] };
  variantSkus: string[];
}

/** Canonical → export DTO (reverse conversion). */
export class ProductToExportDtoConverter implements Converter<CanonicalProduct, ProductExportDto> {
  readonly id = 'product->export-dto';

  createTarget(p: CanonicalProduct, ctx?: ConversionContext): ProductExportDto {
    const cad = (ctx?.currency || 'USD').toUpperCase() === 'CAD';
    const book = cad ? p.priceCAD : p.priceUSD;
    return {
      sku: p.parentSku,
      title: p.name,
      description: p.description,
      category: p.category,
      brand: p.brandCode,
      currency: cad ? 'CAD' : 'USD',
      price: book?.min,
      cost: cad ? undefined : p.priceUSD?.cost,
      inStock: (p.totalStock ?? 0) > 0,
      stockQty: p.totalStock,
      colours: p.colors,
      sizes: p.sizes,
      media: { images: p.images, videos: p.videos, sizeCharts: p.sizeChartImages },
      variantSkus: p.variants.map((v) => v.itemSku),
    };
  }

  async convert(p: CanonicalProduct, ctx?: ConversionContext): Promise<ProductExportDto> {
    return this.createTarget(p, ctx);
  }

  async convertInto(p: CanonicalProduct, target: ProductExportDto, ctx?: ConversionContext): Promise<ProductExportDto> {
    return Object.assign(target, this.createTarget(p, ctx));
  }
}
