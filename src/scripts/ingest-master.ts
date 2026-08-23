import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { getCollection, insertDocuments, closeConnection } from '../services/knowledge/mongo';
import { chunkContent } from '../services/knowledge/chunker';
import { embedTexts } from '../services/knowledge/embedder';
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

  const urlList = Array.from(uniqueUrls);
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

      // Check if already in DB to avoid dupes on restart
      const col = await getCollection();
      const existing = await col.findOne({ "metadata.url": url, type: { $ne: "troubleshooting" } });
      
      // If the old entry doesn't have images, we want to delete it and re-ingest
      const hasImages = existing ? existing.content.includes('--- Product Images ---') : false;

      if (!existing || !hasImages) {
          if (existing) {
              console.log(`  -> Upgrading old entry to include images...`);
              await col.deleteMany({ "metadata.url": url, type: { $ne: "troubleshooting" } });
          }

          const lowerUrl = url.toLowerCase();
          let type: any = 'general';
          if (lowerUrl.includes('/product/')) type = 'product';
          else if (lowerUrl.includes('/dorf/')) type = 'product';
          else if (lowerUrl.includes('warranties')) type = 'policy';
          else if (lowerUrl.includes('conditions')) type = 'policy';

          const meta: DocumentMetadata = { type, brand: BRAND, url };
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
