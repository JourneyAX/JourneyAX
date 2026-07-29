/**
 * Cap decoration capture (CAP-1 / phase C2).
 *
 * Caps are the same catalogue as the jerseys — same brand family, same rack,
 * same journey — but they are configured by a different mechanism, and that
 * difference is the whole reason this file exists.
 *
 * A sublimated jersey is coloured SERVER-side: the imaging host composes a
 * texture atlas and hands back one PNG. A cap is coloured CLIENT-side: the
 * platform hands back a per-mesh hex map and the viewer mutates each material
 * on the mesh it already has. So there is no texture to probe and no design
 * line to toggle; what has to be captured instead is the colour map itself.
 *
 * Two traps are already known from the jersey work and are avoided here:
 *
 *  1. **Mesh names are per style, never universal.** `104C` names its crown
 *     `mesh_cap_crown_front`, `P414` names it `mesh_cap_crown`, and `598V`
 *     carries an interior crown neither of the others has. Defaulting a mesh
 *     table would silently colour nothing on two styles out of three. Every
 *     mesh name is read from that style's own response. This is the same trap
 *     as design lines (AUG-23) and text slots (AUG-30).
 *
 *  2. **The colour values are JSON strings, not objects.** `colorJson` maps a
 *     colour code to a *string* that must be parsed again. Treating it as an
 *     object yields a map of characters, which would look like a successful
 *     capture and fail only at render.
 *
 * A style that returns no colour codes is recorded as having no cap system
 * rather than as a failure — 35 styles appear in the platform's own cap
 * configurator list against 112 headwear products, so most headwear is stock
 * and genuinely not configurable. Those must stay undesignable (AUG-25), and
 * the distinction is carried in the data instead of being inferred later.
 */

export interface CapColourMap {
  /** Platform colour code, e.g. "E64". */
  code: string;
  /**
   * The colour's human name, e.g. "Navy".
   *
   * The colour endpoint returns codes only, so a customer asking for navy could
   * not be matched to a cap without this. The name comes from the style's own
   * variant rows, whose SKUs are `{style}.{code}.{size}` — so the join is on the
   * catalogue's own data rather than a hand-written code table, which would go
   * stale the moment a colour was added.
   *
   * Left undefined when no variant row carries the code: an unnamed colour can
   * still be rendered if chosen by code, and inventing a name would be worse.
   */
  name?: string;
  /** Mesh name → 6-digit hex, exactly as the platform states it. */
  meshes: Record<string, string>;
}

export interface CapCapture {
  /** Every colour the platform offers for this style. */
  colours: CapColourMap[];
  /** Union of mesh names across colours — this style's colourable surfaces. */
  meshes: string[];
  /** The 3D mesh, confirmed to exist before being recorded. */
  meshUrl?: string;
  meshBytes?: number;
  /** Set when the style is in the catalogue but has no cap configuration. */
  notConfigurable?: boolean;
  /** Anything unresolved, logged loudly rather than swallowed (AUG-30). */
  warnings: string[];
}

export interface CapEndpoints {
  /** Site origin, from project config — never a literal in code. */
  base: string;
  storeId: string;
  /** e.g. "https://static.momentecbrands.com/3D/{style}.glb" */
  meshPattern?: string;
}

const jsonHeaders = { accept: 'application/json' };

/** Parse one colour entry, tolerating both the string and object forms. */
export function parseMeshMap(raw: unknown): Record<string, string> {
  let val: unknown = raw;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch { return {}; }
  }
  if (!val || typeof val !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [mesh, hex] of Object.entries(val as Record<string, unknown>)) {
    const h = String(hex ?? '').trim().replace(/^#/, '');
    /* Only accept a real colour. A blank or malformed value must not be stored
       as if it were black — that is a wrong garment shown confidently. */
    if (/^[0-9a-fA-F]{6}$/.test(h)) out[mesh] = h.toLowerCase();
  }
  return out;
}

/**
 * Colour code → colour name, read off the style's variant SKUs.
 *
 * A variant SKU is `{style}.{code}.{size}` (e.g. `P414.E64.OS`), so the middle
 * segment is the code the colour endpoint uses. Rows that do not match that
 * shape are skipped rather than parsed loosely — a wrong name attached to a
 * colour would show the customer one cap and order another.
 */
