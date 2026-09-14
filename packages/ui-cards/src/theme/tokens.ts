/**
 * Theme tokens — layer 1 of the tenant theme. Stored per project in Mongo
 * (`ProjectConfig.uiTheme.tokens`), emitted as `--jx-*` CSS variables at
 * runtime. Primitives ONLY read `--jx-*` vars, so a tenant can restyle every
 * card without touching code.
 */
export interface ThemeTokens {
  colors: {
    bg: string;          // page / stage background
    surface: string;     // card surface
    surfaceAlt: string;  // secondary surface
    muted: string;       // muted fill (chips, table stripes)
    border: string;
    text: string;
    textMuted: string;
    brand: string;       // primary brand colour (CTA)
    brandText: string;   // text on brand
    accent: string;      // secondary accent (links, eyebrow)
    success: string;
    warning: string;
    danger: string;
    inverse: string;     // dark surface
    inverseText: string;
  };
  font: {
    display: string;
    body: string;
    mono: string;
  };
  radius: { sm: string; md: string; lg: string; pill: string };
  shadow: { sm: string; md: string; lg: string };
  space: { xs: string; sm: string; md: string; lg: string; xl: string };
  /** Free-form extras a tenant may reference from templates via style tokens. */
  extra?: Record<string, string>;
}

export const DEFAULT_TOKENS: ThemeTokens = {
  colors: {
    bg: '#F4F1EC',
    surface: '#FFFFFF',
    surfaceAlt: '#FCFBF7',
    muted: '#F3EFE7',
    border: '#E7E2D8',
    text: '#17140F',
    textMuted: '#6B655B',
    brand: '#17140F',
    brandText: '#F7F4EE',
    accent: '#A67C4E',
    success: '#4E7C59',
    warning: '#B8860B',
    danger: '#A63244',
    inverse: '#17140F',
    inverseText: '#F7F4EE',
  },
  font: {
    display: "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
    body: "'DM Sans', system-ui, -apple-system, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  radius: { sm: '6px', md: '12px', lg: '20px', pill: '999px' },
  shadow: {
    sm: '0 1px 3px rgba(20,20,19,0.06)',
    md: '0 6px 18px rgba(11,42,86,0.08)',
    lg: '0 14px 40px rgba(11,42,86,0.16)',
  },
  space: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '40px' },
};

/** Deep-merge a partial tenant token set over the defaults. */
export function mergeTokens(partial?: Partial<ThemeTokens> | null): ThemeTokens {
  if (!partial) return DEFAULT_TOKENS;
  const out: any = { ...DEFAULT_TOKENS };
  for (const k of Object.keys(DEFAULT_TOKENS) as (keyof ThemeTokens)[]) {
    const base = (DEFAULT_TOKENS as any)[k];
    const over = (partial as any)[k];
    out[k] = over && typeof over === 'object' && !Array.isArray(over) ? { ...base, ...over } : (over ?? base);
  }
  if (partial.extra) out.extra = { ...(DEFAULT_TOKENS.extra || {}), ...partial.extra };
  return out as ThemeTokens;
}

/** Flatten tokens into `--jx-*` CSS custom properties. */
export function tokensToCssVars(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(tokens.colors)) vars[`--jx-color-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(tokens.font)) vars[`--jx-font-${k}`] = v;
  for (const [k, v] of Object.entries(tokens.radius)) vars[`--jx-radius-${k}`] = v;
  for (const [k, v] of Object.entries(tokens.shadow)) vars[`--jx-shadow-${k}`] = v;
  for (const [k, v] of Object.entries(tokens.space)) vars[`--jx-space-${k}`] = v;
  for (const [k, v] of Object.entries(tokens.extra || {})) vars[`--jx-x-${kebab(k)}`] = v;
  return vars;
}

/** Serialise vars as an inline `style` attribute string or a `:root{}` block. */
export function cssVarsToString(vars: Record<string, string>, selector?: string): string {
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
  return selector ? `${selector}{${body}}` : body;
}

/** Apply tokens to a DOM element (client only). */
export function applyTokens(tokens: ThemeTokens, el?: HTMLElement | null): void {
  if (typeof document === 'undefined') return;
  const target = el || document.documentElement;
  for (const [k, v] of Object.entries(tokensToCssVars(tokens))) target.style.setProperty(k, v);
}

/** Card settings — layer 2. Which cards are on, which variant, label overrides. */
export interface CardSettings {
  enabled?: boolean;
  variant?: string;
  labels?: Record<string, string>;
  /** Per-card knobs a template can read via `$state: /settings/...` */
  options?: Record<string, unknown>;
}

export interface UiTheme {
  tokens?: Partial<ThemeTokens>;
  cards?: Record<string, CardSettings>;
  /** Layout knobs for the storefront shell. */
  layout?: {
    chatWidth?: string;          // e.g. '40%'
    focusMode?: 'floating-bar' | 'split';
    commandBar?: { placeholder?: string; primaryAction?: string; voice?: boolean };
    stageMaxWidth?: string;
  };
}
