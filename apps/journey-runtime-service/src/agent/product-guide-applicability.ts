import type { ProductGuideRecord } from './product-guides';

/** An attachment/index link is not proof that another model's instructions apply.
 * Only an existing catalogue identity can establish a conflicting file reference. */
export async function applicableProductGuides(product: any, records: ProductGuideRecord[], bySku: (sku: string) => Promise<any>) {
  const own = new Set([product.sku, product.parentSku].filter(Boolean).map(String));
  const accepted: ProductGuideRecord[] = [];
  const rejected: Array<{ guideId: string; title: string; url?: string; reason: string }> = [];
  const identities = new Map<string, Promise<any>>();
  for (const guide of records) {
    let namedSku: string | undefined;
    try {
      const filename = decodeURIComponent(new URL(guide.url || '').pathname.split('/').at(-1) || '');
      namedSku = /^([A-Za-z0-9][A-Za-z0-9-]{2,49})_/.exec(filename)?.[1];
      if (namedSku && !/\d/.test(namedSku)) namedSku = undefined;
    } catch { /* A missing/opaque file name proves no mismatch. */ }
    if (namedSku && !own.has(namedSku) && ![...own].some(sku => new RegExp(`(?:^|[^A-Za-z0-9])${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9])`, 'i').test(guide.text))) {
      // Bound extra exact-catalogue lookups; on failure withhold this ambiguous file.
      let referenced: any;
      try {
        if (!identities.has(namedSku)) {
          if (identities.size >= 8) throw new Error('Attachment identity lookup bound reached.');
          identities.set(namedSku, bySku(namedSku));
        }
        referenced = await identities.get(namedSku);
      } catch { rejected.push({ guideId: guide.docId, title: guide.title, url: guide.url, reason: 'attachment_applicability_unconfirmed' }); continue; }
      if (referenced && String(referenced.sku) === namedSku) {
        rejected.push({ guideId: guide.docId, title: guide.title, url: guide.url, reason: 'attachment_names_another_catalogued_product' }); continue;
      }
    }
    accepted.push(guide);
  }
  return { accepted, rejected };
}
