/**
 * The product detail card's state: what the tapped tile already knew, completed with the catalogue's own record of the product.
 *
 * The server's record wins wherever it has an answer; the tile fills the gaps (and is the whole answer when the catalogue cannot
 * be reached). Nothing is composed here: lists are shaped for the card and sections the record has nothing for are flagged off,
 * so the card shows exactly what is known and no empty headings.
 */
import { usableImage } from './mappers';

export interface ServerProductDetail {
  integrity?: { identityConsistent: boolean };
  sku: string;
  title: string;
  brand?: string;
  category?: string;
  description?: string;
  imageUrl?: string | null;
  price?: number | null;
  currency?: string;
  features?: string[];
  specs?: Array<{ label: string; value: string }>;
  documents?: Array<{ title: string; url: string; kind?: string }>;
  suggested?: Array<{ sku: string; title: string; price?: number | null; currency?: string; imageUrl?: string | null }>;
  related?: Array<{ sku: string; title: string; price?: number | null; currency?: string; imageUrl?: string | null }>;
  availability?: { label: string; inStock?: boolean; branchChecked?: boolean; branchesWithStock: number; branchCount: number };
  productUrl?: string;
  rating?: { value: number; count?: number };
}

/** The tile data a tap starts from (a RecommendedProduct or a card item). */
export interface TileProduct {
  sku: string;
  name?: string;
  title?: string;
  description?: string;
  narrative?: string;
  imageUrl?: string | null;
  image?: string | null;
  price?: number | null;
  category?: string;
  specs?: Record<string, unknown>;
  specList?: Array<{ label: string; value: string }>;
  featuresList?: string[];
  documents?: Array<{ title: string; url: string }>;
}

/** Asks the storefront's server for the catalogue's record of one product; null when it cannot answer. */
export async function fetchProductDetail(sku: string, projectId?: string, signal?: AbortSignal): Promise<ServerProductDetail | null> {
  try {
    const res = await fetch(`/api/products/detail?sku=${encodeURIComponent(sku)}`, {
      headers: projectId ? { 'X-Tenant-ID': projectId } : {},
      signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' && body.sku ? (body as ServerProductDetail) : null;
  } catch {
    return null;
  }
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export function buildDetailProduct(tile: TileProduct | undefined, detail: ServerProductDetail | null, sku: string): Record<string, unknown> {
  if (detail?.integrity?.identityConsistent === false) return { sku, title: `SKU ${sku}`, price: null, description: 'The catalogue source record needs review before these product details can be confirmed.', specs: {}, specList: [], hasSpecs: false, documents: [], hasDocuments: false, hasFeatures: false, hasSuggested: false, hasRelated: false, stockOk: false, stockWarn: false, hasProductUrl: false, hasRating: false };
  const tileSpecs = list<{ label: string; value: string }>(tile?.specList).length > 0
    ? list<{ label: string; value: string }>(tile?.specList)
    : Object.entries(tile?.specs || {}).map(([label, value]) => ({ label, value: String(value) }));
  const specList = detail ? list<{ label: string; value: string }>(detail.specs) : tileSpecs;
  const features = detail ? list<string>(detail.features) : list<string>(tile?.featuresList);
  const title = detail?.title || tile?.name || tile?.title;
  // Each document also carries the line the "Explain it to me" button sends, so the consultant reads that document to the customer.
  const documents = (detail ? list<{ title: string; url: string }>(detail.documents) : list<{ title: string; url: string }>(tile?.documents))
    .map((document) => ({ ...document, ask: title ? `Explain the ${document.title} for ${title} (SKU ${sku})` : `Explain the ${document.title} (SKU ${sku})` }));
  const withPhoto = (items: unknown) => list<NonNullable<ServerProductDetail['related']>[number]>(items).map((r) => ({ ...r, imageUrl: usableImage(r.imageUrl) }));
  const suggested = withPhoto(detail?.suggested);
  const related = withPhoto(detail?.related);
  const availability = detail?.availability;

  return {
    sku,
    title,
    brand: detail?.brand,
    category: detail?.category || tile?.category,
    description: detail?.description || tile?.description || tile?.narrative,
    imageUrl: usableImage(detail?.imageUrl) || usableImage(tile?.imageUrl) || tile?.image || null,
    price: detail ? detail.price ?? null : tile?.price ?? null,
    currency: detail?.currency || (tile as { currency?: string } | undefined)?.currency,
    specs: Object.fromEntries(specList.map(entry => [entry.label, entry.value])),
    specList,
    hasSpecs: specList.length > 0,
    // A markdown bullet list, so the card renders it with the same block it uses for any text.
    featuresText: features.map((f) => `- ${f}`).join('\n'),
    hasFeatures: features.length > 0,
    documents,
    hasDocuments: documents.length > 0,
    suggested,
    hasSuggested: suggested.length > 0,
    related,
    hasRelated: related.length > 0,
    stockLabel: availability?.branchChecked === true ? availability.label : availability && Number.isFinite(availability.branchesWithStock) && Number.isFinite(availability.branchCount) ? `Catalogue lists ${availability.branchesWithStock} of ${availability.branchCount} branches; current stock not checked` : undefined,
    stockOk: availability?.branchChecked === true && availability.inStock === true,
    stockWarn: availability?.branchChecked === true && availability.inStock === false,
    productUrl: detail?.productUrl,
    hasProductUrl: Boolean(detail?.productUrl),
    rating: detail?.rating?.value,
    ratingCount: detail?.rating?.count,
    hasRating: typeof detail?.rating?.value === 'number',
  };
}
