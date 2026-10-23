// Real-browser image downloader. Source list = Placemaker-data master only. One 300x300 image per product.
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const { chromium } = require(REPO + '/node_modules/playwright');
const fs = require('fs'), path = require('path');
const [, , MANIFEST, OUT, LIMIT, MODE] = process.argv;
const PAGE = 'https://www.placemakers.co.nz/online/timber-plywood/decking/hardwood-decking/decking-kwila-fsc/kwila-griptread-decking-fsc-100-x-25mm-90-x-19mm/p/1930650';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const items = fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const have = new Set(fs.readdirSync(OUT).filter((f) => !f.endsWith('.tmp')).map((f) => f.replace(/\.[a-z]+$/, '')));
const failedPath = path.join(OUT, '..', 'images-failed.jsonl');
const todo = items.filter((i) => !have.has(i.sku)).slice(0, LIMIT ? +LIMIT : undefined);
const ext = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : b.slice(0, 4).toString() === 'RIFF' ? 'webp' : null);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: MODE !== 'headful', args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const warm = async () => { await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(4000); };
  await warm();
  console.log(`start: ${todo.length} to fetch, ${have.size} already on disk, mode=${MODE || 'headless'}`);
  let ok = 0, dead = 0, blocked = 0, bytes = 0, backoff = 5000;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    let res;
    try {
      res = await page.evaluate(async (list) => {
        const out = []; let idx = 0;
        async function w() { while (idx < list.length) { const it = list[idx++]; try { const r = await fetch(it.url, { credentials: 'include' });
          if (r.status === 200) { const u = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let k = 0; k < u.length; k += 32768) s += String.fromCharCode.apply(null, u.subarray(k, k + 32768)); out.push({ sku: it.sku, status: 200, b64: btoa(s) }); }
          else out.push({ sku: it.sku, status: r.status }); } catch (e) { out.push({ sku: it.sku, status: 0 }); } } }
        await Promise.all([w(), w(), w(), w()]); return out; }, chunk);
    } catch (e) { console.log('evaluate failed, re-warming:', e.message.slice(0, 80)); await warm(); continue; }
    let blockedHere = 0;
    for (const r of res) {
      if (r.status === 200) { const b = Buffer.from(r.b64, 'base64'); const e = ext(b);
        if (e && b.length > 300) { fs.writeFileSync(path.join(OUT, r.sku + '.' + e), b); ok++; bytes += b.length; } else { dead++; fs.appendFileSync(failedPath, JSON.stringify({ sku: r.sku, status: 'not-image' }) + '\n'); } }
      else if (r.status === 404) { dead++; fs.appendFileSync(failedPath, JSON.stringify({ sku: r.sku, status: 404 }) + '\n'); }
      else { blockedHere++; }
    }
    if (blockedHere >= 5) { blocked += blockedHere; console.log(`blocked ${blockedHere}/${chunk.length} (waf?). pause ${backoff / 1000}s then re-warm`); await sleep(backoff); backoff = Math.min(backoff * 2, 300000); await warm(); i -= 40; if (backoff >= 300000 && blocked > 2000) { console.log('giving up for now'); break; } continue; }
    backoff = 5000;
    if ((i / 40) % 10 === 0) console.log(`${new Date().toISOString().slice(11, 19)} ok=${ok} dead=${dead} blocked=${blocked} MB=${(bytes / 1048576).toFixed(1)} rate=${(ok / ((Date.now() - t0) / 1000)).toFixed(1)}/s`);
    await sleep(150);
  }
  console.log(`done: ok=${ok} dead=${dead} blocked=${blocked} MB=${(bytes / 1048576).toFixed(1)}`);
  await browser.close();
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
