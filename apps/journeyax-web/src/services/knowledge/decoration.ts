/**
 * Decoration capture — what a style can actually be DESIGNED with (AUG-30).
 *
 * Everything the configurator knows about customising a garment, taken from the
 * platform's own APIs rather than inferred:
 *
 *   colour palettes      → which colour names the imaging host will honour
 *   garment type         → top or bottom, which decides the zone namespace
 *   design lines + zones → per style, per design line
 *   text slots           → where lettering prints, and in what font and size
 *
 * Every one of these was previously a hardcoded default or a hand-typed config
 * value, and each was wrong in a way that reached a customer: fourteen colour
 * names silently vetoed the sixty-six real ones, and a `SUB_FIRST_*` fallback
 * meant a bottom's colours were written to a top's zones.
 *
 * The rule throughout: resolve by ID and report what could not be resolved.
 * Nothing here guesses a name, a prefix or a slot.
 */

/** A colour the imaging host will honour. `render` is the name it wants. */
export interface PaletteColour {
  id: string;
  /** What a customer sees — "Stealth". */
  display: string;
  /** What the renderer needs — "RA STEALTH". Not derivable from `display`. */
  render: string;
  /** Which collection it came from, so a wrong-palette bug is visible. */
  collection: string;
}

/** Where lettering prints, and how. Slot ids differ per style — never assume. */
export interface TextSlot {
  slot: string;              // 't2', 't7', 't21', 't1' — varies by style
  fontFamily?: string;
  fontSize?: number;
  weight?: number;
  yMovement?: number;
  xMovement?: number;
}

export interface DesignLineCapture {
  designLine: string;
  slug: string;
  inspirationNumber?: string;
  partNumber?: string;
  price?: number;
  /** Colour zones, in the order the configurator presents them. */
  zones: {
    zone: string;
    defaultColour?: PaletteColour | { id: string; render: string; unresolved: true };
    /** Set when the zone value describes HOW it is filled, not what colour. */
    fillType?: string;
  }[];
  textSlots: TextSlot[];
  thumbnail?: string;
}

export interface StyleDecoration {
  style: string;
  garmentType?: string;       // Top | Bottom | Accessories
  gender?: string;
  productType?: string;       // REGULAR | TURBO | REVERSIBLE | CCM_* — selects the palette
  /** SUB_FIRST (tops) or SUB_SECOND (bottoms). Derived from the zones themselves. */
  zoneNamespace?: string;
  designLines: DesignLineCapture[];
  /** Slot ids seen anywhere on this style — bottoms legitimately have none. */
  textSlots: string[];
  unresolvedColours: string[];
}

/**
 * Zone values that are not colours.
 *
 * The configurator uses the same option slot for "what shade" and "what fill",
 * so a zone can legitimately answer "Solid" or "Zig Zag Pinstripe". Treating
 * these as colours reported a missing palette that did not exist.
 */
const FILL_TYPES = new Set(['SOLID', 'SOLIDSECOND', 'FLIGHT', 'ZIG ZAG PINSTRIPE']);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

async function getJson(url: string, timeoutMs = 30000): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch every colour collection into one id-keyed index.
 *
 * There is more than one palette and they do NOT share a naming convention:
 * RussellColors is "RA STEALTH", SublimationColors is plain "NAVY". Which one a
 * style uses follows from its productType. Indexing by id sidesteps the whole
 * question — the catalogue states an id, and only one collection will hold it.
 */
export async function fetchPalettes(
  searchBase: string,
  collections: string[],
  log: (m: string) => void = () => {},
): Promise<Map<string, PaletteColour>> {
  const idx = new Map<string, PaletteColour>();
  for (const c of collections) {
    const d = await getJson(`${searchBase}/${encodeURIComponent(c)}?profileName=ASG_findProductByPartnumber_Details&currency=USD`);
    const skus = d?.catalogEntryView?.[0]?.sKUs;
    if (!Array.isArray(skus) || !skus.length) { log(`palette ${c}: EMPTY — collection name may be wrong`); continue; }
    let n = 0;
    for (const s of skus) {
      const id = String(s?.resourceId || '').split('/').pop() || '';
      const render = String(s?.partNumber || '').trim();
      if (!id || !render) continue;
      idx.set(id, { id, display: String(s?.shortDescription || render), render, collection: c });
      n++;
    }
    log(`palette ${c}: ${n} colours`);
  }
  return idx;
}

/** Style → { garmentType, gender, productType }, the platform's own classification. */
export async function fetchGarmentAttributes(utilityBase: string): Promise<Map<string, any>> {
  const d = await getJson(`${utilityBase}/getSublimationProductAttributes`);
  const out = new Map<string, any>();
  for (const [k, v] of Object.entries(d?.sublimationProdAttr || {})) {
    // Keys appear both bare and CUT_-prefixed; index both so either lookup hits.
    out.set(k.toUpperCase(), v);
    if (k.startsWith('CUT_')) out.set(k.slice(4).toUpperCase(), v);
  }
  return out;
}

/**
 * Parse the text slots out of a design line's preview URL.
 *
 * The slots live in the `imageUrl` the catalogue returns — NOT in the options
 * array, which is where I first looked and wrongly concluded no style carried
 * lettering. Slot ids vary per style (329X3M uses t2/t7/t21, 4R3CHA uses
 * t1/t2/t7), so they are read, never defaulted.
 */
