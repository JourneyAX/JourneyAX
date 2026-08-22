'use client';

import { useEffect, useState } from 'react';
import { CsrProvider } from '@/context/CsrContext';
import CommandBar from '@/components/csr/CommandBar';
import CsrWorkspace from '@/components/csr/CsrWorkspace';
import OrdersPanel from '@/components/csr/OrdersPanel';
import './csr.css';

type View = 'desk' | 'orders';

export default function CsrPage() {
  const [view, setView] = useState<View>('desk');
  const [newCount, setNewCount] = useState(0);

  // The badge needs to be visible from the desk view too, before OrdersPanel
  // has ever mounted, so it's a light fetch of its own rather than shared
  // state with that component.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/orders', { cache: 'no-store' });
        const body = await res.json();
        if (!active) return;
        const count = (body.orders ?? []).filter((o: { status: string }) => o.status === 'new').length;
        setNewCount(count);
      } catch {
        // A failed badge fetch is not worth surfacing an error over.
      }
    })();
    return () => { active = false; };
  }, [view]);

  return (
    <CsrProvider>
      <div className="csr-shell">
        <header className="csr-topbar">
          <div className="csr-topbar__brand">
            <span className="csr-topbar__mark">MOMENTEC</span>
            <span className="csr-topbar__divider" />
            <span className="csr-topbar__app">CSR Copilot</span>
          </div>

          <div className="csr-topbar__tabs">
            <button
              className={`csr-topbar__tab ${view === 'desk' ? 'csr-topbar__tab--active' : ''}`}
              onClick={() => setView('desk')}
            >
              Search &amp; assist
            </button>
            <button
              className={`csr-topbar__tab ${view === 'orders' ? 'csr-topbar__tab--active' : ''}`}
              onClick={() => setView('orders')}
            >
              Orders
              {newCount > 0 && <span className="csr-topbar__badge">{newCount}</span>}
            </button>
          </div>

          <div className="csr-topbar__note">
            Reorder desk · spine build · <strong>mock data</strong>
          </div>
        </header>

        {view === 'desk' ? (
          <>
            <CommandBar />
            <CsrWorkspace />
          </>
        ) : (
          <OrdersPanel />
        )}
      </div>
    </CsrProvider>
  );
}
