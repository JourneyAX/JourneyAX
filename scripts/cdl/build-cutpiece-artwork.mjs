#!/usr/bin/env node
/**
 * Build editable, Illustrator-compatible cut-piece artwork from an Augusta SVG.
 *
 * The source SVG remains the geometry authority. This script extracts the real
 * graded size/piece paths, applies a configurable vector artwork system, and
 * emits a layer-organised master plus one SVG per production size.
 *
 * Usage:
 *   node scripts/cdl/build-cutpiece-artwork.mjs \
 *     --template /path/to/prod-228187-RJALLP.svg \
 *     --out-dir artifacts/augusta-228187-north-view
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const templatePath = resolve(arg('--template'));
const outDir = resolve(arg('--out-dir', 'artifacts/augusta-228187-north-view'));
const source = readFileSync(templatePath, 'utf8');
const sizes = ['S', 'M', 'L', 'XL', '2XL', '3XL'];
const pieceNames = ['back', 'front', 'collar', 'lsleeve', 'rsleeve'];

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Extract a nested <g> element without depending on a DOM/XML package. */
function extractBalancedGroup(xml, startIndex) {
  if (startIndex < 0 || !xml.startsWith('<g', startIndex)) {
    throw new Error(`No <g> at source offset ${startIndex}`);
  }
  const token = /<g\b[^>]*>|<\/g>/g;
  token.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = token.exec(xml))) {
    if (match[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return xml.slice(startIndex, token.lastIndex);
  }
  throw new Error(`Unbalanced group at source offset ${startIndex}`);
}

function groupByIdPrefix(xml, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<g\\s+id="${escaped}[^"]*"`).exec(xml);
  if (!match) throw new Error(`Missing group with id prefix: ${prefix}`);
  return extractBalancedGroup(xml, match.index);
}

