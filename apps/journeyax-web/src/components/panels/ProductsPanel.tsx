'use client';

import React, { useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import TryOn from './TryOn';
import { linkProps } from '@/lib/links';

function specStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o) return `${o.value}${o.count != null ? ` (${o.count})` : ''}`;
    try { return Object.values(o).map((x) => String(x)).join(', '); } catch { return ''; }
  }
  return String(v);
}

function formatPrice(n: number | undefined | null, currency: string): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || !/^[A-Z]{3}$/.test(currency)) return 'Price on request';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
}
function getProductName(p: any): string { return p?.name || p?.title || 'Product'; }
function getProductCategory(p: any): string { return p?.category || p?.categoryPath?.at(-1) || ''; }
function getProductDescription(p: any): string { return p?.description || p?.summary || ''; }
function getProductFeatures(p: any): string[] {
  const values = p?.features ?? p?.highlights;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').slice(0, 8) : [];
}
function getProductSpecs(p: any): Record<string, unknown> {
  return p?.specs && typeof p.specs === 'object' && !Array.isArray(p.specs) ? p.specs : {};
}
function recommendationReason(p: any): string { return typeof p?.reason === 'string' ? p.reason : ''; }
function productLink(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined; } catch { return undefined; }
}
/** Missing catalogue media is a neutral placeholder, never a substitute photograph of a different product. */
function ProductVisual({ imageUrl, name, category }: { imageUrl?: string; name: string; category?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const source = productLink(imageUrl);
  return <div className="product-card__image" style={{ minHeight: 180, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
    {source && failedUrl !== source ? <img src={source} alt={name} style={{ width: '100%', height: 180, objectFit: 'contain' }} onError={() => setFailedUrl(source)} /> : <div style={{ textAlign: 'center', color: 'var(--text-secondary, #64748b)' }}><span aria-hidden="true" style={{ fontSize: 36 }}>□</span><div>{category || 'Image unavailable'}</div></div>}
  </div>;
}

export default function ProductsPanel() {
  const cfg = useStorefrontConfig();
  const { state, dispatch, bom } = useJourney();
  const { labels } = useStorefrontConfig();

  const conf = (cfg as any).configurator || {};
  const has3D = (cfg.capabilities || []).includes('configurator') && !!conf.productType;
  const isGarment = conf.productType === 'garment' || (cfg.capabilities || []).includes('tryon');
  const isCandy = conf.productType === 'candy';
  const designVerb = conf.designVerb || (isCandy ? 'Personalize this' : 'Design this in 3D');
  const { recommendedProducts } = state;

  const [selectedAccs, setSelectedAccs] = useState<Record<string, boolean>>({});
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [detailQty, setDetailQty] = useState<number>(1);

  const keyOf = (p: any, i: number) => String(p?.sku || `idx-${i}`);
  const toggleItem = (k: string) => setSelectedItems((prev) => ({ ...prev, [k]: !prev[k] }));

  const toggleAccessory = (accName: string) => {
    setSelectedAccs((prev) => ({ ...prev, [accName]: !prev[accName] }));
  };

  const isCart = (cfg as any).commerceMode === 'cart';

  const handleBuildQuote = () => {
    const chosen = recommendedProducts.filter((p, i) => selectedItems[keyOf(p, i)]);
    const list = chosen.length ? chosen : recommendedProducts;
    if (list.length === 0) return;

    // Every tenant's quote comes from the SAME server-authoritative path — the
    // agent's buildQuote tool, via QuoteService.build() → the real pricebook.
    // (A client-fabricated SET_SERVER_QUOTE with a hardcoded 15% tax rate used
    // to exist here for PlaceMakers only; that both hardcoded a tenant literal
    // into a shared panel and set price on the client, which this platform's
    // quote/order security work specifically closed off everywhere else.)
    const fn = (window as any).__handleBuildQuote;
    if (fn) {
      let summary = isCart ? 'Add these selected items to my bag:\n' : 'Build my quote with these selected items:\n';
      list.forEach((p) => {
        summary += `- Main Product: ${p.name}\n`;
        if (p.installationParts) {
          p.installationParts.forEach((part) => {
            summary += `  + [Required Part] ${part.name}\n`;
          });
        }
        if (p.accessories) {
          p.accessories.forEach((acc) => {
            if (selectedAccs[acc.name]) {
              summary += `  + [Accessory] ${acc.name}\n`;
            }
          });
        }
      });
      fn(summary);
    }
  };

  if (recommendedProducts.length === 0) {
    return (
      <div className="products-panel">
        <div className="products-panel__eyebrow">Searching catalog</div>
        <h2 className="products-panel__heading">Finding the best match</h2>
        <p className="products-panel__desc">
          {`Searching ${cfg.companyName || 'the'} catalogue to find the perfect fit…`}
        </p>
        <div className="thinking" style={{ marginTop: 24 }}>
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="thinking__dot" />
        </div>
      </div>
    );
  }

  // Focused single-product detail view
  if (focusIdx !== null && recommendedProducts[focusIdx]) {
    const p = recommendedProducts[focusIdx];
    const pName = getProductName(p);
    const pCategory = getProductCategory(p);
    const pDesc = getProductDescription(p);
    const pFeatures = getProductFeatures(p);
    const pSpecs = getProductSpecs(p);
    const priceFormatted = formatPrice(p.price, (p as any).currency || (cfg as any)?.pricing?.currency || '');

    const addThis = () => {
      // Server-authoritative path for every tenant — see handleBuildQuote above.
      const fn = (window as any).__handleBuildQuote;
      if (fn) {
        fn(`${isCart ? 'Add this item to my bag' : 'Build my quote with this item'}:\n- Main Product: ${pName} (Qty: ${detailQty})\n- SKU: ${p.sku || 'N/A'}\n`);
      }
    };

    return (
      <div className="products-panel products-panel--with-footer">
        <div className="products-panel__scroll" style={{ paddingBottom: '5rem' }}>
          <button type="button" className="product-detail__back" onClick={() => setFocusIdx(null)}>
            ← Back to {labels.items?.toLowerCase() || 'recommendations'}
          </button>

          {/* Product Media Hero */}
          <div style={{ borderRadius: '1rem', overflow: 'hidden', marginBottom: '1.25rem', border: '1px solid #e2e8f0' }}>
            <ProductVisual imageUrl={p.imageUrl} name={pName} category={pCategory} />
          </div>

          <div className="product-detail__category" style={{ color: 'var(--brand-link, var(--brand-primary))', fontWeight: 700 }}>
            {pCategory}
          </div>

          <h2 className="product-detail__name" style={{ fontSize: '1.5rem', lineHeight: '1.25' }}>
            {pName}
          </h2>

          {p.sku && (
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.25rem', fontFamily: 'monospace' }}>
              Item Code / SKU: <span style={{ fontWeight: 600, color: '#1e293b' }}>{p.sku}</span>
            </div>
          )}

          {(typeof p.inStock === 'boolean') && <p className="product-detail__availability">{p.inStock ? 'Available in the catalogue — confirm branch stock before collection.' : 'Currently unavailable.'}</p>}
          {recommendationReason(p) && <p className="product-detail__reason"><strong>Why this fits:</strong> {recommendationReason(p)}</p>}

          <div className="product-detail__price" style={{ margin: '0.75rem 0', fontSize: '1.35rem', fontWeight: 800, color: 'var(--brand-link, var(--brand-primary))' }}>
            {priceFormatted}
          </div>

          <p className="product-detail__desc" style={{ color: '#334155', lineHeight: '1.6' }}>
            {pDesc}
          </p>

          {/* Interactive Quantity Selector */}
          <div style={{ margin: '1.25rem 0', padding: '1rem', background: '#f8fafc', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              Quantity Required
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setDetailQty((q) => Math.max(1, q - 1))}
                  style={{ padding: '0.375rem 0.75rem', fontWeight: 700, color: '#475569', border: 'none', background: 'none', cursor: 'pointer' }}
                >
                  -
                </button>
                <span style={{ minWidth: '2.5rem', textAlign: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#1e293b' }}>
                  {detailQty}
                </span>
                <button
                  type="button"
                  onClick={() => setDetailQty((q) => q + 1)}
                  style={{ padding: '0.375rem 0.75rem', fontWeight: 700, color: '#475569', border: 'none', background: 'none', cursor: 'pointer' }}
                >
                  +
                </button>
              </div>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                Units / Standard pack size
              </span>
            </div>
          </div>

          {/* Apparel Try-on ONLY for garment tenants */}
          {isGarment && (
            <TryOn garmentImageUrl={p.imageUrl} garmentName={pName} garmentColor={(p as any).colors?.[0]?.name} />
          )}

          {/* Technical Specifications Table */}
          {pSpecs && Object.keys(pSpecs).length > 0 && (
            <div className="product-card__specs" style={{ margin: '1.5rem 0' }}>
              <div className="product-card__specs-title" style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.75rem' }}>
                📋 Technical Specifications
              </div>
              <div className="product-card__specs-grid">
                {Object.entries(pSpecs).map(([key, value]) => (
                  <div key={key} className="product-card__spec-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                    <span className="product-card__spec-label" style={{ fontWeight: 600, color: '#64748b' }}>{key}</span>
                    <span className="product-card__spec-value" style={{ fontWeight: 700, color: '#0f172a' }}>{specStr(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Features / Benefits */}
          {pFeatures && pFeatures.length > 0 && (
            <div style={{ margin: '1.25rem 0' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' }}>
                ⭐ Catalogue features
              </div>
              <ul className="product-card__features" style={{ paddingLeft: '1.25rem', color: '#334155', fontSize: '0.85rem' }}>
                {pFeatures.map((f, i) => (
                  <li key={i} style={{ marginBottom: '0.35rem' }}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {productLink(p.url) && (
            <a
              href={productLink(p.url)}
              {...linkProps}
              className="product-card__link"
              style={{ display: 'inline-block', marginTop: '0.5rem', color: 'var(--brand-link, var(--brand-primary))', fontWeight: 600 }}
            >
              View on {(() => { try { return new URL(p.url!).hostname.replace(/^www\./, ''); } catch { return 'their site'; } })()} →
            </a>
          )}
        </div>

        <div className="products-panel__footer">
          <button className="clarify-build-btn" onClick={addThis}>
            {isCart ? `Add ${detailQty} to my bag` : `Add ${detailQty} to my quote`}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
              <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="products-panel products-panel--with-footer">
      <div className="products-panel__scroll">
        <div className="products-panel__eyebrow">My Recommendations</div>
        <h2 className="products-panel__heading">
          {labels.items} matched to your brief
        </h2>
        <p className="products-panel__desc">
          Select a product to see the catalogue details. Availability and technical guidance are shown when their sources are available.
        </p>

        <div className="products-grid">
          {recommendedProducts.map((product, idx) => {
            const k = keyOf(product, idx);
            const isSel = !!selectedItems[k];
            const name = getProductName(product);
            const category = getProductCategory(product);
            const desc = getProductDescription(product);
            const features = getProductFeatures(product);
            const priceFormatted = formatPrice(product.price, (product as any).currency || (cfg as any)?.pricing?.currency || '');

            return (
              <div
                key={`${product.sku || 'product'}-${idx}`}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusIdx(idx); } }}
                className={`product-card${isSel ? ' product-card--selected' : ''}`}
                onClick={() => setFocusIdx(idx)}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
              >
                <button
                  type="button"
                  className={`product-card__select${isSel ? ' checked' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleItem(k);
                  }}
                  aria-pressed={isSel}
                  title={isSel ? 'Selected — click to remove' : 'Select for quote/order'}
                >
                  {isSel ? '✓' : ''}
                </button>

                {/* Product Image or Rich Category Visual */}
                <ProductVisual imageUrl={product.imageUrl} name={name} category={category} />

                <div className="product-card__content">
                  <div className="product-card__category" style={{ color: 'var(--brand-link, var(--brand-primary))', fontWeight: 700 }}>
                    {category}
                  </div>
                  <div className="product-card__name" style={{ fontWeight: 700, color: '#0f172a', lineHeight: '1.3' }}>
                    {name}
                  </div>

                  <div className="product-card__price" style={{ color: 'var(--brand-link, var(--brand-primary))', fontWeight: 800, margin: '0.375rem 0' }}>
                    {priceFormatted}
                  </div>

                  {desc && (
                    <p style={{ fontSize: '0.8rem', color: '#475569', margin: '0.375rem 0', lineClamp: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {desc}
                    </p>
                  )}

                  {recommendationReason(product) && <p className="product-card__reason" style={{ fontSize: '0.8rem' }}><strong>Why this fits:</strong> {recommendationReason(product)}</p>}
                  {/* Highlights / Specs badges */}
                  {features && features.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.5rem' }}>
                      {features.slice(0, 3).map((f, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '0.15rem 0.4rem',
                            background: '#f1f5f9',
                            color: '#334155',
                            borderRadius: '0.25rem',
                            border: '1px solid #e2e8f0',
                          }}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  )}

                  {product.sku && (
                    <div className="product-card__sku" style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#64748b' }}>
                      SKU: {product.sku}
                    </div>
                  )}

                  {productLink(product.url) && (
                    <a
                      href={productLink(product.url)}
                      {...linkProps}
                      className="product-card__link"
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'inline-block', marginTop: '0.35rem', color: 'var(--brand-link, var(--brand-primary))', fontSize: '0.75rem' }}
                    >
                      View on {(() => { try { return new URL(product.url!).hostname.replace(/^www\./, ''); } catch { return 'their site'; } })()} →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sticky footer button */}
      {(() => {
        const n = recommendedProducts.filter((p, i) => selectedItems[keyOf(p, i)]).length;
        const disabled = isCart && n === 0;
        const label = isCart
          ? n > 0 ? `Add ${n} to my bag` : 'Select the pieces you want'
          : n > 0 ? `Add ${n} selected — build my quote` : 'Looks good — build my quote';
        return (
          <div className="products-panel__footer">
            <button className="clarify-build-btn" onClick={handleBuildQuote} disabled={disabled} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
              {label}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
                <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        );
      })()}
    </div>
  );
}
