// Points placemakers product records at the locally downloaded image. Dry run unless --apply.
//   node link-images.cjs [--apply] [--base /product-images]
const fs = require('fs'), path = require('path');
const REPO = '/Users/mahaveer/Documents/Mahaveer/Projects/JourneyAX/Caroma-Poc/journeyAX';
const { MongoClient } = require(REPO + '/node_modules/mongodb');
const argv = process.argv.slice(2); const APPLY = argv.includes('--apply');
const BASE = (argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : '/product-images').replace(/\/$/, '');
const DIR = REPO + '/data/placemakers/images';
const env = {};
for (const line of fs.readFileSync(REPO + '/.env', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const files = new Map(fs.readdirSync(DIR).filter((f) => !f.endsWith('.tmp')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
(async () => {
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const col = client.db(env.MONGODB_DB_NAME || 'journeyx').collection('products');
  const cur = col.find({ projectId: 'placemakers' }, { projection: { parentSku: 1, sku: 1, variants: 1, images: 1, imageUrl: 1 } });
  let seen = 0, linked = 0, none = 0, already = 0, ops = [], written = 0; const sample = [];
  for await (const d of cur) {
    seen++;
    const cands = [d.parentSku, d.sku, ...((d.variants || []).map((v) => v && v.itemSku))].filter(Boolean).map(String);
    const hit = cands.find((c) => files.has(c));
    if (!hit) { none++; continue; }
    const url = `${BASE}/${files.get(hit)}`;
    const gallery = Array.isArray(d.images) ? d.images : [];
    const variants = Array.isArray(d.variants) ? d.variants : [];
    const galleryOk = gallery.length > 0 && gallery[0] === url;
    if (d.imageUrl === url && galleryOk) { already++; continue; }
    linked++; if (sample.length < 3) sample.push({ _id: String(d._id), sku: hit, imageUrl: url });
    // Every place the services read a picture from points at the same local copy: the top-level field, the first gallery image and the variant's main image.
    const set = { imageUrl: url, images: [url, ...gallery.slice(1)], imageSource: 'placemakers-crawl-300x300' };
    if (variants.length) set.variants = variants.map((v) => (v && String(v.itemSku) === hit ? { ...v, mainImage: url } : v));
    ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: set } } });
    if (APPLY && ops.length >= 1000) { await col.bulkWrite(ops, { ordered: false }); written += ops.length; ops = []; }
  }
  if (APPLY && ops.length) { await col.bulkWrite(ops, { ordered: false }); written += ops.length; }
  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY RUN', productsSeen: seen, imageFilesOnDisk: files.size, wouldLinkOrLinked: linked, alreadyLinked: already, noImageFile: none, written, sample }, null, 1));
  await client.close();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
