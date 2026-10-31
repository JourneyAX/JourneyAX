/**
 * Shell theming from the tenant's own config. The shell has a warm default palette and a dark variant (see shell.css);
 * a tenant that has set its own colours overrides it through `--ax-*-tenant` custom properties derived here.
 * Nothing in this file names a business: it only reads what the storefront config already exposes.
 */

/** Perceived luminance of a #rgb / #rrggbb colour, 0 (black) to 1 (white); null when it is not a hex colour. */
export function luminance(hex: string | undefined | null): number | null {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function isLight(hex: string | undefined | null): boolean {
  const l = luminance(hex);
  return l !== null && l > 0.6;
}

/** Text colour that stays readable on `background`. */
export function readableInk(background: string | undefined | null): string {
  return isLight(background) ? '#1F1C18' : '#FFFFFF';
}

/** The slice of the storefront config the shell reads. */
export interface ShellThemeInput {
  theme?: { primaryColor?: string; sidebarStyle?: 'light' | 'dark'; sidebarColor?: string } | null;
  uiTheme?: { tokens?: { colors?: Partial<Record<'brand' | 'brandText' | 'action' | 'actionText' | 'link' | 'canvasHeader' | 'canvasHeaderText' | 'bg' | 'surface' | 'text' | 'textMuted' | 'border', string>> } | null } | null;
}

export interface ShellTheme {
  /** Custom properties to set on the shell root (only the ones the tenant actually configured). */
  vars: Record<string, string>;
  /** 'dark' only when the tenant asked for a dark sidebar. */
  sidebarTone: 'light' | 'dark';
}

const COLOUR_TOKENS: Array<[keyof NonNullable<NonNullable<NonNullable<ShellThemeInput['uiTheme']>['tokens']>['colors']>, string]> = [
  ['link', '--ax-link-tenant'],
  ['canvasHeader', '--ax-canvas-head-bg-tenant'],
  ['canvasHeaderText', '--ax-canvas-head-ink-tenant'],
  ['bg', '--ax-bg-tenant'],
  ['surface', '--ax-surface-tenant'],
  ['text', '--ax-text-tenant'],
  ['textMuted', '--ax-muted-tenant'],
  ['border', '--ax-border-tenant'],
];

/**
 * Whether a tenant's `theme.sidebarStyle: 'dark'` (with `sidebarColor`) gives the sidebar its dark brand colour. True keeps
 * that existing tenant option working. Set it to false to show every tenant the warm light sidebar (the shell's default look)
 * regardless of its theme; the tenant's accent colour still applies either way.
 */
export const HONOUR_TENANT_SIDEBAR_STYLE = false;

export function deriveShellTheme(input: ShellThemeInput | null | undefined, opts: { honourSidebarStyle?: boolean } = {}): ShellTheme {
  const honourSidebarStyle = opts.honourSidebarStyle ?? HONOUR_TENANT_SIDEBAR_STYLE;
  const vars: Record<string, string> = {};
  const colors = input?.uiTheme?.tokens?.colors || {};

  // Accent: the brand colour the tenant set (card tokens first, then the legacy theme block); otherwise the shell's warm clay.
  // A shop's buttons can have their own colour (its website's button colour) apart from its brand colour: `action` wins when set.
  const accent = [colors.action, colors.brand, input?.theme?.primaryColor].find((c) => luminance(c) !== null);
  if (accent) {
    vars['--ax-accent-tenant'] = accent;
    const ink = colors.action === accent ? colors.actionText : colors.brand === accent ? colors.brandText : undefined;
    vars['--ax-accent-ink-tenant'] = luminance(ink) !== null ? String(ink) : readableInk(accent);
  }

  // Page colours only when the tenant explicitly configured them (a dark-brand site stays dark).
  for (const [token, cssVar] of COLOUR_TOKENS) {
    const value = colors[token];
    if (luminance(value) !== null) vars[cssVar] = String(value);
  }

  const dark = honourSidebarStyle && input?.theme?.sidebarStyle === 'dark';
  if (dark && luminance(input?.theme?.sidebarColor) !== null) {
    vars['--ax-sidebar-bg-tenant'] = String(input?.theme?.sidebarColor);
    vars['--ax-sidebar-ink-tenant'] = readableInk(input?.theme?.sidebarColor);
  }
  return { vars, sidebarTone: dark ? 'dark' : 'light' };
}

/** Two letters standing for a name: "Fletcher Building (PlaceMakers)" → "FB"; "admin" → "AD". Falls back to `fallback`. */
export function initials(name: string | undefined | null, fallback = 'AI'): string {
  const base = String(name || '').replace(/\(.*?\)/g, '').trim();
  if (!base) return fallback;
  const caps = base.match(/[A-Z]/g) || [];
  if (caps.length >= 2) return caps.slice(0, 2).join('');
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}