export function colourNamesFromVariants(
  style: string,
  variants: { itemSku?: string; color?: string }[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = String(style).toUpperCase();
  for (const v of variants || []) {
    const parts = String(v?.itemSku || '').toUpperCase().split('.');
    if (parts.length < 2 || parts[0] !== prefix) continue;
    const code = parts[1];
    const name = String(v?.color || '').trim();
    if (code && name && !out[code]) out[code] = name;
  }
  return out;
}

/** Fetch this style's cap colour configuration from the platform. */
export async function fetchCapColours(
  ep: CapEndpoints,
  style: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ colours: CapColourMap[]; warnings: string[] }> {
  const warnings: string[] = [];
  const url = `${ep.base.replace(/\/$/, '')}/wcs/resources/store/${encodeURIComponent(ep.storeId)}`
    + `/savecapconfiguration/getColorConfig?responseFormat=json&rq=1`
    + `&partNumber=${encodeURIComponent(style)}`;

  const res = await fetchImpl(url, { headers: jsonHeaders });
  if (!res.ok) {
    warnings.push(`getColorConfig ${res.status}`);
    return { colours: [], warnings };
  }

  let body: any;
  try { body = await res.json(); } catch { warnings.push('getColorConfig unparseable'); return { colours: [], warnings }; }

  const colorJson = body?.colorJson;
  if (!colorJson || typeof colorJson !== 'object') return { colours: [], warnings };

  const colours: CapColourMap[] = [];
  for (const [code, raw] of Object.entries(colorJson)) {
    const meshes = parseMeshMap(raw);
    if (!Object.keys(meshes).length) {
      warnings.push(`colour ${code}: no usable mesh colours`);
      continue;
    }
    colours.push({ code, meshes });
  }
  return { colours, warnings };
}

/**
 * Confirm the mesh exists before recording it.
 *
 * A range request is used rather than a full download: the models run to
 * 12.5 MB each and the only question at capture time is whether the asset is
 * there. Recording a mesh URL that 404s would put a style into the journey
 * that cannot render — the exact failure AUG-25 exists to prevent.
 */
export async function probeMesh(
  ep: CapEndpoints,
  style: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url?: string; bytes?: number; warning?: string }> {
  if (!ep.meshPattern) return { warning: 'no meshPattern in project config' };
  const url = ep.meshPattern.replace('{style}', style);
  try {
    const res = await fetchImpl(url, { headers: { range: 'bytes=0-0' } });
    if (!res.ok && res.status !== 206) return { warning: `mesh ${res.status}` };
    const cr = res.headers.get('content-range') || '';
    const total = Number(cr.split('/')[1]);
    return { url, bytes: Number.isFinite(total) ? total : undefined };
  } catch (e) {
    return { warning: `mesh unreachable: ${(e as Error).message}` };
  }
}

/**
 * A colour code → name index built from EVERY product's variant rows, not just
 * this cap's own (CAP-4).
 *
 * The cap configurator offers more colours than the cap is stocked in: for
 * 101C it offers 28 and sells 17, so 11 are configurator-only and carry no
 * variant row on THIS style — the live site shows them as unlabelled swatches
 * and does not name them either. But colour codes are a single global namespace
 * across the whole catalogue, and code 169 that is unnamed on this cap is
 * "SILVER/NAVY" on some jersey. Joining across every product's variant rows
 * recovers the platform's own real name — 213 of 269 unnamed cap colourways —
 * with zero code collisions (every code resolves to exactly one name).
 *
 * The remaining colours are named nowhere in the feed and stay code-only:
 * inventing a name is worse than admitting we do not have one.
 */
export type GlobalColourIndex = Record<string, string>;

export function buildGlobalColourIndex(
  products: { variants?: { itemSku?: string; color?: string }[] }[],
): GlobalColourIndex {
  // Count names per code so a rare typo cannot beat the canonical spelling.
  const tally = new Map<string, Map<string, number>>();
  for (const p of products) {
    for (const v of p.variants || []) {
      const parts = String(v?.itemSku || '').toUpperCase().split('.');
      if (parts.length < 2) continue;
      const code = parts[1];
      const name = String(v?.color || '').trim();
      if (!code || !name) continue;
      if (!tally.has(code)) tally.set(code, new Map());
      const m = tally.get(code)!;
      m.set(name, (m.get(name) || 0) + 1);
    }
  }
  const idx: GlobalColourIndex = {};
  for (const [code, names] of tally) {
    idx[code] = [...names].sort((a, b) => b[1] - a[1])[0][0];
  }
  return idx;
}

/** Capture everything needed to configure one cap style. */
export async function captureCap(
  ep: CapEndpoints,
  style: string,
  variants?: { itemSku?: string; color?: string }[],
  globalNames: GlobalColourIndex = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CapCapture> {
  const { colours, warnings } = await fetchCapColours(ep, style, fetchImpl);
  const names = colourNamesFromVariants(style, variants);
  /* This style's own variant rows are the most authoritative source, so they
     win; the global index is the fallback for colours it does not sell. */
  for (const c of colours) {
    const code = c.code.toUpperCase();
    c.name = names[code] || globalNames[code];
  }

  const unnamed = colours.filter((c) => !c.name).length;
  if (unnamed) warnings.push(`${unnamed}/${colours.length} colour(s) are named nowhere in the catalogue feed — selectable by code only`);

  if (!colours.length) {
    /* Not a fault: most headwear is stock. Recorded explicitly so the agent
       can tell "we checked and it isn't configurable" from "we never looked". */
    return { colours: [], meshes: [], notConfigurable: true, warnings };
  }

  const meshes = [...new Set(colours.flatMap((c) => Object.keys(c.meshes)))].sort();
  const mesh = await probeMesh(ep, style, fetchImpl);
  if (mesh.warning) warnings.push(mesh.warning);

  return {
    colours,
    meshes,
    meshUrl: mesh.url,
    meshBytes: mesh.bytes,
    /* Colours without a mesh cannot be shown in 3D, so the style is not
       treated as configurable even though the platform offered colours. */
    notConfigurable: mesh.url ? undefined : true,
    warnings,
  };
}
