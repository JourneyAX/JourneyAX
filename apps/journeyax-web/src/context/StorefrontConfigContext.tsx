'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { mergeTokens, applyTokens, type UiTheme } from '@journeyax/ui-cards';

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

export interface DynamicComponentConfig {
  productCard?: {
    layout?: 'standard' | 'technical' | 'compact';
    showBranchStock?: boolean;
    showSpecs?: boolean;
    badgeFields?: string[];
  };
  quoteCard?: {
    layout?: 'multi-trade-bom' | 'retail-summary';
    showTradeDiscounts?: boolean;
    fulfillmentOptions?: ('branch-pickup' | 'delivery' | 'trade-dispatch')[];
    defaultBranch?: string;
  };
  spacePlanner?: {
    enabled: boolean;
    roomTypes?: string[];
    defaultRoom?: string;
  };
  discoveryQuestions?: Array<{
    id: string;
    trigger: string;
    questions: string[];
    options?: string[];
  }>;
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
  /** CMS-driven dynamic components configuration */
  components?: DynamicComponentConfig | null;
  /** Multi-trade solution bundle templates */
  multiTradeBundles?: any[] | null;

  // ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ──────────────────
  /** Theme layers 1+2: `--jx-*` design tokens + per-card settings. */
  uiTheme?: UiTheme | null;
  /** Layer 3: tenant overrides of the platform default card templates,
   *  keyed by cardType (json-render spec). Consumed by `resolveTemplate`. */
  cardTemplates?: Record<string, { cardType: string; spec: unknown; variant?: string }> | null;
  /** How this tenant fulfils an order — the quote/cart card's branch picker
   *  reads this instead of a hardcoded branch list. */
  fulfilment?: FulfilmentConfig | null;
  /** Quote card copy (mapQuoteCard's sub/compliance) — config, not a
   *  `projectId === 'placemakers'` literal inside a shared panel. */
  quoteIntro?: string | null;
  complianceBadge?: string | null;
  /** Sample-customer demo picker (public profile list only; history is read server-side). */
  demoCustomers?: {
    label: string;
    disclaimer: string;
    profiles: { id: string; name: string; role: string; country: string | null; scenario: string | null; summary: string | null; tryAsking: string[] }[];
  } | null;
}

export interface FulfilmentConfig {
  mode?: 'delivery' | 'collect' | 'both';
  label?: string;
  badge?: string;
  branches?: { id: string; name: string; address?: string }[];
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
  components: null,
  multiTradeBundles: null,
  uiTheme: null,
  cardTemplates: null,
  fulfilment: null,
  quoteIntro: null,
  complianceBadge: null,
  demoCustomers: null,
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

/**
 * v3 Card CMS theming: emit `--jx-*` tokens for the card catalog. A tenant
 * that hasn't opened the theming studio yet has no `uiTheme.tokens` — derive
 * a sane one from the legacy `theme` block so cards still look on-brand
 * (primary→brand, accent→accent/text, font→display) rather than falling all
 * the way back to the platform's neutral defaults.
 */
/**
 * A tenant that HAS opened the theming studio (explicit `uiTheme.tokens`)
 * gets one theme, not two: the same tokens that skin the cards also drive
 * the storefront shell's own variables (page/surface/text/border/brand), so
 * a dark-brand site (Dragon Shield: charcoal page, black header, yellow
 * CTA) renders as itself instead of as light cards floating on a light
 * default page. Tenants without tokens keep the legacy `theme` mapping.
 * Text-on-brand and the user bubble follow the tokens too — a yellow CTA
 * with white text is the classic "exact colours, unreadable" failure.
 */
function applySiteVarsFromTokens(t: import('@journeyax/ui-cards').ThemeTokens) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  const c = t.colors;
  const set = (k: string, v?: string) => { if (v) root.setProperty(k, v); };
  set('--bg', c.bg); set('--surface', c.surface); set('--surface-alt', c.surfaceAlt); set('--surface-hover', c.muted);
  set('--stage-bg', c.surface);
  for (const k of ['--border', '--border-light', '--border-input', '--border-dark']) set(k, c.border);
  for (const k of ['--text', '--dark', '--text-body']) set(k, c.text);
  for (const k of ['--text-secondary', '--text-dim', '--text-dark-alt', '--text-muted', '--text-light', '--text-lighter', '--text-faint']) set(k, c.textMuted);
  set('--gold', c.brand); set('--gold-light', c.brand); set('--gold-text', c.brandText); set('--auto-text', c.accent);
  set('--chat-ai-bg', c.surfaceAlt); set('--chat-ai-border', c.border);
  set('--success', c.success); set('--warning', c.warning);
  set('--font-heading', t.font.display); set('--font-body', t.font.body);
  document.body.style.fontFamily = t.font.body;
  // Dark page: the default near-black user bubble/avatar would vanish into
  // it — carry the brand colour instead (how such sites accent on dark).
  const darkPage = !isLightHex(c.bg);
  const userBg = darkPage ? c.brand : c.inverse;
  const userText = darkPage ? c.brandText : c.inverseText;
  set('--chat-user-bg', userBg); set('--chat-user-text', userText);
  set('--avatar-bg', userBg); set('--avatar-text', userText);
  // The dark-header scope (.chat-panel[data-sidebar="dark"]) redefines the
  // bubble/avatar vars from the header colour; these --site-* values take
  // precedence there so tokens stay authoritative.
  set('--site-user-bg', userBg); set('--site-user-text', userText); set('--site-avatar-bg', userBg);
}

function applyCardTheme(uiTheme: UiTheme | null | undefined, legacyTheme: StorefrontConfig['theme']) {
  if (uiTheme?.tokens) {
    const merged = mergeTokens(uiTheme.tokens);
    applyTokens(merged);
    applySiteVarsFromTokens(merged);
    return;
  }
  const colors: Record<string, string> = {};
  if (legacyTheme.primaryColor) colors.brand = legacyTheme.primaryColor;
  if (legacyTheme.accentColor) {
    colors.accent = legacyTheme.accentColor;
    if (!isLightHex(legacyTheme.accentColor)) colors.text = legacyTheme.accentColor;
  }
  const derived: Record<string, unknown> = {};
  if (Object.keys(colors).length) derived.colors = colors;
  if (legacyTheme.fontFamily) derived.font = { display: legacyTheme.fontFamily };
  applyTokens(mergeTokens(derived as Partial<import('@journeyax/ui-cards').ThemeTokens>));
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
        applyCardTheme(c.uiTheme || null, c.theme || {});
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
