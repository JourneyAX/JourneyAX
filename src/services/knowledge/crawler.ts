import FirecrawlApp from '@mendable/firecrawl-js';
import { CrawlConfig, CrawledPage } from './types';

/**
 * Crawl a website using Firecrawl API.
 * Returns all crawled pages as markdown + metadata.
 */
export async function crawlSite(config: CrawlConfig): Promise<CrawledPage[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set in environment');

  const app = new FirecrawlApp({ apiKey });

  console.log(`🔥 Starting Firecrawl crawl of ${config.catalogUrl}`);
  console.log(`   Max pages: ${config.maxPages || 200}`);
  if (config.includePaths) {
    console.log(`   Include paths: ${config.includePaths.join(', ')}`);
  }

  const crawlResult = await app.crawlUrl(config.catalogUrl, {
    limit: config.maxPages || 200,
    scrapeOptions: {
      formats: ['markdown'],
      waitFor: 3000,
    },
    ...(config.includePaths ? { includePaths: config.includePaths } : {}),
    ...(config.excludePaths ? { excludePaths: config.excludePaths } : {}),
  });

  // Handle both response shapes from Firecrawl SDK
  const data = Array.isArray(crawlResult)
    ? crawlResult
    : crawlResult?.data
      ? crawlResult.data
      : [];

  if (!data || data.length === 0) {
    console.warn('⚠️  No data returned from crawl');
    console.log('   Raw result keys:', Object.keys(crawlResult || {}));
    return [];
  }

  const pages: CrawledPage[] = [];

  for (const page of data) {
    const markdown = page.markdown || '';
    if (markdown.trim().length < 50) continue;

    const meta = page.metadata || {};
    pages.push({
      url: meta.sourceURL || meta.url || '',
      title: meta.title || extractTitleFromMarkdown(markdown),
      markdown,
      metadata: meta,
    });
  }

  console.log(`✅ Crawled ${pages.length} pages from ${config.catalogUrl}`);
  return pages;
}

/**
 * Scrape a single URL using Firecrawl.
 */
export async function scrapePage(url: string): Promise<CrawledPage | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set in environment');

  const app = new FirecrawlApp({ apiKey });

  try {
    const result = await app.scrapeUrl(url, {
      formats: ['markdown'],
      waitFor: 3000,
    });

    const markdown = result?.markdown || '';
    if (markdown.trim().length < 50) {
      console.warn(`   Skipping ${url} — too little content`);
      return null;
    }

    const meta = result?.metadata || {};
    return {
      url,
      title: meta.title || extractTitleFromMarkdown(markdown),
      markdown,
      metadata: meta,
    };
  } catch (err) {
    console.error(`   Error scraping ${url}:`, err);
    return null;
  }
}

/**
 * Scrape multiple URLs individually (for deeper product pages).
 * More reliable than crawl for JS-heavy product listing sites.
 */
export async function scrapeUrls(
  urls: string[],
  concurrency: number = 3
): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  let completed = 0;

  // Process in batches for rate limiting
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(url => scrapePage(url))
    );

    for (const result of results) {
      completed++;
      if (result.status === 'fulfilled' && result.value) {
        pages.push(result.value);
      }
    }

    console.log(`   Progress: ${completed}/${urls.length} URLs scraped (${pages.length} pages collected)`);

    // Rate limit delay between batches
    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return pages;
}

/**
 * Map a site to discover all pages before scraping.
 */
export async function mapSite(url: string): Promise<string[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set in environment');

  const app = new FirecrawlApp({ apiKey });

  try {
    const result = await app.mapUrl(url);

    // Firecrawl returns link objects, not bare strings. The previous `as any`
    // hid that: this function promises string[] and was handing back objects,
    // so every consumer stringified them into "[object Object]".
    const links = (result?.links ?? [])
      .map(entry => (typeof entry === 'string' ? entry : entry?.url))
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    console.log(`🗺️  Mapped ${links.length} URLs from ${url}`);
    return links;
  } catch (err) {
    console.error(`Error mapping ${url}:`, err);
    return [];
  }
}

/**
 * Extract title from the first heading in markdown content.
 */
function extractTitleFromMarkdown(markdown: string): string {
  const headingMatch = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  const firstLine = markdown.split('\n').find(l => l.trim().length > 0);
  return firstLine?.trim().slice(0, 100) || 'Untitled';
}
