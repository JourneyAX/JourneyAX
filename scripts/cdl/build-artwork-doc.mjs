#!/usr/bin/env node
/**
 * CDL — editable artwork DOCUMENT builder (Path B, zero-Adobe slice).
 *
 * Turns a design into a LAYERED SVG that Adobe Illustrator opens with a real
 * Layers panel — each element a separate, editable object, NOT a baked image:
 *
 *   Layer "Garment"  — the make-able template's garment photo (the base)
 *   Layer "Artwork"  — the all-over design/pattern (raster placed layer)
 *   Layer "Logo"     — the crest/mascot (raster placed layer, movable/scalable)
 *   Layer "Name"     — LIVE editable text
 *   Layer "Number"   — LIVE editable text
 *
 * SVG top-level <g> groups map to Illustrator layers; `inkscape:label` keeps the
 * names in Inkscape too. Raster layers are embedded as data URIs so the .svg is
 * self-contained. This is the honest in-house equivalent of the Illustrator
 * production file WITHOUT the Adobe API: name/number are truly editable, the
 * logo + artwork are discrete movable layers. (Turning the raster artwork into
 * editable vector PATHS still needs a tracer/Firefly — that's the next step up.)
 *
 * Usage:
 *   node scripts/cdl/build-artwork-doc.mjs \
 *     --garment <url|path> --artwork <path> [--logo <path>] \
 *     --name "RINK RIPPERS" --number 23 --out /tmp/design.svg
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(flag, def = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
async function toDataUri(src) {
  if (!src) return '';
  let buf, mime;
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`fetch ${src} → ${r.status}`);
    mime = r.headers.get('content-type') || 'image/png';
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    buf = readFileSync(src);
    mime = src.endsWith('.jpg') || src.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const W = 1024, H = 1024;

const garment = arg('--garment');
const artwork = arg('--artwork');
const logo = arg('--logo');
const name = arg('--name', '');
const number = arg('--number', '');
const out = arg('--out', '/tmp/cdl-design.svg');

const [garmentUri, artworkUri, logoUri] = await Promise.all([
  toDataUri(garment), toDataUri(artwork), toDataUri(logo),
]);

// A layer = a top-level <g> with an id + inkscape:label (Illustrator reads the
// group as a layer). Order = z-order (garment at the back).
const layers = [];
if (garmentUri) layers.push(
  `  <g id="Garment" inkscape:label="Garment" inkscape:groupmode="layer">
    <image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" xlink:href="${garmentUri}"/>
  </g>`);
if (artworkUri) layers.push(
  `  <g id="Artwork" inkscape:label="Artwork (all-over)" inkscape:groupmode="layer">
    <image x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" xlink:href="${artworkUri}"/>
  </g>`);
if (logoUri) layers.push(
  `  <g id="Logo" inkscape:label="Logo" inkscape:groupmode="layer" transform="translate(${W * 0.30},${H * 0.34})">
    <image width="${W * 0.40}" height="${W * 0.40}" preserveAspectRatio="xMidYMid meet" xlink:href="${logoUri}"/>
  </g>`);
if (name) layers.push(
  `  <g id="Name" inkscape:label="Name (editable)" inkscape:groupmode="layer">
    <text x="${W / 2}" y="${H * 0.60}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="86" fill="#ffffff" stroke="#111111" stroke-width="3" paint-order="stroke">${esc(name)}</text>
  </g>`);
if (number) layers.push(
  `  <g id="Number" inkscape:label="Number (editable)" inkscape:groupmode="layer">
    <text x="${W * 0.82}" y="${H * 0.30}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="120" fill="#ffd400" stroke="#111111" stroke-width="4" paint-order="stroke">${esc(number)}</text>
  </g>`);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>CDL editable design document</title>
  <desc>Layered artwork — each named group opens as an editable Illustrator layer. Name and Number are live editable text.</desc>
${layers.join('\n')}
</svg>
`;

writeFileSync(out, svg);
console.log(`wrote ${out} (${svg.length} bytes) — layers: ${layers.map((l) => l.match(/inkscape:label="([^"]+)"/)[1]).join(', ')}`);
