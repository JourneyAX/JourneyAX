import { BusinessPackLoader, buildCatalogueIdentityFilter, normalizeCatalogProduct, readPath, resolveCatalogMapping } from '@journeyax/business-pack';
import type { Quote } from './quote.types';

export interface CheckoutCatalogueAuthority {
  validate(scope: { tenantId: string; environmentId: string; quote: Quote }, db: any): Promise<void>;
}

/** Refresh identity and lifecycle only; the immutable quote retains its agreed monetary amounts. */
export class PublishedCheckoutCatalogueAuthority implements CheckoutCatalogueAuthority {
  private loader?: BusinessPackLoader;
  async validate({ tenantId, environmentId, quote }: { tenantId: string; environmentId: string; quote: Quote }, db: any): Promise<void> {
    if (!quote.release || !quote.lines?.length || quote.tenantId !== tenantId || quote.environmentId !== environmentId) throw new Error('A scoped published quote is required.');
    this.loader ??= new BusinessPackLoader({ db });
    const pack = await this.loader.loadPinned(tenantId, environmentId as any, quote.release.version, quote.release.checksum);
    const mapping = resolveCatalogMapping(pack.catalogMapping), skus = quote.lines.map(line => line.sku);
    const cap = skus.length * 4 + 1;
    const rows = await db.collection('products').find(buildCatalogueIdentityFilter(mapping, tenantId, skus)).limit(cap).toArray();
    if (rows.length >= cap) throw new Error('The source identity lookup exceeded its safe bound.');
    for (const sku of skus) {
      const candidates = rows.filter((row: any) => {
        const owners = mapping.tenantFields.map(path => readPath(row, path)).filter(value => value != null);
        return owners.length && owners.every(owner => owner === tenantId) && mapping.identifierPaths.some(path => String(readPath(row, path) ?? '') === sku);
      });
      if (candidates.length !== 1) throw new Error('The selected catalogue identity is unavailable or ambiguous.');
      const [candidate] = candidates;
      const product = normalizeCatalogProduct(candidate, mapping, { title: '', category: '' });
      if (product.sku !== sku || !product.integrity.identityConsistent || product.availability === 'excluded') throw new Error('The selected catalogue source record requires review.');
    }
  }
}
