'use client';

import { CsrProvider } from '@/context/CsrContext';
import CommandBar from '@/components/csr/CommandBar';
import CsrWorkspace from '@/components/csr/CsrWorkspace';
import './csr.css';

export default function CsrPage() {
  return (
    <CsrProvider>
      <div className="csr-shell">
        <header className="csr-topbar">
          <div className="csr-topbar__brand">
            <span className="csr-topbar__mark">MOMENTEC</span>
            <span className="csr-topbar__divider" />
            <span className="csr-topbar__app">CSR Copilot</span>
          </div>
          <div className="csr-topbar__note">
            Reorder desk · spine build · <strong>mock data</strong>
          </div>
        </header>

        <CommandBar />
        <CsrWorkspace />
      </div>
    </CsrProvider>
  );
}
