/**
 * Parsers for scraped Caroma product pages.
 *
 * These extract the specifications table and the image URLs out of the flat
 * text a scrape produces, so the model can pass them straight into
 * `showProducts` instead of inventing them.
 *
 * **They are positional string-slicing against one site's page layout, and
 * they will break when that layout changes.** That is not a flaw to be fixed
 * so much as a property to be watched: the alternative is a real structured
 * feed, which does not exist yet. Lifted out of `api/chat/route.ts` so the
 * breakage is at least detectable — a parser with no tests fails silently, and
 * silently means the model starts answering with no specs and nobody notices.
 */

/** Sanity ceilings, so a malformed page cannot produce absurd output. */
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 100;
const MAX_SPECS = 40;
const MAX_IMAGES = 12;

const IMAGE_MARKER = '--- Product Images ---';

/**
 * Pull a `Specifications` block out of scraped page text.
 *
 * The scrape flattens a two-column table into alternating lines, so this
 * walks them in pairs. Returns `{}` rather than throwing when the block is
 * absent — a page without specs is normal, not an error.
 */
export function parseSpecs(content: string): Record<string, string> {
  const specs: Record<string, string> = {};
  if (typeof content !== 'string' || !content) return specs;

  const specsIdx = content.indexOf('Specifications');
  if (specsIdx === -1) return specs;

  // The table ends where the downloads section begins, when there is one.
  const techDownloadsIdx = content.indexOf('Technical Downloads', specsIdx);
  const specsText = techDownloadsIdx !== -1
    ? content.substring(specsIdx, techDownloadsIdx)
    : content.substring(specsIdx);

  const lines = specsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Start at 1: line 0 is the "Specifications" heading itself.
  for (let i = 1; i < lines.length - 1; i += 2) {
    if (Object.keys(specs).length >= MAX_SPECS) break;

    const key = lines[i];
    const val = lines[i + 1];

    // "Product Codes" is a list, not a spec, and a purely numeric key or
    // value means the pairing has slipped out of alignment.
    if (key === 'Product Codes' || /^\d+[A-Z\d]*$/.test(key) || /^\d+[A-Z\d]*$/.test(val)) {
      continue;
    }

    // Reject anything that looks like markup or a URL rather than a label.
    if (
      key.length < MAX_KEY_LENGTH &&
      !key.includes('[') &&
      !key.includes('http') &&
      val.length < MAX_VALUE_LENGTH
    ) {
      specs[key] = val;
    }
  }

  return specs;
}

/**
 * Pull image URLs out of scraped page text.
 *
 * Prefers the explicit `--- Product Images ---` marker the scraper appends.
 * Falls back to scanning for CDN URLs, which is how pages scraped before the
 * marker existed still yield images.
 */
export function parseImages(content: string): string[] {
  if (typeof content !== 'string' || !content) return [];

  const idx = content.indexOf(IMAGE_MARKER);

  if (idx === -1) {
    // Real product photos live on the PIM blob storage host; cdn.caroma.com
    // only serves site-wide logos/icons, so both are worth catching here.
    const images: string[] = [];
    const cdnRegex = /(https?:\/\/[^\s"']*(?:cdn\.[^\s"']+|pim-assets\/ProductThumbnail\/[^\s"']+)\.(?:jpg|jpeg|png|webp|avif)[^\s"']*)/gi;
    let match: RegExpExecArray | null;
    while ((match = cdnRegex.exec(content)) !== null) {
      if (!images.includes(match[1])) images.push(match[1]);
      if (images.length >= MAX_IMAGES) break;
    }
    return images;
  }

  return content
    .substring(idx + IMAGE_MARKER.length)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('http'))
    // The marker section can repeat a hero image; the model only needs one.
    .filter((url, i, all) => all.indexOf(url) === i)
    .slice(0, MAX_IMAGES);
}
