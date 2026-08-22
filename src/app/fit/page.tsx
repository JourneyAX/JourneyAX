'use client';

import FitDemo from '@/components/fit/FitDemo';
import '../csr/csr.css';
import './fit.css';

export default function FitPage() {
  return (
    <div className="csr-shell fitd-shell">
      <header className="csr-topbar">
        <div className="csr-topbar__brand">
          <span className="csr-topbar__mark">JOURNEYAX</span>
          <span className="csr-topbar__divider" />
          <span className="csr-topbar__app">Fit engine</span>
        </div>
        <div className="csr-topbar__note">
          One engine, two brands · <strong>mock data</strong>
        </div>
      </header>

      <FitDemo />
    </div>
  );
}
