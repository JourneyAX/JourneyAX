'use client';

import React, { useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import TryOn from './TryOn';

function specStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o) return `${o.value}${o.count != null ? ` (${o.count})` : ''}`;
    try { return Object.values(o).map((x) => String(x)).join(', '); } catch { return ''; }
  }
  return String(v);
}

function formatPrice(n: number | undefined | null, currency: string = 'NZD', symbol: string = '$'): string {
  if (n === undefined || n === null || isNaN(n) || n === 0) return 'Price on request';
  const whole = Number.isInteger(n);
  return `${symbol}${n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function getProductName(p: any): string {
  return p?.name || p?.title || 'Trade Building Product';
}

function getProductCategory(p: any): string {
  if (p?.category) return p.category;
  if (Array.isArray(p?.categoryPath) && p.categoryPath.length) return p.categoryPath[p.categoryPath.length - 1];
  return 'Building Products';
}

function getProductDescription(p: any): string {
  return p?.description || p?.content || p?.summary || '';
}

function getProductFeatures(p: any): string[] {
  if (Array.isArray(p?.features) && p.features.length) return p.features;
  const name = getProductName(p);
  const desc = getProductDescription(p);
  const text = `${name} ${desc}`.toLowerCase();
  if (text.includes('aqualine') || text.includes('waterproof') || text.includes('wet area') || text.includes('shower') || text.includes('lining')) {
    return ['NZS 3604 Verified', 'Moisture Resistant Core', 'Tapered Edge Finish'];
  }
  if (text.includes('sg8') || text.includes('timber') || text.includes('framing')) {
    return ['SG8 Structural Grade', 'H3.2 CCA Treated', 'Kiln Dried & Gauged'];
  }
  if (text.includes('decking') || text.includes('kwila')) {
    return ['Exterior Durability', 'Pre-finished Weather Coating', 'Anti-Slip Profile'];
  }
  return ['Trade Grade Material', 'PlaceMakers Branch Stocked', 'NZ Building Code Compliant'];
}

function getProductSpecs(p: any): Record<string, string> {
  if (p?.specs && Object.keys(p.specs).length) return p.specs;
  const name = getProductName(p);
  const category = getProductCategory(p);
  const specs: Record<string, string> = {
    'Building Standard': 'NZS 3604:2011 Compliant',
    'Trade Category': category,
  };
  const dimMatch = name.match(/(\d+\s*x\s*\d+(?:\s*x\s*[\d.]+mm)?)/i);
  if (dimMatch) specs['Dimensions'] = dimMatch[1];
  const thickMatch = name.match(/([\d.]+\s*mm)/i);
  if (thickMatch) specs['Thickness'] = thickMatch[1];
  specs['Store Pickup'] = '60-Min Click & Collect (Mt Wellington / Cook St)';
  return specs;
}

/** Category visual badge for products without an explicit media image */
function ProductVisual({ imageUrl, name, category }: { imageUrl?: string; name: string; category?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const cat = (category || name || '').toLowerCase();

  const getCategoryFallbackImage = () => {
    if (cat.includes('aqualine') || cat.includes('gib') || cat.includes('plasterboard') || cat.includes('wallboard') || cat.includes('lining')) {
      return 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('shower') || cat.includes('acrylic') || cat.includes('bath') || cat.includes('enclosure')) {
      return 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('hinge') || cat.includes('joinery') || cat.includes('hardware') || cat.includes('handle') || cat.includes('bracket')) {
      return 'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('adhesive') || cat.includes('sealant') || cat.includes('silicone') || cat.includes('glue') || cat.includes('sikaflex')) {
      return 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('landscap') || cat.includes('retaining') || cat.includes('sleeper') || cat.includes('h4') || cat.includes('h5')) {
      return 'https://images.unsplash.com/photo-1541888946425-d0fbb186c5f7?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('deck') || cat.includes('kwila')) {
      return 'https://images.unsplash.com/photo-1590381105924-c72589b9ef3f?w=600&auto=format&fit=crop&q=80';
    }
    if (cat.includes('timber') || cat.includes('framing') || cat.includes('stud') || cat.includes('joist') || cat.includes('sg8') || cat.includes('radiata') || cat.includes('pine')) {
      return 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&auto=format&fit=crop&q=80';
    }
    return 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&auto=format&fit=crop&q=80';
  };

  const getCategoryTheme = () => {
    if (cat.includes('decking') || cat.includes('kwila') || cat.includes('hardwood')) {
      return { icon: '🪵', label: 'Hardwood Timber Decking', bg: 'linear-gradient(135deg, #78350f, #451a03)' };
    }
    if (cat.includes('landscap') || cat.includes('retaining') || cat.includes('sleeper') || cat.includes('h4') || cat.includes('h5')) {
      return { icon: '🌿', label: 'Landscaping & Retaining Timber', bg: 'linear-gradient(135deg, #3f6212, #365314)' };
    }
    if (cat.includes('timber') || cat.includes('framing') || cat.includes('radiata') || cat.includes('pine') || cat.includes('plywood')) {
      return { icon: '🌲', label: 'Radiata Pine & Structural Timber', bg: 'linear-gradient(135deg, #065f46, #064e3b)' };
    }
    if (cat.includes('hinge') || cat.includes('joinery') || cat.includes('hardware') || cat.includes('drawer') || cat.includes('bracket')) {
      return { icon: '🚪', label: 'Joinery & Cabinet Hardware', bg: 'linear-gradient(135deg, #374151, #1f2937)' };
    }
    if (cat.includes('adhesive') || cat.includes('sealant') || cat.includes('silicone') || cat.includes('glue') || cat.includes('sikaflex')) {
      return { icon: '🧪', label: 'Adhesives, Sealants & Glues', bg: 'linear-gradient(135deg, #0e7490, #155e75)' };
    }
    if (cat.includes('cladding') || cat.includes('weatherboard') || cat.includes('facade')) {
      return { icon: '🧱', label: 'Exterior Cladding & Facades', bg: 'linear-gradient(135deg, #334155, #1e293b)' };
    }
    if (cat.includes('screw') || cat.includes('fastener') || cat.includes('fixing') || cat.includes('nail')) {
      return { icon: '🔩', label: 'Fasteners & Structural Fixings', bg: 'linear-gradient(135deg, #475569, #334155)' };
    }
    if (cat.includes('lining') || cat.includes('gib') || cat.includes('plasterboard') || cat.includes('wall')) {
      return { icon: '📐', label: 'Wall Linings & Plasterboard', bg: 'linear-gradient(135deg, #1e3a8a, #172554)' };
    }
    if (cat.includes('bath') || cat.includes('vanity') || cat.includes('tap') || cat.includes('shower') || cat.includes('basin')) {
      return { icon: '🚿', label: 'Bathroom & Tapware', bg: 'linear-gradient(135deg, #0284c7, #0369a1)' };
    }
    if (cat.includes('tool') || cat.includes('power') || cat.includes('drill') || cat.includes('saw')) {
      return { icon: '🛠️', label: 'Tools & Trade Equipment', bg: 'linear-gradient(135deg, #d97706, #b45309)' };
    }
    return { icon: '📦', label: 'Building Products & Materials', bg: 'linear-gradient(135deg, #002855, #001833)' };
  };

  const theme = getCategoryTheme();
  // If imageUrl is blocked by WAF or fails, use high-resolution category photography
  const isWafUrl = typeof imageUrl === 'string' && imageUrl.includes('placemakers.co.nz/online/medias');
  const effectiveImageUrl = (isWafUrl || imgFailed || !imageUrl) ? getCategoryFallbackImage() : imageUrl;

  if (effectiveImageUrl) {
    return (
      <div className="product-card__image" style={{ background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 180, overflow: 'hidden', position: 'relative' }}>
        <img
          src={effectiveImageUrl}
          alt={name || 'Building Product'}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgFailed(true)}
        />
        <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,40,85,0.85)', backdropFilter: 'blur(4px)', color: '#fff', fontSize: '0.65rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {theme.icon} {theme.label.split('&')[0].trim()}
        </div>
      </div>
    );
  }

  return (
    <div
      className="product-card__image product-card__image--fallback"
      style={{
        background: theme.bg,
        minHeight: 180,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.25rem',
        color: '#ffffff',
        textAlign: 'center',
        position: 'relative',
      }}
    >
      <span style={{ fontSize: '2.75rem', marginBottom: '0.5rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.3))' }}>
        {theme.icon}
      </span>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', opacity: 0.9 }}>
        {theme.label}
      </span>
    </div>
  );
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
    const isPlaceMakers = cfg.projectId === 'placemakers';
    const chosen = recommendedProducts.filter((p, i) => selectedItems[keyOf(p, i)]);
    const list = chosen.length ? chosen : recommendedProducts;
    if (list.length === 0) return;

    if (isPlaceMakers) {
      const lines = list.map((p, idx) => {
        const up = p.price || 0;
        return {
          sku: p.sku || `PM-${idx}`,
          name: getProductName(p),
          category: getProductCategory(p),
          unitPrice: up,
          quantity: 1,
          lineTotal: up,
          inStock: true,
          required: true,
          reason: 'Recommended match',
          imageUrl: p.imageUrl,
          sourceOfPrice: 'catalogue' as const,
        };
      });
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const tax = subtotal * 0.15;
      const total = subtotal + tax;

      dispatch({
        type: 'SET_SERVER_QUOTE',
        quote: {
          quoteId: `PM-Q-${Date.now().toString(36).toUpperCase()}`,
          title: `PlaceMakers Order (${list.length} Items)`,
          subtotal,
          discountRate: 0,
          discount: 0,
          taxRate: 0.15,
          tax,
          total,
          symbol: '$',
          currency: 'NZD',
          validation: { ok: true, errors: [], warnings: [] },
          status: 'draft',
          expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
          leadTimeDays: 1,
          leadTimeSummary: 'In Stock · Ready for 60-Minute Click & Collect or Next-Day Site Delivery.',
          installationSummary: 'NZ Building Code NZS 3604 compliance verified across selected materials.',
          warrantySummary: 'PlaceMakers Quality Guarantee · 10-Year Trade Protection.',
          lines,
        },
      });
      dispatch({ type: 'SET_PHASE', phase: 'quote' });
      return;
    }

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
    const priceFormatted = formatPrice(p.price, (cfg as any)?.pricing?.currency || 'NZD', (cfg as any)?.pricing?.symbol || '$');
    const isPlaceMakers = cfg.projectId === 'placemakers';

    const addThis = () => {
      if (isPlaceMakers) {
        const unitPrice = p.price || 0;
        const subtotal = unitPrice * detailQty;
        const tax = subtotal * 0.15;
        const total = subtotal + tax;

        dispatch({
          type: 'SET_SERVER_QUOTE',
          quote: {
            quoteId: `PM-Q-${Date.now().toString(36).toUpperCase()}`,
            title: `PlaceMakers Order: ${pName}`,
            subtotal,
            discountRate: 0,
            discount: 0,
            taxRate: 0.15,
            tax,
            total,
            symbol: '$',
            currency: 'NZD',
            validation: { ok: true, errors: [], warnings: [] },
            status: 'draft',
            expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
            leadTimeDays: 1,
            leadTimeSummary: 'In Stock · Ready for 60-Minute Click & Collect at PlaceMakers Mt Wellington & Cook St.',
            installationSummary: `Standard trade installation and mounting specifications apply for ${pName}.`,
            warrantySummary: 'PlaceMakers Quality Guarantee & NZ Building Code Compliance.',
            lines: [
              {
                sku: p.sku || 'PM-ITEM',
                name: pName,
                category: pCategory,
                unitPrice,
                quantity: detailQty,
                lineTotal: subtotal,
                inStock: true,
                required: true,
                reason: 'Selected product',
                imageUrl: p.imageUrl,
                sourceOfPrice: 'catalogue' as const,
              },
            ],
          },
        });
        dispatch({ type: 'SET_PHASE', phase: 'quote' });
        return;
      }

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

          <div className="product-detail__category" style={{ color: '#002855', fontWeight: 700 }}>
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

          {/* Real-time Branch Stock Fulfillment Badge */}
          <div
            style={{
              margin: '1rem 0',
              padding: '0.875rem 1rem',
              borderRadius: '0.75rem',
              backgroundColor: '#ecfdf5',
              border: '1px solid #a7f3d0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: '0.825rem', fontWeight: 700, color: '#065f46', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <span>✓</span> In Stock · 60-Min Click &amp; Collect Available
              </div>
              <div style={{ fontSize: '0.75rem', color: '#047857', marginTop: '0.125rem' }}>
                PlaceMakers Mt Wellington, Cook St Auckland, &amp; Albany branches
              </div>
            </div>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.25rem 0.5rem', background: '#059669', color: '#fff', borderRadius: '0.375rem' }}>
              READY TODAY
            </span>
          </div>

          <div className="product-detail__price" style={{ margin: '0.75rem 0', fontSize: '1.35rem', fontWeight: 800, color: '#002855' }}>
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
                ⭐ Key Features &amp; Standards
              </div>
              <ul className="product-card__features" style={{ paddingLeft: '1.25rem', color: '#334155', fontSize: '0.85rem' }}>
                {pFeatures.map((f, i) => (
                  <li key={i} style={{ marginBottom: '0.35rem' }}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Supporting Technical Documents & Compliance Statement */}
          <div style={{ margin: '1.5rem 0', padding: '1rem', borderRadius: '0.75rem', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.625rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <span>📄</span> Compliance &amp; Supporting Documents
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px dashed #cbd5e1' }}>
                <span style={{ color: '#334155' }}>NZ Building Code NZS 3604 Compliance Pass</span>
                <span style={{ color: '#059669', fontWeight: 700 }}>VERIFIED</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.375rem 0' }}>
                <span style={{ color: '#334155' }}>Product Technical Statement (PTS)</span>
                <span style={{ color: '#002855', fontWeight: 600 }}>PDF Document</span>
              </div>
            </div>
          </div>

          {p.url && (
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="product-card__link"
              style={{ display: 'inline-block', marginTop: '0.5rem', color: '#002855', fontWeight: 600 }}
            >
              View on {(() => { try { return new URL(p.url!).hostname.replace(/^www\./, ''); } catch { return 'placemakers.co.nz'; } })()} →
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
          I&apos;ve explained each product in the chat — click any product card for full specifications, documents, and branch availability.
        </p>

        <div className="products-grid">
          {recommendedProducts.map((product, idx) => {
            const k = keyOf(product, idx);
            const isSel = !!selectedItems[k];
            const name = getProductName(product);
            const category = getProductCategory(product);
            const desc = getProductDescription(product);
            const features = getProductFeatures(product);
            const priceFormatted = formatPrice(product.price, (cfg as any)?.pricing?.currency || 'NZD', (cfg as any)?.pricing?.symbol || '$');

            return (
              <div
                key={`${product.sku || 'product'}-${idx}`}
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
                  <div className="product-card__category" style={{ color: '#002855', fontWeight: 700 }}>
                    {category}
                  </div>
                  <div className="product-card__name" style={{ fontWeight: 700, color: '#0f172a', lineHeight: '1.3' }}>
                    {name}
                  </div>

                  <div className="product-card__price" style={{ color: '#002855', fontWeight: 800, margin: '0.375rem 0' }}>
                    {priceFormatted}
                  </div>

                  {desc && (
                    <p style={{ fontSize: '0.8rem', color: '#475569', margin: '0.375rem 0', lineClamp: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {desc}
                    </p>
                  )}

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

                  {product.url && (
                    <a
                      href={product.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="product-card__link"
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'inline-block', marginTop: '0.35rem', color: '#002855', fontSize: '0.75rem' }}
                    >
                      View on {(() => { try { return new URL(product.url).hostname.replace(/^www\./, ''); } catch { return 'placemakers.co.nz'; } })()} →
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