function pathAttributes(pathTag) {
  const attrs = {};
  for (const match of pathTag.matchAll(/([:\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function allPathAttributes(xml) {
  return [...xml.matchAll(/<path\b[\s\S]*?\/>/g)].map((match) => pathAttributes(match[0]));
}

function extractPiece(size, name) {
  const garment = groupByIdPrefix(source, `Garment_x5F_${size}`);
  const part = groupByIdPrefix(garment, `Part:${name}`);
  const outline = groupByIdPrefix(part, 'outline_');
  const editable = allPathAttributes(part)
    .filter((attrs) => attrs.id?.startsWith('id:SUB_FIRST_') && attrs.d)
    .sort((a, b) => b.d.length - a.d.length)[0];
  const sourceOutline = allPathAttributes(outline)
    .filter((attrs) => attrs.d)
    .sort((a, b) => b.d.length - a.d.length)[0];
  if (!editable || !sourceOutline) throw new Error(`Missing geometry for ${size}/${name}`);
  return { editableD: editable.d, sourceOutlineD: sourceOutline.d, originalOutline: outline };
}

const geometry = Object.fromEntries(
  sizes.map((size) => [size, Object.fromEntries(pieceNames.map((name) => [name, extractPiece(size, name)]))]),
);

const palette = {
  white: '#F8F8F5',
  navy: '#082B53',
  navyDeep: '#031A33',
  red: '#C9272C',
  redBright: '#E34243',
  silver: '#B8BEC5',
  technical: '#73777D',
  sourceOutline: '#FF2AA1',
  editableBoundary: '#00A9C7',
};

function sharedDefs() {
  return `
  <defs>
    <pattern id="NORTH_VIEW_HALFTONE" width="44" height="44" patternUnits="userSpaceOnUse">
      <circle cx="8" cy="8" r="6" fill="${palette.silver}" opacity="0.48"/>
      <circle cx="30" cy="30" r="3.5" fill="${palette.silver}" opacity="0.34"/>
    </pattern>
    <pattern id="NORTH_VIEW_MICRO_DOT" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="2" fill="${palette.navy}" opacity="0.16"/>
    </pattern>
    <linearGradient id="NORTH_VIEW_WHITE_SHADE" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.62" stop-color="${palette.white}"/>
      <stop offset="1" stop-color="#E4E7EA"/>
    </linearGradient>
    <style><![CDATA[
      .editable-text { font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif; font-weight: 900; }
      .small-copy { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 3px; }
      .technical { vector-effect: non-scaling-stroke; }
    ]]></style>
  </defs>`;
}

function jerseyCrest(cx, cy, scale = 1) {
  return `
    <g id="TEAM_MARK_NV" transform="translate(${cx} ${cy}) scale(${scale})" aria-label="Replaceable North View team mark">
      <path d="M-104 88 L-72-92 L-24-92 L30 19 L56-92 L104-92 L72 92 L25 92 L-30-18 L-56 88 Z" fill="${palette.navy}" stroke="${palette.red}" stroke-width="8" paint-order="stroke"/>
      <path d="M48 33 L112 33 L101 92 L37 92 Z" fill="${palette.red}"/>
      <path d="M53-126 L66-98 L97-95 L74-74 L81-43 L53-59 L25-43 L32-74 L9-95 L40-98 Z" fill="${palette.navy}" stroke="${palette.red}" stroke-width="5"/>
    </g>`;
}

function roundSleevePatch(cx, cy) {
  return `
    <g id="SLEEVE_PATCH_REPLACEABLE" transform="translate(${cx} ${cy})">
      <circle r="126" fill="${palette.white}" stroke="${palette.red}" stroke-width="16"/>
      <circle r="103" fill="${palette.navy}" stroke="${palette.white}" stroke-width="7"/>
      <text class="small-copy" x="0" y="-36" text-anchor="middle" font-size="30" fill="#FFFFFF">NORTH</text>
      <text class="small-copy" x="0" y="8" text-anchor="middle" font-size="30" fill="#FFFFFF">VIEW</text>
      <path d="M-64 52 L0 22 L64 52 L48 83 L0 62 L-48 83 Z" fill="${palette.red}"/>
    </g>`;
}

function bodyBackground(side) {
  const isFront = side === 'front';
  const x0 = isFront ? 2460 : 0;
  const x1 = isFront ? 5040 : 2460;
  const slashShift = isFront ? 2380 : -70;
  return `
    <rect x="${x0}" y="1650" width="${x1 - x0}" height="3000" fill="url(#NORTH_VIEW_WHITE_SHADE)"/>
    <path d="M${x0} 2700 L${x1} 2520 L${x1} 3670 L${x0} 3930 Z" fill="url(#NORTH_VIEW_HALFTONE)" opacity="0.76"/>
    <path d="M${x0} 3220 L${x1} 2920 L${x1} 3370 L${x0} 3640 Z" fill="url(#NORTH_VIEW_MICRO_DOT)" opacity="0.9"/>
    <g id="VECTOR_BRUSH_SLASHES_${side.toUpperCase()}">
      <path d="M${slashShift + 80} 4380 L${slashShift + 1720} 2920 L${slashShift + 1210} 3710 L${slashShift + 1890} 3220 L${slashShift + 970} 4240 Z" fill="${palette.navy}"/>
      <path d="M${slashShift + 190} 4460 L${slashShift + 1980} 3260 L${slashShift + 1430} 3880 L${slashShift + 2110} 3480 L${slashShift + 1180} 4440 Z" fill="${palette.red}"/>
      <path d="M${slashShift + 70} 4200 L${slashShift + 1120} 3310 L${slashShift + 710} 3990 L${slashShift + 1530} 3420 L${slashShift + 850} 4310 Z" fill="${palette.navyDeep}"/>
      <path d="M${slashShift + 980} 4350 L${slashShift + 2180} 3570 L${slashShift + 1680} 4090 L${slashShift + 2260} 3820 L${slashShift + 1900} 4320 Z" fill="${palette.redBright}"/>
      <path d="M${slashShift + 370} 4040 L${slashShift + 1080} 3570" fill="none" stroke="#FFFFFF" stroke-width="34"/>
      <path d="M${slashShift + 910} 4240 L${slashShift + 1690} 3690" fill="none" stroke="#FFFFFF" stroke-width="22"/>
      <path d="M${slashShift + 1530} 4140 L${slashShift + 2120} 3740" fill="none" stroke="${palette.navy}" stroke-width="18"/>
    </g>
    <path d="M${x0 + 30} 1900 L${x0 + 780} 1760 L${x0 + 560} 1880 L${x0 + 980} 1800 L${x0 + 610} 1990 Z" fill="${palette.navy}" opacity="0.96"/>
    <path d="M${x1 - 30} 1920 L${x1 - 790} 1780 L${x1 - 570} 1900 L${x1 - 1010} 1820 L${x1 - 610} 2010 Z" fill="${palette.red}" opacity="0.92"/>`;
}

function bodyLogosAndText(side) {
  if (side === 'front') {
    return `
      <g id="03_LOGOS_FRONT" inkscape:label="03 LOGOS — replaceable" inkscape:groupmode="layer">
        ${jerseyCrest(4300, 2150, 0.82)}
        <g id="SUPPLIER_MARK_REPLACEABLE" transform="translate(3290 2190)">
          <path d="M0-54 L58 48 H31 L0-4 L-31 48 H-58 Z" fill="${palette.navy}"/>
          <path d="M0-20 L18 13 H-18 Z" fill="${palette.white}"/>
          <text class="small-copy" x="0" y="88" text-anchor="middle" font-size="28" fill="${palette.navy}">ELEVATE</text>
        </g>
      </g>
      <g id="04_TEXT_FRONT" inkscape:label="04 TEXT — editable" inkscape:groupmode="layer">
        <text id="TEAM_NAME_FRONT" class="editable-text" x="3760" y="2600" text-anchor="middle" font-size="190" letter-spacing="5" fill="${palette.navy}" stroke="${palette.red}" stroke-width="11" paint-order="stroke">NORTH VIEW</text>
        <text id="PLAYER_NUMBER_FRONT" class="editable-text" x="4250" y="3160" text-anchor="middle" font-size="360" fill="${palette.navy}" stroke="${palette.red}" stroke-width="14" paint-order="stroke">25</text>
      </g>`;
  }
  return `
      <g id="03_LOGOS_BACK" inkscape:label="03 LOGOS — replaceable" inkscape:groupmode="layer">
        ${jerseyCrest(1810, 2130, 0.45)}
      </g>
      <g id="04_TEXT_BACK" inkscape:label="04 TEXT — editable" inkscape:groupmode="layer">
        <text id="PLAYER_NAME_BACK" class="editable-text" x="1225" y="2300" text-anchor="middle" font-size="172" letter-spacing="9" fill="${palette.navy}" stroke="${palette.red}" stroke-width="10" paint-order="stroke">NORTH VIEW</text>
        <text id="PLAYER_NUMBER_BACK" class="editable-text" x="1225" y="3430" text-anchor="middle" font-size="900" fill="${palette.navy}" stroke="${palette.red}" stroke-width="24" paint-order="stroke">25</text>
      </g>`;
}

function sleeveBackground(side) {
  const left = side === 'lsleeve';
  const x0 = left ? 250 : 2700;
  const x1 = left ? 2320 : 4790;
  return `
    <rect x="${x0}" y="120" width="${x1 - x0}" height="1300" fill="url(#NORTH_VIEW_WHITE_SHADE)"/>
    <rect x="${x0}" y="1070" width="${x1 - x0}" height="260" fill="${palette.navy}"/>
    <rect x="${x0}" y="1130" width="${x1 - x0}" height="42" fill="${palette.red}"/>
    <path d="M${x0 + 40} 860 L${x1 - 120} 270 L${x1 - 500} 690 L${x1 - 40} 560 L${x1 - 780} 970 Z" fill="${palette.navy}"/>
    <path d="M${x0 + 210} 980 L${x1 - 60} 430 L${x1 - 510} 800 L${x1 - 40} 730 L${x1 - 750} 1070 Z" fill="${palette.red}"/>
    <path d="M${x0} 260 L${x1} 700" stroke="url(#NORTH_VIEW_HALFTONE)" stroke-width="210" opacity="0.65"/>`;
}

function sleeveDecoration(side) {
  const left = side === 'lsleeve';
  const cx = left ? 1280 : 3775;
  return `
    <g id="03_SLEEVE_DECORATION_${left ? 'LEFT' : 'RIGHT'}" inkscape:label="03 SLEEVE DECORATION — replaceable" inkscape:groupmode="layer">
      ${left ? roundSleevePatch(cx, 800) : `<text id="SLEEVE_NUMBER" class="editable-text" x="${cx}" y="900" text-anchor="middle" font-size="300" fill="${palette.white}" stroke="${palette.navy}" stroke-width="18" paint-order="stroke">25</text>`}
    </g>`;
}

function collarArtwork() {
  return `
    <rect x="0" y="0" width="5040" height="5040" fill="${palette.white}"/>
    <rect x="0" y="1469" width="5040" height="94" fill="${palette.red}"/>
    <rect x="0" y="1563" width="5040" height="94" fill="${palette.navy}"/>`;
}

function pieceBackground(name) {
  if (name === 'front' || name === 'back') return bodyBackground(name);
  if (name === 'lsleeve' || name === 'rsleeve') return sleeveBackground(name);
  return collarArtwork();
}

function pieceDecoration(name) {
  if (name === 'front' || name === 'back') return bodyLogosAndText(name);
  if (name === 'lsleeve' || name === 'rsleeve') return sleeveDecoration(name);
  return '';
}

function buildPiece(size, name, options = {}) {
  const part = geometry[size][name];
  const prefix = `${size.replaceAll('XL', 'X_L')}_${name}`;
  const clipId = `CLIP_${prefix}`;
  const hiddenSource = part.originalOutline.replace(
    /^<g\b/,
    `<g display="none" inkscape:label="Original Augusta outline (preserved, hidden)" data-source="${xmlEscape(basename(templatePath))}"`,
  );
  return `
      <g id="Part:${name}_${size}" inkscape:label="Part: ${name}" inkscape:groupmode="layer">
        <defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${part.editableD}"/></clipPath></defs>
        <g id="01_BACKGROUND_${prefix}" inkscape:label="01 BACKGROUND ART" inkscape:groupmode="layer" clip-path="url(#${clipId})">
          <path d="${part.editableD}" fill="url(#NORTH_VIEW_WHITE_SHADE)"/>
          ${pieceBackground(name)}
        </g>
        ${pieceDecoration(name)}
        <g id="90_TECHNICAL_${prefix}" inkscape:label="90 TECHNICAL — DO NOT EDIT" inkscape:groupmode="layer"${options.technicalOnly ? '' : ''}>
          <path class="technical" d="${part.sourceOutlineD}" fill="none" stroke="${palette.sourceOutline}" stroke-width="4"/>
          <path class="technical" d="${part.editableD}" fill="none" stroke="${palette.editableBoundary}" stroke-width="2.5" stroke-dasharray="18 12"/>
          ${hiddenSource}
        </g>
      </g>`;
}

function infoLayer(size, subtitle) {
  return `
    <g id="00_JOB_INFO_${size}" inkscape:label="00 JOB INFO" inkscape:groupmode="layer">
      <rect x="56" y="45" width="1060" height="175" rx="20" fill="#FFFFFF" stroke="${palette.technical}" stroke-width="3"/>
      <text class="small-copy" x="88" y="100" font-size="34" fill="${palette.navy}">NORTH VIEW · HOLLOWAY 228187 · ${size}</text>
      <text x="88" y="146" font-family="Arial, Helvetica, sans-serif" font-size="25" fill="#333333">${xmlEscape(subtitle)}</text>
      <g transform="translate(88 172)">
        <rect width="42" height="24" fill="${palette.white}" stroke="#777"/><rect x="55" width="42" height="24" fill="${palette.navy}"/><rect x="110" width="42" height="24" fill="${palette.red}"/><rect x="165" width="42" height="24" fill="${palette.silver}"/>
      </g>
    </g>`;
}

function svgDocument(title, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     version="1.1" width="5040px" height="5040px" viewBox="0 0 5040 5040">
  <title>${xmlEscape(title)}</title>
  <desc>Editable vector artwork projected onto source-authoritative Augusta style 228187 cut-piece geometry. Magenta = Augusta source outline; cyan dashed = editable print-region boundary. Confirm production line semantics with Momentec before printing.</desc>
  ${sharedDefs()}
  ${content}
</svg>
`;
}

function sizeLayer(size, visible = true) {
  return `
    <g id="Garment_x5F_${size}" inkscape:label="SIZE ${size}" inkscape:groupmode="layer"${visible ? '' : ' style="display:none"'}>
      ${pieceNames.map((name) => buildPiece(size, name)).join('\n')}
    </g>`;
}

mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
  const filename = `north-view-228187-size-${size.toLowerCase()}.svg`;
  const svg = svgDocument(
    `North View — Holloway 228187 — Size ${size}`,
    `${infoLayer(size, 'Editable vector cut-piece artwork · source geometry preserved')}\n${sizeLayer(size)}`,
  );
  writeFileSync(join(outDir, filename), svg);
}

const master = svgDocument(
  'North View — Holloway 228187 — S through 3XL master',
  `${infoLayer('MASTER', 'Toggle one SIZE layer at a time in Illustrator · L is visible by default')}\n${sizes
    .map((size) => sizeLayer(size, size === 'L'))
    .join('\n')}`,
);
writeFileSync(join(outDir, 'north-view-228187-all-sizes-master.svg'), master);

const nestContent = sizes
  .slice()
  .reverse()
  .map((size) => `
    <g id="GRADE_${size}" inkscape:label="Grade outline ${size}" inkscape:groupmode="layer">
      ${pieceNames
        .map((name) => `<path class="technical" d="${geometry[size][name].sourceOutlineD}" fill="none" stroke="${size === 'L' ? palette.red : palette.technical}" stroke-width="${size === 'L' ? 5 : 3}" opacity="${size === 'L' ? 1 : 0.68}"/>`)
        .join('\n')}
    </g>`)
  .join('\n');
writeFileSync(
  join(outDir, 'north-view-228187-grade-nest.svg'),
  svgDocument('Holloway 228187 — S through 3XL grade nest', `${infoLayer('S–3XL', 'Source outline comparison · L highlighted in red')}\n${nestContent}`),
);

const manifest = {
  schemaVersion: 1,
  jobId: 'north-view-228187-v1',
  style: {
    brand: 'Holloway',
    styleNumber: '228187',
    productName: 'FreeStyle Sublimated Turbo Flag Football Lightweight Reversible Jersey',
    construction: ['adult', 'reversible', 'V-neck', 'set-in sleeves'],
    sizes,
  },
  sourceTemplate: basename(templatePath),
  geometryPolicy: 'source-authoritative; never uniformly scale one size to create another',
  editableSlots: {
    teamName: { value: 'NORTH VIEW', layerIds: ['TEAM_NAME_FRONT', 'PLAYER_NAME_BACK'] },
    playerNumber: { value: '25', layerIds: ['PLAYER_NUMBER_FRONT', 'PLAYER_NUMBER_BACK', 'SLEEVE_NUMBER'] },
    teamMark: { value: 'NV placeholder', layerId: 'TEAM_MARK_NV', replaceWithApprovedAsset: true },
    supplierMark: { value: 'ELEVATE placeholder', layerId: 'SUPPLIER_MARK_REPLACEABLE', replaceWithApprovedAsset: true },
    sleevePatch: { value: 'NORTH VIEW placeholder', layerId: 'SLEEVE_PATCH_REPLACEABLE', replaceWithApprovedAsset: true },
  },
  palette,
  sourceLineSemantics: {
    magenta: 'Augusta source outline extracted from the supplied template',
    cyanDashed: 'editable colored-region boundary extracted from the supplied template',
    warning: 'Do not infer cut/sew/bleed meaning without Momentec production confirmation.',
  },
  outputs: [
    'north-view-228187-all-sizes-master.svg',
    'north-view-228187-grade-nest.svg',
    ...sizes.map((size) => `north-view-228187-size-${size.toLowerCase()}.svg`),
  ],
};
writeFileSync(join(outDir, 'north-view-228187-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Created ${manifest.outputs.length} SVG files and manifest in ${outDir}`);
