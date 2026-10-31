// Reads ONLY the Placemaker-data master file. One image per product: the 300x300 main image (images[0]).
const fs = require('fs'), readline = require('readline');
const SRC = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/jax-whatsapp-open-model/Placemaker-data/master/placemakers_product_master.jsonl';
const OUT = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(SRC) });
const seen = new Set(); const rows = []; let noImg = 0, wrongFmt = 0, dup = 0;
rl.on('line', (l) => {
  let o; try { o = JSON.parse(l); } catch { return; }
  const sku = String(o.sku || '').trim(); if (!sku) return;
  const imgs = Array.isArray(o.images) ? o.images : [];
  if (!imgs.length) { noImg++; return; }
  const pick = imgs.find((i) => i && i.format === '300Wx300H' && i.url) || null;
  if (!pick) { wrongFmt++; return; }
  if (seen.has(sku)) { dup++; return; }
  seen.add(sku); rows.push({ sku, url: pick.url });
});
rl.on('close', () => {
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ products_with_one_main_image: rows.length, products_without_images: noImg, skipped_no_300x300: wrongFmt, duplicates: dup }));
});
