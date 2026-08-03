'use client';

import React, { useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { formatAUD } from '@/lib/types';

export default function ProductsPanel() {
  const { state } = useJourney();
  const { recommendedProducts } = state;
  const [selectedAccs, setSelectedAccs] = useState<Record<string, boolean>>({});

  const toggleAccessory = (accName: string) => {
    setSelectedAccs(prev => ({ ...prev, [accName]: !prev[accName] }));
  };

  const handleBuildQuote = () => {
    const fn = (window as any).__handleBuildQuote;
    if (fn) {
      let summary = 'Build my quote with these selected items:\n';
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
          Matching your answers against the catalog…
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
          Products matched to your brief
        </h2>
        <p className="products-panel__desc">
          Products matched to your brief — review specs, pick accessories, then build your quote.
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

                {/* Accessories (Multiple Choice) */}
                {product.accessories && product.accessories.length > 0 && (
                  <div className="product-card__parts">
                    <div className="product-card__parts-title">Recommended Accessories</div>
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
                    View on caroma.com.au →
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
          Looks good — build my quote
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
            <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
