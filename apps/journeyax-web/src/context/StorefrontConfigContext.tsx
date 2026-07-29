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
};

const Ctx = createContext<StorefrontConfig>(DEFAULT);
export const useStorefrontConfig = () => useContext(Ctx);

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
    root.setProperty('--dark', theme.accentColor);
    root.setProperty('--text', theme.accentColor);
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

  useEffect(() => {
    let alive = true;
    // Pass the page's query through so ?project=<id> selects the tenant
    // (multi-storefront routing); domain-based resolution happens server-side.
    fetch('/api/config' + (typeof window !== 'undefined' ? window.location.search : ''))
      .then((r) => r.json())
      .then((c: StorefrontConfig) => {
        if (!alive) return;
        setConfig({ ...DEFAULT, ...c, labels: { ...DEFAULT.labels, ...(c.labels || {}) } });
        applyTheme(c.theme || {});
      })
      .catch(() => { /* keep defaults */ });
    return () => { alive = false; };
  }, []);

  return <Ctx.Provider value={config}>{children}</Ctx.Provider>;
}
