/**
 * Brand probe — turn a customer's URL into the starting shape of a project.
 *
 * Fetches ONE page (the site root) and reads what the site already declares
 * about itself: name, logo, theme colour, and where its machine-readable
 * catalogue lives. Everything here is a *suggestion* for an operator to confirm
 * in the onboarding UI — nothing is auto-applied, because a wrong logo or brand
 * colour is very visible and the site may not be the customer's to represent.
 *
 * Deliberately dependency-free (no browser): a single HTML GET plus a HEAD on
 * sitemap.xml. Playwright is reserved for product extraction, where JS matters.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export interface BrandProbe {
  url: string;
  siteName?: string;
  description?: string;
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  /** Machine-readable catalogue entry points found on the site. */
  sitemapUrl?: string;
  /** Ready-to-confirm ingestion sources — the operator edits before saving. */
  suggestedSources: { type: string; label: string; sitemapUrl?: string; url?: string; role?: string }[];
  warnings: string[];
}

/** Decode HTML entities, repeatedly — source markup is often double-escaped
 *  ("&amp;amp;"), which would otherwise reach the UI verbatim. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  let out = s, prev = '';
  for (let i = 0; i < 3 && out !== prev; i++) {
    prev = out;
    out = out.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      const key = code.toLowerCase();
      if (named[key]) return named[key];
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16) || 0) || m;
      if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10) || 0) || m;
      return m;
    });
  }
  return out.trim();
}

/** A <title> is usually an SEO string ("Brand | tagline | keywords"); the brand
 *  is the leading segment. Only used when the site declares no proper name. */
function brandFromTitle(title: string): string {
  return decodeEntities(title).split(/\s[|–—-]\s/)[0].trim().slice(0, 80);
}

function abs(href: string, base: string): string | undefined {
  if (!href) return undefined;
  try { return new URL(href, base).toString(); } catch { return undefined; }
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

/** Collect <meta>/<link> tags without a DOM parser. */
function tags(html: string, el: 'meta' | 'link'): string[] {
  return html.match(new RegExp(`<${el}\\b[^>]*>`, 'gi')) || [];
}

function metaContent(html: string, keys: string[]): string | undefined {
  for (const t of tags(html, 'meta')) {
    const key = (attr(t, 'property') || attr(t, 'name') || '').toLowerCase();
    if (keys.includes(key)) {
      const c = attr(t, 'content');
      if (c && c.trim()) return c.trim();
    }
  }
  return undefined;
}

/** JSON-LD Organization is the most reliable logo source when a site publishes it. */
function fromJsonLd(html: string, base: string): { name?: string; logo?: string } {
  const out: { name?: string; logo?: string } = {};
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of (Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])])) {
        if (!node || typeof node !== 'object') continue;
        const type = String(node['@type'] || '');
        if (!/Organization|WebSite|Brand/i.test(type)) continue;
        if (!out.name && node.name) out.name = String(node.name);
        const logo = typeof node.logo === 'string' ? node.logo : node.logo?.url;
        if (!out.logo && logo) out.logo = abs(String(logo), base);
      }
    } catch { /* a malformed block shouldn't abort the probe */ }
  }
  return out;
}

export async function probeBrand(rawUrl: string, timeoutMs = 15000): Promise<BrandProbe> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const probe: BrandProbe = { url, suggestedSources: [], warnings: [] };

  let html = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok) {
      probe.warnings.push(res.status === 403 || res.status === 429
        ? `Site returned HTTP ${res.status} — it blocks automated requests, so brand details must be entered manually.`
        : `Site returned HTTP ${res.status}.`);
      return probe;
    }
    html = (await res.text()).slice(0, 400_000);
  } catch (e) {
    probe.warnings.push(`Could not reach the site: ${(e as Error).message}`);
    return probe;
  }

  const ld = fromJsonLd(html, url);
  const declaredName = ld.name || metaContent(html, ['og:site_name', 'application-name']);
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  probe.siteName = declaredName ? decodeEntities(declaredName) : (title ? brandFromTitle(title) : undefined);
  const desc = metaContent(html, ['og:description', 'description']);
  probe.description = desc ? decodeEntities(desc) : undefined;
  // Only a hex value is useful downstream — the theme colour feeds a colour
  // picker, and a CSS keyword ("white") would silently break it.
  const themeColor = metaContent(html, ['theme-color', 'msapplication-tilecolor']);
  if (themeColor && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(themeColor.trim())) {
    probe.primaryColor = `#${themeColor.trim().replace(/^#/, '')}`.toLowerCase();
  }

  // Logo: prefer a declared Organization logo, then apple-touch-icon (usually the
  // highest-quality square mark), then any icon link. NOT og:image — that is
  // typically a hero/product shot, not the brand mark.
  probe.logoUrl = ld.logo;
  for (const t of tags(html, 'link')) {
    const rel = (attr(t, 'rel') || '').toLowerCase();
    const href = abs(attr(t, 'href') || '', url);
    if (!href) continue;
    if (!probe.logoUrl && rel.includes('apple-touch-icon')) probe.logoUrl = href;
    if (!probe.faviconUrl && rel.includes('icon')) probe.faviconUrl = href;
  }
  if (!probe.logoUrl && !probe.faviconUrl) probe.warnings.push('No logo or icon declared — add one manually.');

  // Catalogue entry point: a sitemap is the cheapest reliable crawl seed.
  const sitemap = `${new URL(url).origin}/sitemap.xml`;
  try {
    const r = await fetch(sitemap, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (r.ok) probe.sitemapUrl = sitemap;
  } catch { /* absence is normal, not an error */ }

  if (probe.sitemapUrl) {
    probe.suggestedSources.push({ type: 'html', label: 'Website catalogue', sitemapUrl: probe.sitemapUrl, role: 'product' });
  } else {
    probe.suggestedSources.push({ type: 'html', label: 'Website catalogue', url, role: 'product' });
    probe.warnings.push('No sitemap.xml found — crawling will start from the homepage.');
  }

  return probe;
}