export function parseTextSlots(imageUrl: string): TextSlot[] {
  const url = safeDecode(imageUrl);
  const out: TextSlot[] = [];
  for (const m of url.matchAll(/setAttr\.(t\d+)=\{([^}]*)\}/g)) {
    const attrs: Record<string, string> = {};
    for (const part of m[2].split('&')) {
      const i = part.indexOf('=');
      if (i > 0) attrs[part.slice(0, i)] = part.slice(i + 1);
    }
    const num = (v?: string) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : undefined; };
    out.push({
      slot: m[1],
      fontFamily: attrs.fontFamily || undefined,
      fontSize: num(attrs.fontSize),
      weight: num(attrs['s7:weight']),
      yMovement: num(attrs.y_movement),
      xMovement: num(attrs.x_movement),
    });
  }
  return out;
}

/** Percent-decoding is applied twice by this platform; tolerate malformed input. */
function safeDecode(s: string): string {
  let out = String(s || '');
  for (let i = 0; i < 2; i++) {
    try { const d = decodeURIComponent(out); if (d === out) break; out = d; } catch { break; }
  }
  return out;
}

/**
 * Capture one style's full decoration model.
 *
 * Returns null when the catalogue has no design data for the style, so a caller
 * can tell "not decoratable" from "we failed to ask".
 */
export async function captureStyle(
  utilityBase: string,
  style: string,
  palette: Map<string, PaletteColour>,
  attrs: Map<string, any>,
): Promise<StyleDecoration | null> {
  const d = await getJson(`${utilityBase}/getInspirationData/${encodeURIComponent(style)}?data=JSON&isDefault=1`);
  const rows = d?.jsonData;
  if (!Array.isArray(rows) || !rows.length) return null;

  const a = attrs.get(style.toUpperCase()) || {};
  // Secondary index: the same colour appears under two id spaces (see below).
  const paletteByName = new Map<string, PaletteColour>();
  for (const c of palette.values()) paletteByName.set(c.render.toUpperCase(), c);
  const unresolved = new Set<string>();
  const allSlots = new Set<string>();
  const namespaces = new Set<string>();

  const designLines: DesignLineCapture[] = [];
  for (const row of rows) {
    const label = String(row?.designLine || '').trim();
    if (!label) continue;
    const opts = row?.config?.item?.options || [];

    const zones: DesignLineCapture['zones'] = [];
    for (const o of opts) {
      const zone = String(o?.optionId || '').trim();
      if (!zone) continue;
      const ns = /^SUB_(FIRST|SECOND|THIRD)_/.exec(zone)?.[1];
      if (ns) namespaces.add(`SUB_${ns}`);

      // selectedItem is an OBJECT; String() on it yields "[object Object]".
      const si = o?.selectedItem;
      if (!si || typeof si !== 'object') { zones.push({ zone }); continue; }
      const id = String(si.itemId || '');
      const render = String(si.partNumber || '').trim();

      /* Not every zone value is a colour. Some are FILL TYPES — "Solid",
       * "SolidSecond", "Flight", "Zig Zag Pinstripe" — which describe how the
       * zone is filled, not what shade it is. Counting them as unresolved
       * colours produced a false alarm about a missing palette; they are
       * recorded as what they are instead. */
      if (!render || FILL_TYPES.has(render.toUpperCase())) {
        zones.push({ zone, fillType: render || undefined });
        continue;
      }

      /* Resolve by id, then by render NAME. The catalogue cites colours under
       * two different id spaces — the item id (366522) and the catalog-entry id
       * (3074457345616885201) — for the same colour. Matching on id alone left
       * 486 perfectly valid colours looking unresolved. */
      const hit = palette.get(id) || paletteByName.get(render.toUpperCase());
      if (hit) {
        zones.push({ zone, defaultColour: hit });
      } else {
        // Genuinely unknown: a colour collection we have not ingested.
        unresolved.add(`${id}:${render}`);
        zones.push({ zone, defaultColour: { id, render, unresolved: true } });
      }
    }

    const textSlots = parseTextSlots(String(row?.imageUrl || ''));
    for (const t of textSlots) allSlots.add(t.slot);

    const price = parseFloat(String(row?.config?.item?.configurationPrice ?? ''));
    designLines.push({
      designLine: label,
      slug: label.toLowerCase(),          // the layer toggle is the lower-cased name
      inspirationNumber: row?.inspirationNumber || undefined,
      partNumber: row?.config?.item?.partNumber || undefined,
      price: Number.isFinite(price) ? price : undefined,
      zones,
      textSlots,
      thumbnail: safeDecode(String(row?.imageUrl || '')) || undefined,
    });
  }

  if (!designLines.length) return null;
  return {
    style,
    garmentType: a.garmentType,
    gender: a.gender,
    productType: a.productType,
    zoneNamespace: namespaces.size === 1 ? [...namespaces][0] : ([...namespaces].join('+') || undefined),
    designLines,
    textSlots: [...allSlots],
    unresolvedColours: [...unresolved],
  };
}
