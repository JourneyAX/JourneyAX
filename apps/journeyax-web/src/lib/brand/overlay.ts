/**
 * A brand overlay: the same app shown under another name, logo and button colours, for a recording, a pitch or a website demo. It is switched
 * on by one setting (`BRAND_OVERLAY=ai-strategy` in the web app's environment) and changes nothing else: the shop's project, pack and data are
 * the ones already there, only what is drawn changes. With the setting off the app is exactly as it was.
 *
 * What it does: the project's name and the assistant's name are replaced; the logo is the overlay's; the action, link and panel-header colours
 * are the overlay's (backgrounds are left alone); and the original shop name is taken out of every piece of text the page shows (the config,
 * the assistant's replies, the sign-in screen), so "Build it right with PlaceMakers." reads "Build it right.".
 */

export interface BrandOverlay {
  id: string;
  /** The name shown where the project's name was (sign-in, sidebar when there is no logo, the avatar's initials). */
  companyName: string;
  /** The assistant's name above each reply, and in the footer line. */
  systemName: string;
  pageTitle: string;
  /** The shop names to take out of any text (whole words, exactly as written: an id or an address in lower case is not a name). */
  remove: string[];
  loginHeadline: string;
  loginTagline: string;
  /** Button, link and panel-header colours only. */
  colors: { action: string; actionText: string; link: string; canvasHeader: string; canvasHeaderText: string };
  /** The second brand colour, for small highlights (the New chat button, hover tints). */
  highlight: string;
}

export const AI_STRATEGY: BrandOverlay = {
  id: 'ai-strategy',
  companyName: 'AI strategy & enablement',
  systemName: 'The assistant',
  pageTitle: 'AI strategy & enablement',
  // The brand as it is written for people. Ids, addresses and links are lower case and are never touched.
  remove: ['PlaceMakers', 'Placemakers', 'PLACEMAKERS'],
  loginHeadline: 'Sign in to try the assistant.',
  loginTagline: 'See how an assistant that is connected to your systems, with people in control, can help one workflow at a time.',
  colors: { action: '#4545F5', actionText: '#FFFFFF', link: '#4545F5', canvasHeader: '#12121A', canvasHeaderText: '#FFFFFF' },
  highlight: '#C6FF00',
};

const OVERLAYS: Record<string, BrandOverlay> = { [AI_STRATEGY.id]: AI_STRATEGY };

/** The overlay named by `BRAND_OVERLAY`, or none (the usual case). */
export function overlayFromEnv(value: string | undefined = process.env.BRAND_OVERLAY): BrandOverlay | undefined {
  const key = String(value || '').trim().toLowerCase();
  return key ? OVERLAYS[key] : undefined;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Takes the names out of a piece of text and leaves it reading well: "with PlaceMakers", "at PlaceMakers" and "PlaceMakers's" go with the
 * name, and so does the space after a bare name. Line breaks are never touched.
 */
export function removeNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    const n = escapeRegex(name);
    out = out.replace(new RegExp(`[ \\t]+(?:with|at|from|by|for|of|to)[ \\t]+${n}(?:['\u2019]s)?\\b`, 'g'), '');
    out = out.replace(new RegExp(`\\b${n}['\u2019]s[ \\t]+`, 'g'), '');
    out = out.replace(new RegExp(`\\b${n}\\b[ \\t]*`, 'g'), '');
  }
  // Runs of spaces inside a line become one; the indentation at the start of a line stays (it says which list item sits under which).
  return out.replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/(\S)[ \t]+([.,;:!?])/g, '$1$2');
}

/** Every string inside a value (arrays and objects included, keys left alone) with the names taken out. */
export function removeNamesDeep<T>(value: T, names: readonly string[]): T {
  if (typeof value === 'string') return removeNames(value, names) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => removeNamesDeep(item, names)) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, removeNamesDeep(inner, names)])) as T;
  return value;
}

/** The storefront config as the page should receive it under this overlay. */
export function applyBrandOverlay<T extends Record<string, any>>(config: T, overlay: BrandOverlay): T & { brandOverlay: { id: string; companyName: string; loginHeadline: string; loginTagline: string; remove: string[]; highlight: string } } {
  const base: any = removeNamesDeep(config, overlay.remove);
  const tokens = base?.uiTheme?.tokens && typeof base.uiTheme.tokens === 'object' ? base.uiTheme.tokens : {};
  const colors = { ...(tokens.colors && typeof tokens.colors === 'object' ? tokens.colors : {}), ...overlay.colors, brand: overlay.colors.action, brandText: overlay.colors.actionText, accent: overlay.colors.link };
  return {
    ...base,
    companyName: overlay.companyName,
    systemName: overlay.systemName,
    // The logo is drawn by the page itself (a lockup, not a picture), so the picture is dropped; the colours come from the overlay.
    theme: { ...(base.theme || {}), logoUrl: undefined, primaryColor: overlay.colors.action, accentColor: overlay.colors.link },
    uiTheme: { ...(base.uiTheme || {}), tokens: { ...tokens, colors } },
    labels: { ...(base.labels || {}), headerTitle: overlay.loginHeadline },
    brandOverlay: { id: overlay.id, companyName: overlay.companyName, loginHeadline: overlay.loginHeadline, loginTagline: overlay.loginTagline, remove: overlay.remove, highlight: overlay.highlight },
  };
}

// ---- in the browser: the assistant's replies and cards are cleaned as they are drawn ---------------------------------------------------------
let activeNames: readonly string[] = [];

/** Called once the page has its config: the names to take out of every reply (none when the overlay is off). */
export function setRebrand(names: readonly string[] | undefined): void {
  activeNames = Array.isArray(names) ? names : [];
}

/** A piece of text for the screen: unchanged unless a brand overlay is on. */
export function rebrandText(text: string): string {
  return activeNames.length ? removeNames(text, activeNames) : text;
}

/**
 * An internal id shown to a person (the Personas page says which agent answers a team): unchanged normally; under a brand overlay the shop's
 * lower-case name is taken off the front and the rest is read as words ("placemakers_customer_service" becomes "customer service").
 */
export function readableId(id: string): string {
  if (!activeNames.length) return id;
  let out = id;
  for (const name of activeNames) out = out.replace(new RegExp(`^${escapeRegex(name.toLowerCase())}[_-]`), '');
  return out === id ? id : out.replace(/[_-]+/g, ' ');
}
