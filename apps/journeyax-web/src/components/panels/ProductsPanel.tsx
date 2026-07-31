'use client';

import React, { useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { formatAUD } from '@/lib/types';

export default function ProductsPanel() {
  const cfg = useStorefrontConfig();
  const { state, dispatch } = useJourney();
  const { labels } = useStorefrontConfig();
  // Candy has no 3D concepts step — the design verb and destination come from
  // the project's configurator type, so the same button serves any product.
  const conf = (cfg as any).configurator || {};
  /* The Design-in-3D / Personalize button belongs ONLY to projects that ACTUALLY
     have a configurator — the `configurator` capability AND a real configurator
     config (a productType). A retail-fashion tenant (Abercrombie) that had the
     capability toggled on but no configurator config was wrongly offering
     "Design this in 3D" on stock apparel that can't be designed. Require both. */
  const has3D = (cfg.capabilities || []).includes('configurator') && !!conf.productType;
  const isCandy = conf.productType === 'candy';
  const designVerb = conf.designVerb || (isCandy ? 'Personalize this' : 'Design this in 3D');
  const { recommendedProducts } = state;
  const [selectedAccs, setSelectedAccs] = useState<Record<string, boolean>>({});

  /**
   * Open the designer on the style the customer clicked.
   *
   * Deliberately does NOT ask the agent. Every model-mediated route to 3D has
   * been unreliable — a SKU it mistyped, a name it could not resolve, an ordinal
   * it lost — so the same click produced 3D sometimes and prose other times.
   * The card already holds the real style code, so we set the design and switch
   * the panel ourselves: same input, same result, every time.
   *
   * The confirmed team colours carry over so the garment opens in their colours
   * rather than a blank default. The agent is told afterwards, so the chat stays
   * in step with what the panel is showing.
   */
  const onDesign = (product: any) => {
    const sku = String(product?.sku || '').trim();
    if (!sku) return;
    dispatch({ type: 'CLEAR_DESIGN' });
    dispatch({ type: 'SET_DESIGN', design: {
      sku,
      ...(state.design?.baseColor ? { baseColor: state.design.baseColor } : {}),
      ...(state.design?.accentColor ? { accentColor: state.design.accentColor } : {}),
    } });
    /* Concepts first, then 3D. Dropping straight into the designer showed one
     * design line — whichever the style listed first — with nothing to compare
     * it against. The concepts step puts three looks in the team's colours side
     * by side; picking one opens it in 3D. */
    if (isCandy) {
      // Straight into the candy designer — there is no "design line" to compare,
      // the customer personalises the candy itself.
      dispatch({ type: 'SET_PHASE', phase: 'configurator' });
      return;
    }
    dispatch({ type: 'SET_PHASE', phase: 'concepts' });
    const send = (window as any).__journeySend;
    if (typeof send === 'function') {
      /* Tell the agent WHICH style, and that the customer is choosing the look
       * themselves. Without the second half it answered by rendering a design
       * line of its own choosing and describing that — so the chat said "Fast
       * Break" while the panel showed the concept the customer had just picked.
       * The design line is the customer's decision here, not the agent's. */
      send(`I'm looking at design options for ${product?.name || sku} (${sku}). `
        + `I'll pick the design line from the concepts on the panel — don't choose one for me `
        + `and don't render it yet, just tell me what to look for.`);
    }
  };

  const toggleAccessory = (accName: string) => {
    setSelectedAccs(prev => ({ ...prev, [accName]: !prev[accName] }));
  };

  const isCart = (cfg as any).commerceMode === 'cart';
  const handleBuildQuote = () => {
    const fn = (window as any).__handleBuildQuote;
    if (fn) {
      let summary = (isCart ? 'Add these selected items to my bag:\n' : 'Build my quote with these selected items:\n');
      recommendedProducts.forEach(p => {
        summary += `- Main Product: ${p.name}\n`;
        if (p.installationParts) {
          p.installationParts.forEach(part => {
            summary += `  + [Required Part] ${part.name}\n`;
          });
        }
        if (p.accessories) {
          p.accessories.forEach(acc => {
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

  return (
    <div className="products-panel products-panel--with-footer">
      <div className="products-panel__scroll">
        <div className="products-panel__eyebrow">My Recommendations</div>
        <h2 className="products-panel__heading">
          {labels.items} matched to your brief
        </h2>
        <p className="products-panel__desc">
          I&apos;ve explained each product in the chat — here are the details and specs.
        </p>

        <div className="products-grid">
          {recommendedProducts.map((product, idx) => (
            <div key={`${product.sku || 'product'}-${idx}`} className="product-card">
              {product.imageUrl && (
                <div className="product-card__image">
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
              <div className="product-card__content">
                <div className="product-card__category">{product.category}</div>
                <div className="product-card__name">{product.name}</div>
                {product.collection && (
                  <div className="product-card__collection">{product.collection} Collection</div>
                )}
                <div className="product-card__price">{formatAUD(product.price)}</div>
                <div className="product-card__desc">{product.description}</div>

                {/* Technical Specifications */}
                {product.specs && Object.keys(product.specs).length > 0 && (
                  <div className="product-card__specs">
                    <div className="product-card__specs-title">Specifications</div>
                    <div className="product-card__specs-grid">
                      {Object.entries(product.specs).map(([key, value]) => (
                        <div key={key} className="product-card__spec-row">
                          <span className="product-card__spec-label">{key}</span>
                          <span className="product-card__spec-value">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {product.features && product.features.length > 0 && (
                  <ul className="product-card__features">
                    {product.features.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {product.finishes && product.finishes.length > 0 && (
                  <div className="product-card__finishes">
                    {product.finishes.map(f => (
                      <span key={f} className="product-card__finish-tag">{f}</span>
                    ))}
                  </div>
                )}
                
                {/* Installation Parts (Mandatory) */}
                {product.installationParts && product.installationParts.length > 0 && (
                  <div className="product-card__parts">
                    <div className="product-card__parts-title">Required for Installation</div>
                    {product.installationParts.map((part, i) => (
                      <div key={i} className="product-card__part-row mandatory">
                        <span className="part-checkbox checked">✓</span>
                        <div className="part-info">
                          <div className="part-name">{part.name}</div>
                          <div className="part-price">{formatAUD(part.price)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Cross-sell (Multiple Choice). For a retail fashion bag these
                    are coordinating pieces — "Complete the look" — not plumbing
                    "accessories"; a pant is not an accessory of a shirt. Label
                    follows commerceMode so fixtures keep "Recommended Accessories". */}
                {product.accessories && product.accessories.length > 0 && (
                  <div className="product-card__parts">
                    <div className="product-card__parts-title">{isCart ? 'Complete the look' : 'Recommended Accessories'}</div>
                    {product.accessories.map((acc, i) => {
                      const isSelected = selectedAccs[acc.name] || false;
                      return (
                        <div 
                          key={i} 
                          className={`product-card__part-row optional ${isSelected ? 'selected' : ''}`}
                          onClick={() => toggleAccessory(acc.name)}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className={`part-checkbox ${isSelected ? 'checked' : ''}`}>
                            {isSelected ? '✓' : ''}
                          </span>
                          <div className="part-info">
                            <div className="part-name">{acc.name}</div>
                            <div className="part-price">{formatAUD(acc.price)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* DESIGN — the customer's way into 3D.
                    Every other route (typing a SKU, "product 2", a product name)
                    goes through the model, which is why launching the designer
                    was unpredictable. A button carries the style code itself, so
                    it opens the SAME garment every time, with no interpretation
                    in between. Only shown when the style can actually be
                    designed — offering it on a stock item would fail after the
                    click, which is worse than not offering it. */}
                {has3D && product.sku && product.sku.trim() !== '' && product.designable !== false && (
                  <button
                    type="button"
                    className="product-card__design-btn"
                    onClick={() => onDesign(product)}
                  >
                    {designVerb}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 8 }}>
                      <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                {product.sku && product.sku.trim() !== '' && (
                  <div className="product-card__sku" style={{ marginTop: 16 }}>SKU: {product.sku}</div>
                )}
                {product.url && (
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="product-card__link"
                  >
                    View on {(() => { try { return new URL(product.url).hostname.replace(/^www\./, ''); } catch { return 'source site'; } })()} →
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sticky footer button */}
      <div className="products-panel__footer">
        <button className="clarify-build-btn" onClick={handleBuildQuote}>
          {isCart ? 'Looks good — add to my bag' : 'Looks good — build my quote'}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
            <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
