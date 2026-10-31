// Second pass: for products whose crawl image link is dead (404), read today's image link from the live product page, then fetch it.
// Source of product page addresses: the Placemaker-data master only. Same real-browser approach as download.cjs.
//   node repair.cjs <failed.jsonl> <outDir> [limit]
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const { chromium } = require(REPO + '/node_modules/playwright');
const fs = require('fs'), path = require('path');
const [, , FAILED, OUT, LIMIT] = process.argv;
const DATA = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/jax-whatsapp-open-model/Placemaker-data';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ext = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : b.slice(0, 4).toString() === 'RIFF' ? 'webp' : null);
function eachLine(file, cb) { return new Promise((res, rej) => { let rest = ''; const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }); const take = (l) => { if (l) cb(l); }; rs.on('data', (d) => { rest += d; let i; while ((i = rest.indexOf('\n')) >= 0) { take(rest.slice(0, i)); rest = rest.slice(i + 1); } }); rs.on('end', () => { take(rest); res(); }); rs.on('error', rej); }); }
(async () => {
  const dead = new Set(fs.readFileSync(FAILED, 'utf8').split('\n').filter(Boolean).map((l) => String(JSON.parse(l).sku)));
  const have = new Set(fs.readdirSync(OUT).map((f) => f.replace(/\.[a-z]+$/, '')));
  const pages = new Map();
  await eachLine(DATA + '/master/placemakers_product_master.jsonl', (l) => { try { const o = JSON.parse(l); const s = String(o.sku); if (dead.has(s) && !have.has(s) && (o.pageUrl || o.url)) pages.set(s, o.pageUrl || o.url); } catch {} });
  const todo = [...pages.entries()].slice(0, LIMIT ? +LIMIT : undefined);
  console.log(`dead links: ${dead.size}; with a product page to try: ${todo.length}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const page = await (await browser.newContext()).newPage();
  const warm = async () => { await page.goto('https://www.placemakers.co.nz/online/trade', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(4000); };
  await warm();
  let ok = 0, nopage = 0, noimg = 0, blocked = 0, bytes = 0; const t0 = Date.now(); let backoff = 5000;
  const still = fs.createWriteStream(path.join(OUT, '..', 'images-unrepairable.jsonl'), { flags: 'a' });
  for (let i = 0; i < todo.length; i += 12) {
    const chunk = todo.slice(i, i + 12);
    let res;
    try {
      res = await page.evaluate(async (list) => {
        const out = []; let idx = 0;
        async function w() { while (idx < list.length) { const [sku, url] = list[idx++]; try {
          const r = await fetch(url, { credentials: 'include' });
          if (r.status !== 200) { out.push({ sku, status: r.status }); continue; }
          const html = await r.text(); const m = html.match(/\/online\/medias\/300Wx300H-null\?context=[A-Za-z0-9+\/=_-]+/);
          if (!m) { out.push({ sku, status: 'noimg' }); continue; }
          const ir = await fetch(m[0], { credentials: 'include' });
          if (ir.status !== 200) { out.push({ sku, status: 'img' + ir.status }); continue; }
          const u = new Uint8Array(await ir.arrayBuffer()); let s = ''; for (let k = 0; k < u.length; k += 32768) s += String.fromCharCode.apply(null, u.subarray(k, k + 32768));
          out.push({ sku, status: 200, b64: btoa(s) }); } catch (e) { out.push({ sku, status: 0 }); } } }
        await Promise.all([w(), w(), w()]); return out; }, chunk);
    } catch (e) { await warm(); continue; }
    let bl = 0;
    for (const r of res) {
      if (r.status === 200) { const b = Buffer.from(r.b64, 'base64'); const e = ext(b); if (e && b.length > 300) { fs.writeFileSync(path.join(OUT, r.sku + '.' + e), b); ok++; bytes += b.length; } else noimg++; }
      else if (r.status === 'noimg' || r.status === 404 || r.status === 'img404') { noimg++; still.write(JSON.stringify({ sku: r.sku, status: r.status }) + '\n'); }
      else bl++;
    }
    if (bl >= 4) { blocked += bl; console.log(`blocked ${bl}/${chunk.length}; pause ${backoff / 1000}s`); await sleep(backoff); backoff = Math.min(backoff * 2, 300000); await warm(); i -= 12; if (backoff >= 300000 && blocked > 500) break; continue; }
    backoff = 5000;
    if ((i / 12) % 20 === 0) console.log(`${new Date().toISOString().slice(11, 19)} repaired=${ok} noimage=${noimg} blocked=${blocked} MB=${(bytes / 1048576).toFixed(1)} rate=${(ok / ((Date.now() - t0) / 1000)).toFixed(1)}/s`);
    await sleep(200);
  }
  console.log(`done: repaired=${ok} noimage=${noimg} blocked=${blocked} MB=${(bytes / 1048576).toFixed(1)}`); still.end(); await browser.close();
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
