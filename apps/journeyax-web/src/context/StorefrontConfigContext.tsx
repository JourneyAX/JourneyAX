'use client';

import { createContext, useContext, useEffect, useState } from 'react';

export interface ConfiguratorConfig {
  enabled?: boolean;
  productType?: string;
  title?: string;
  colors?: { name: string; hex: string }[];
  accentColors?: { name: string; hex: string }[];
  fields?: { key: string; label: string; max?: number }[];
}

/** The opening screen's copy — starters and the input placeholder. Config-driven
 *  so each tenant sets its own vertical-true example ("Volleyball jerseys for
 *  Oswego East — 14 players, home & away") in the back office instead of a
 *  generic hardcoded one. When unset, ChatPanel falls back to label-derived text. */
export interface IntroConfig {
  starters?: { label: string; prompt: string }[];
  inputPlaceholder?: string;
  heroHeadline?: string;
  heroSubtitle?: string;
}

export interface StorefrontConfig {
  projectId: string;
  companyName: string;
  theme: { primaryColor?: string; accentColor?: string; fontFamily?: string; logoUrl?: string; sidebarStyle?: 'light' | 'dark'; sidebarColor?: string };
  labels: { items: string; itemsSingular: string; headerTitle: string };
  greeting: string;
  systemName: string;
  capabilities: string[];
  configurator: ConfiguratorConfig | null;
  intro?: IntroConfig | null;
  /** Commerce surface: 'cart' (B2C retail) vs 'quote' (B2B project quote). */
  commerceMode: 'quote' | 'cart';
}

const DEFAULT: StorefrontConfig = {
  projectId: 'caroma',
  companyName: 'JourneyAX',
  theme: {},
  labels: { items: 'Products', itemsSingular: 'Product', headerTitle: 'AI Configurator' },
  greeting: '',
  systemName: '',
  capabilities: [],
  configurator: null,
  commerceMode: 'quote',
};

const Ctx = createContext<StorefrontConfig>(DEFAULT);
export const useStorefrontConfig = () => useContext(Ctx);

/** Perceived luminance of a #rrggbb (Rec. 601). ~>0.69 reads as "light". */
function isLightHex(hex?: string): boolean {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.69;
}

/** Apply the tenant's theme to the storefront's CSS variables at runtime. */
function applyTheme(theme: StorefrontConfig['theme']) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  if (theme.primaryColor) {
    // The storefront's brand accent lives in --gold / --gold-light.
    root.setProperty('--gold', theme.primaryColor);
    root.setProperty('--gold-light', theme.primaryColor);
    root.setProperty('--auto-text', theme.primaryColor);
  }
  if (theme.accentColor) {
    // accentColor DOUBLES as the body TEXT colour (--text) and the dark token.
    // A near-white accent — e.g. a minimalist black/white brand that set
    // accent=#FFFFFF — would render every heading, product title and the chat
    // input invisible on the light storefront. So a LIGHT accent falls back to a
    // safe near-black for text/dark tokens; dark accents (the common case) pass
    // through unchanged. A theme must never make text unreadable.
    const safeInk = isLightHex(theme.accentColor) ? '#1A1A1A' : theme.accentColor;
    root.setProperty('--dark', safeInk);
    root.setProperty('--text', safeInk);
  }
  if (theme.fontFamily) {
    root.setProperty('--font-display', theme.fontFamily);
    document.body.style.fontFamily = theme.fontFamily;
  }
  // Dark sidebar background (AUG-49) — the 40% chat panel's brand colour.
  if (theme.sidebarColor) root.setProperty('--sidebar-bg', theme.sidebarColor);
}

export function StorefrontConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<StorefrontConfig>(DEFAULT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Pass the page's query through so ?project=<id> selects the tenant
    // (multi-storefront routing); domain-based resolution happens server-side.
    fetch('/api/config' + (typeof window !== 'undefined' ? window.location.search : ''))
      .then((r) => r.json())
      .then((c: any) => {
        if (!alive) return;
        if (c.error) {
          setError(c.message || 'Project does not exist.');
          return;
        }
        setConfig({ ...DEFAULT, ...c, labels: { ...DEFAULT.labels, ...(c.labels || {}) } });
        applyTheme(c.theme || {});
      })
      .catch(() => { /* keep defaults */ });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div style={{ display: 'flex', height: '100vh', width: '100vw', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9fafb' }}>
        <div style={{ textAlign: 'center', padding: '2rem', backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)', maxWidth: '400px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#111827', marginBottom: '0.5rem' }}>Project Unavailable</h1>
          <p style={{ color: '#4b5563' }}>{error}</p>
        </div>
      </div>
    );
  }

  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}
