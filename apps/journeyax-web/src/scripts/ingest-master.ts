import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

// Load .env.local if present, otherwise .env (dotenv won't override already-set vars).
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { getCollection, insertDocuments, closeConnection } from '../services/knowledge/mongo';
import { chunkContent } from '../services/knowledge/chunker';
import { embedTexts } from '../services/knowledge/embedder';
import { extractProductMetadata } from '../services/knowledge/classifier';
import { KnowledgeDocument, DocumentMetadata } from '../services/knowledge/types';

const BRAND = 'caroma';
const GWA_PDF_DIR = path.resolve(process.cwd(), '..', 'GWA', 'Technical_PDFs');
if (!fs.existsSync(GWA_PDF_DIR)) {
  fs.mkdirSync(GWA_PDF_DIR, { recursive: true });
}

const downloadedPdfs = new Set(fs.readdirSync(GWA_PDF_DIR).filter(f => f.endsWith('.pdf')));

async function main() {
  console.log('🗺️ Step 1: Discovering URLs...');
  
  const seedUrls = [
    'https://www.caroma.com/au/conditions-of-sale/',
    'https://www.caroma.com/au/caroma-warranties/',
    'https://www.caroma.com/au/bathroom-accessories/',
    'https://www.caroma.com/au/dorf/',
    'https://www.caroma.com/au/bathroom/',
    'https://www.caroma.com/au/kitchen-laundry/',
    'https://www.caroma.com/au/design-planning/',
    'https://www.caroma.com/au/independent-living/'
  ];

  const uniqueUrls = new Set<string>(seedUrls);

  // Fetch product sitemap
  try {
    const sitemapRes = await fetch('https://www.caroma.com/au/sitemap-products.xml');
    if (sitemapRes.ok) {
        const text = await sitemapRes.text();
        const matches = text.match(/<loc>(.*?)<\/loc>/g);
        if (matches) {
            matches.forEach(m => {
                const url = m.replace('<loc>', '').replace('</loc>', '').trim();
                if (url.startsWith('http')) uniqueUrls.add(url);
            });
        }
        console.log(`Found ${matches?.length || 0} product URLs in sitemap.`);
    } else {
        console.warn(`Failed to fetch sitemap: ${sitemapRes.status}`);
    }
  } catch (e) {
      console.error("Error fetching sitemap", e);
  }

  // Add design / renovation-guide / collection / concept URLs from the static sitemap
  try {
    const staticPath = path.resolve(process.cwd(), 'data/sitemap-static.txt');
    if (fs.existsSync(staticPath)) {
      const staticUrls = fs.readFileSync(staticPath, 'utf-8')
        .split('\n').map(l => l.trim()).filter(u => u.startsWith('http'));
      staticUrls.forEach(u => uniqueUrls.add(u));
      console.log(`Added ${staticUrls.length} design/static URLs from sitemap-static.txt`);
    }
  } catch (e) { console.warn('static sitemap read failed', e); }

  let urlList = Array.from(uniqueUrls);
  console.log(`Total URLs found: ${urlList.length}`);
  // --limit N → test batch: N products + up to 3 design/category pages
  const limitArg = process.argv.indexOf('--limit');
  const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;
  if (LIMIT > 0) {
    const products = urlList.filter(u => u.toLowerCase().includes('/product/'));
    const others = urlList.filter(u => !u.toLowerCase().includes('/product/'));
    urlList = [...products.slice(0, LIMIT), ...others.slice(0, 3)];
    console.log(`⚠️  TEST BATCH: limited to ${urlList.length} URLs (${Math.min(LIMIT, products.length)} products + designs)`);
  }
  console.log(`Total URLs to process: ${urlList.length}`);

  console.log('\n🚀 Step 2: Launching Master Playwright Scraper...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let pdfsDownloaded = 0;
  let pagesScraped = 0;

  for (let i = 0; i < urlList.length; i++) {
    const url = urlList[i];
    console.log(`\n[${i+1}/${urlList.length}] Scraping: ${url}`);
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500); // Wait for React components

      // Capture the full rendered HTML (with JSON-LD script tags) BEFORE the
      // in-page evaluate strips <script>/<header> etc. — this is where the clean
      // product data (sku, price, specs, variants, docs) lives.
      const html = await page.content();

      const pageData = await page.evaluate(() => {
        // Extract images before removing elements
        const imageElements = Array.from(document.querySelectorAll('img'));
        const imageUrls = imageElements
          .map(img => img.src)
          .filter(src => src && src.includes('cdn.caroma.com') && !src.includes('logo') && !src.includes('icon'));

        const elementsToRemove = document.querySelectorAll('header, footer, nav, script, style, iframe, noscript');
        elementsToRemove.forEach(el => el.remove());

        const anchors = Array.from(document.querySelectorAll('a'));
        const pdfLinks = anchors
          .map(a => a.href)
          .filter(href => href && href.toLowerCase().endsWith('.pdf'));

        const mainContent = document.querySelector('main') || document.body;
        let text = mainContent.innerText.trim();
        const title = document.title;

        // Append image URLs to the text so they get embedded and are retrievable by the AI
        const uniqueImages = [...new Set(imageUrls)];
        if (uniqueImages.length > 0) {
            text += `\n\n--- Product Images ---\n` + uniqueImages.join('\n');
        }

        return { text, title, pdfLinks: [...new Set(pdfLinks)], images: uniqueImages };
      });

      if (!pageData.text || pageData.text.length < 50) {
          console.log(`  -> Skipping: Too little text content.`);
          continue;
      }

      // Classify the page type first (needed by the re-ingest condition below).
      const lowerUrl = url.toLowerCase();
      let type: any = 'general';
      if (lowerUrl.includes('/product/')) type = 'product';
      else if (lowerUrl.includes('/dorf/')) type = 'product';
      else if (lowerUrl.includes('renovation-guide') || lowerUrl.includes('/collection') || lowerUrl.includes('/design')) type = 'design';
      else if (lowerUrl.includes('independent-living') || lowerUrl.includes('livewell')) type = 'design';
      else if (lowerUrl.includes('warranties')) type = 'policy';
      else if (lowerUrl.includes('conditions')) type = 'policy';

      // Check if already in DB to avoid dupes on restart
      const col = await getCollection();
      const existing = await col.findOne({ "metadata.url": url, type: { $ne: "troubleshooting" } });

      // Re-ingest when: no entry, no image marker, --force, OR (product) the old
      // doc is missing the structured JSON-LD metadata (sku/specs) — so shallow
      // docs get upgraded with real specs/variants/image/docs.
      const FORCE = process.argv.includes('--force');
      const hasImages = existing ? existing.content.includes('--- Product Images ---') : false;
      // Caroma exposes no stock/availability in JSON-LD or DOM (manufacturer, not
      // D2C), so trigger re-ingest only on missing structured specs.
      const missingStructured = existing && type === 'product' && !existing.metadata?.specs;
      const designNeedsType = existing && type === 'design' && existing.metadata?.type !== 'design';

      if (!existing || !hasImages || missingStructured || designNeedsType || FORCE) {
          if (existing) {
              console.log(`  -> Re-ingesting to add structured product data (specs/variants/image/docs)...`);
              // Delete only the page's own text chunk(s). PRESERVE the vectorised
              // technical/troubleshooting PDF chunks mapped to this url — they are
              // NOT re-downloaded once on disk, so deleting them loses coverage.
              await col.deleteMany({
                "metadata.url": url,
                "metadata.type": { $nin: ["technical", "troubleshooting"] },
              });
          }

          const meta: DocumentMetadata = { type, brand: BRAND, url };
          // Recover the clean product data from the page's JSON-LD (sku, price,
          // specs, variants, real PIM image, install/CAD docs).
          if (type === 'product') {
            Object.assign(meta, extractProductMetadata(pageData.text, html));
          }
          const pageChunks = chunkContent(pageData.text, pageData.title, url, meta);
          
          if (pageChunks.length > 0) {
              const pageEmbeddings = await embedTexts(pageChunks.map(c => c.text));
              const now = new Date();
              const pageDocs: KnowledgeDocument[] = pageChunks.map((chunk, j) => ({
                brand: BRAND,
                sourceUrl: chunk.sourceUrl,
                title: pageData.title,
                content: chunk.text,
                chunk: chunk.text,
                chunkIndex: chunk.index,
                metadata: chunk.metadata,
                embedding: pageEmbeddings[j],
                crawledAt: now,
                updatedAt: now,
              }));
              await insertDocuments(pageDocs);
              console.log(`  -> Ingested ${pageChunks.length} text chunks for page.`);
              pagesScraped++;
          }
      } else {
          console.log(`  -> Page text already in DB, skipping text ingestion.`);
      }

      // 2. Extract and Ingest PDFs
      for (const pdfUrl of pageData.pdfLinks) {
        const filename = decodeURIComponent(pdfUrl.split('/').pop() || 'unknown.pdf').replace(/[^a-zA-Z0-9.\-_]/g, '_');
        
        if (downloadedPdfs.has(filename)) continue;

        console.log(`  -> Found NEW PDF: ${filename}`);
        const destPath = path.join(GWA_PDF_DIR, filename);
        
        try {
          const response = await fetch(pdfUrl);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(destPath, buffer);
            downloadedPdfs.add(filename);
            
            const text = execSync(`pdftotext "${destPath}" -`, { encoding: 'utf-8' }).trim();
            if (text.length > 50) {
                const lower = filename.toLowerCase();
                let pdfType: any = 'technical';
                if (lower.includes('troubleshoot') || lower.includes('is2105')) pdfType = 'troubleshooting';

                const pdfMeta: DocumentMetadata = { type: pdfType, brand: BRAND, url };
                const pdfTitle = `Technical Document: ${filename}`;
                const pdfChunks = chunkContent(text, filename, url, pdfMeta);
                const pdfEmbeddings = await embedTexts(pdfChunks.map(c => c.text));

                const now = new Date();
                const newDocs: KnowledgeDocument[] = pdfChunks.map((chunk, j) => ({
                  brand: BRAND,
                  sourceUrl: chunk.sourceUrl,
                  title: pdfTitle,
                  content: chunk.text,
                  chunk: chunk.text,
                  chunkIndex: chunk.index,
                  metadata: chunk.metadata,
                  embedding: pdfEmbeddings[j],
                  crawledAt: now,
                  updatedAt: now,
                }));

                await insertDocuments(newDocs);
                console.log(`    -> Ingested ${pdfChunks.length} chunks from PDF.`);
                pdfsDownloaded++;
            }
          }
        } catch (downloadErr: any) {
          console.error(`  -> Failed to download PDF ${pdfUrl}: ${downloadErr.message}`);
        }
      }

    } catch (e: any) {
      console.log(`  -> Failed to process page: ${e.message}`);
    }
  }

  await browser.close();
  await closeConnection();
  console.log(`\n🎉 Master Scrape Complete!`);
  console.log(`   Scraped Text Pages: ${pagesScraped}`);
  console.log(`   New PDFs Ingested: ${pdfsDownloaded}`);
}

main().catch(console.error);
