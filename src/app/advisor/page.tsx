'use client';

import ProductPage from '@/components/fit/ProductPage';
import '../csr/csr.css';
import './advisor.css';

export default function AdvisorPage() {
  return (
    <div className="csr-shell adv-shell">
      <header className="csr-topbar">
        <div className="csr-topbar__brand">
          <span className="csr-topbar__mark">JOURNEYAX</span>
          <span className="csr-topbar__divider" />
          <span className="csr-topbar__app">Fit Advisor</span>
        </div>
        <div className="csr-topbar__note">
          Shopper-facing · <strong>mock storefront</strong>
        </div>
      </header>

      <ProductPage />
    </div>
  );
}
