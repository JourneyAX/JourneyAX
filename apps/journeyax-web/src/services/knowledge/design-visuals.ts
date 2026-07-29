/**
 * Visual design capture — what each design actually LOOKS like (AUG-42).
 *
 * The catalogue describes every design line identically: a body colour and two
 * or three accents. By that data "Hardwood Pinstripe" and "Mardi Gras" are the
 * same garment. They are not — one is thin curved pinstripes, the other is
 * three thick bands across the chest. An agent choosing between them from the
 * metadata is choosing blind, and a customer asking for "something bold" cannot
 * be served from a list of names.
 *
 * So each design is RENDERED and read.
 *
 * The method is a probe render. Every zone the catalogue reports is filled with
 * a DIFFERENT, deliberately far-apart colour, so the resulting image can be read
 * back zone by zone: how much of the garment each zone covers, and where it
 * sits. That turns "ACCENT_1" into "a narrow band across the upper chest".
 *
 * It also catches a class of bug nothing else can. Rendering Mardi Gras with
 * three colours produced a green stripe — a fourth zone, unrequested, falling
 * back to a factory default. Every metadata check passed: all three colours
 * sent were valid. Only the picture showed the customer was getting green. Any
 * significant colour that is not one of the probes is therefore reported as an
 * UNSET ZONE, because in production that is an unasked-for colour on a shirt.
 */
import { PNG } from 'pngjs';

/** A probe colour: a palette name plus the RGB it actually renders as. */
export interface ProbeColour {
  render: string;             // palette name sent to the imaging host
  rgb: [number, number, number];
  /** Precomputed so the per-pixel loop does no repeated conversion. */
  hsv?: { h: number; s: number; v: number };
}

export interface ZoneReading {
  zone: string;
  probe: string;
  /** Share of the garment this zone covers, 0–1. */
  coverage: number;
  /** Where its pixels sit, 0 = top/left, 1 = bottom/right. */
  centroidY?: number;
  centroidX?: number;
  /** How spread out vertically — small means a band, large means all over. */
  spreadY?: number;
  /** Renders, but below the coverage floor: buttons, piping, fine trim. */
  tiny?: boolean;
}

export interface DesignVisual {
  style: string;
  designLine: string;
  /** Zones actually visible in the render, largest first. */
  zones: ZoneReading[];
  /** Colours present that were NEVER requested — an unset zone (see above). */
  unsetZones: { rgb: [number, number, number]; coverage: number }[];
  /** Zones the catalogue reports that rendered nothing visible — also unset,
   *  but with a neutral default, so they show as absence rather than colour. */
  invisibleZones: string[];
  /** True when the render carried no design at all — a capture failure, NOT a
   *  product with unset zones. Callers must not treat it as a reading. */
  unreadable?: boolean;
  /** Reported zone count vs how many were actually visible. */
  zonesExpected: number;
  zonesSeen: number;
  /** Plain-language shape of the design, derived from the readings. */
  character: string[];
  imageBytes: number;
}

/* Background and garment furniture — labels, size tags, the spec grid, plackets
 * and shadow — carry no design information and must not be read as a colour.
 *
 * This was originally written as brightness bands (near-white, near-black, and
 * a mid range) and left a hole between them: rgb(110,111,114) fell through and
 * was reported as an unrequested colour on all 21 designs of style 227230 — a
 * 100% false-alarm rate traced to one grey. Saturation has no such gap: grey is
 * grey at every brightness, so that is what is tested. */
const isNeutral = (r: number, g: number, b: number) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 42 || mx > 240) return true;                 // black / white extremes
  return mx <= 0 ? true : (mx - mn) / mx < 0.12;        // unsaturated at any brightness
};

const dist2 = (a: number[], b: number[]) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Hue and saturation, 0–360 and 0–1.
 *
 * Matching on RGB distance failed on real renders: cloth is lit and shadowed,
 * so one red spans rgb(179,73,92) to rgb(217,165,174) and half of it reads as a
 * different colour entirely. That produced eight "unrequested colours" on a
 * design that had none. Shading moves brightness a great deal and hue very
 * little, so hue is what identifies a zone.
 */
function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === R) h = 60 * (((G - B) / d) % 6);
    else if (mx === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx <= 0 ? 0 : d / mx, v: mx };
}

/** Circular hue difference in degrees. */
const hueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Read a rendered design.
 *
 * Pixels are matched to the nearest probe colour, but only when they are close
 * enough to be that colour — anything far from every probe is a colour we did
 * not ask for, which is the signal that matters most here.
 */
export function analyse(
  png: PNG,
  probes: { zone: string; colour: ProbeColour }[],
  opts: { matchTolerance?: number; hueTolerance?: number; minCoverage?: number } = {},
): Omit<DesignVisual, 'style' | 'designLine' | 'zonesExpected' | 'imageBytes'> {
  const tol = (opts.matchTolerance ?? 46) ** 2;   // squared RGB, for desaturated probes
  /* Hue degrees. Wide on purpose: shading swings brightness hard but hue only a
   * little, and a false "unrequested colour" is a false alarm on a real order. */
  const tolHue = opts.hueTolerance ?? 26;
  const minCov = opts.minCoverage ?? 0.012;       // ~1% — below this it is trim or noise

  const acc = probes.map(() => ({ n: 0, sx: 0, sy: 0, sy2: 0 }));
  const strays = new Map<string, { n: number; r: number; g: number; b: number }>();
  let garment = 0;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      if (png.data[i + 3] < 200) continue;                 // transparent
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (isNeutral(r, g, b)) continue;
      garment++;

      const px = hsv(r, g, b);
      let best = -1, bestD = Infinity;
      for (let p = 0; p < probes.length; p++) {
        const pc = probes[p].colour;
        const ph = pc.hsv ?? hsv(...pc.rgb);
        // Desaturated probes have no meaningful hue; fall back to RGB for those.
        const d = (px.s > 0.18 && ph.s > 0.18)
          ? hueDiff(px.h, ph.h)
          : Math.sqrt(dist2([r, g, b], pc.rgb)) * (tolHue / Math.sqrt(tol));
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best >= 0 && bestD <= tolHue) {
        const a = acc[best];
        a.n++; a.sx += x / png.width; a.sy += y / png.height; a.sy2 += (y / png.height) ** 2;
      } else {
        // Quantise strays so shading variation of one colour collapses to one bucket.
        const key = `${r >> 5}:${g >> 5}:${b >> 5}`;
        const s = strays.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        s.n++; s.r += r; s.g += g; s.b += b;
        strays.set(key, s);
      }
    }
  }

  /* A render with no coloured pixels is NOT a design with unset zones — it is a
   * failed capture, and recording it as the former invents faults in products
   * that are fine.
   *
   * The cause is worth stating because it fooled the resolver: some styles'
   * correct template id returns 408 with a 36-byte body (a processing abort,
   * not absence), so resolution fell through to an id that DOES respond —
   * `preview-prod-{style}-l` — which for those styles renders the flat cutting
   * pattern: garment panel outlines, no fill. 200 OK, 27KB, and completely
   * empty of design. Byte count cannot tell those apart; coloured pixels can. */
  if (!garment) {
    return { zones: [], unsetZones: [], invisibleZones: [], zonesSeen: 0,
             unreadable: true,
             character: ['no design rendered — template returned an unfilled garment'] };
  }

  const zones: ZoneReading[] = probes.map((p, i) => {
    const a = acc[i];
    const cov = a.n / garment;
    if (!a.n) return { zone: p.zone, probe: p.colour.render, coverage: 0 };
    const my = a.sy / a.n;
    return {
      zone: p.zone, probe: p.colour.render, coverage: cov,
      centroidX: a.sx / a.n, centroidY: my,
      spreadY: Math.sqrt(Math.max(0, a.sy2 / a.n - my * my)),
    };
  }).sort((a, b) => b.coverage - a.coverage);

  /* A zone can be genuinely tiny — buttons, piping — and still be rendering
   * correctly. Dropping everything under the coverage floor and then calling
   * it "invisible" reported SUB_FIRST_BUTTON_COLOR as an unset zone on most
   * garments, which is a false alarm about a working product. Only a zone with
   * NO pixels at all is unset; small ones are kept and marked. */
  for (const z of zones) if (z.coverage > 0 && z.coverage < minCov) z.tiny = true;

  const unsetZones = [...strays.values()]
    .map((s) => ({ rgb: [Math.round(s.r / s.n), Math.round(s.g / s.n), Math.round(s.b / s.n)] as [number, number, number],
                   coverage: s.n / garment }))
    .filter((u) => u.coverage >= minCov)
    .sort((a, b) => b.coverage - a.coverage);

  /* A zone the catalogue reported but that shows NO pixels is also unset — its
   * default is a neutral (white, grey, black) that the background filter
   * discards, so it leaves no stray colour to find. ALL STAR failed exactly
   * this way: the render was wrong and every colour check passed. Missing
   * coverage is the evidence, so it is reported alongside stray colours. */
  const invisible = zones.filter((z) => z.coverage === 0).map((z) => z.zone);

  /* If no zone painted anything, the design did not render — regardless of a
   * few stray coloured pixels from a logo or size label, which is why testing
   * for zero coloured pixels was not enough: PHILLY on 228103 has a handful and
   * so passed as "readable" with every zone at zero, then got stored with the
   * label "nothing rendered" instead of being recorded as unavailable. Painted
   * area is the real test. */
  const painted = zones.reduce((n, z) => n + z.coverage, 0);
  if (painted < 0.02) {
    return { zones: [], unsetZones: [], invisibleZones: [], zonesSeen: 0, unreadable: true,
             character: ['no design rendered — this design line is not on this style'] };
  }

  return {
    zones, unsetZones, invisibleZones: invisible, zonesSeen: zones.length,
    character: describe(zones, unsetZones, invisible),
  };
}

/**
 * Turn the readings into words a customer would use.
 *
 * Deliberately conservative: it describes what the measurements support and
 * nothing more. "Bold" and "subtle" are grounded in actual coverage, so the
 * agent is repeating a measurement rather than an impression.
 */
function describe(zones: ZoneReading[], unset: { coverage: number }[], invisible: string[] = []): string[] {
  const out: string[] = [];
  if (!zones.length) return out;

  const visible = zones.filter((z) => z.coverage > 0);
  if (!visible.length) return ['nothing rendered'];
  const body = visible[0];
  const accents = visible.slice(1).filter((z) => !z.tiny);
  out.push(accents.length ? `${accents.length} accent zone(s) over a dominant body colour`
                          : 'single-colour body with no visible accent');

  for (const a of accents) {
    const pct = Math.round(a.coverage * 100);
    // A tight vertical spread means the colour is concentrated in a band.
    const banded = (a.spreadY ?? 1) < 0.16;
    const where = (a.centroidY ?? 0.5) < 0.38 ? 'upper' : (a.centroidY ?? 0.5) > 0.62 ? 'lower' : 'mid';
    if (banded) out.push(`${pct}% band across the ${where} garment`);
    else if (pct <= 4) out.push(`${pct}% fine detail — piping or pinstripe`);
    else out.push(`${pct}% spread across the garment`);
  }

  const accentTotal = accents.reduce((s, a) => s + a.coverage, 0);
  out.push(accentTotal > 0.35 ? 'bold — accents dominate'
         : accentTotal > 0.12 ? 'balanced — clear accents on a solid base'
         : 'subtle — mostly one colour');
  if (body.coverage > 0.85) out.push('minimal decoration');
  if (unset.length) out.push(`WARNING: ${unset.length} unrequested colour(s) visible — unset zone`);
  if (invisible.length) out.push(`WARNING: ${invisible.length} zone(s) rendered nothing (${invisible.join(', ')}) — neutral default`);
  return out;
}

/** Build the imaging URL for one design line with the probe colours applied. */
export function buildProbeUrl(
  host: string, pattern: string, style: string, designLineSlug: string,
  probes: { zone: string; colour: ProbeColour }[], width = 600,
): string {
  const fill = (name: string) =>
    encodeURIComponent(`<fill><SolidColor s7:colorName='${name}' s7:colorspace='defined'/></fill>`);
  const id = pattern.replace('{style}', style);
  let u = `${host}/${id}?fmt=png&wid=${width}`
        + `&setAttr.swatch=${encodeURIComponent('{visible=false}')}`
        + `&setAttr.${encodeURIComponent(designLineSlug)}=${encodeURIComponent('{visible=true}')}`;
  for (const p of probes) u += `&setElement.${p.zone}=${fill(p.colour.render)}`;
  return u;
}

/** Fetch and decode one render. Returns null rather than throwing so a bulk
 *  pass degrades per design instead of aborting. */
export async function fetchPng(url: string, timeoutMs = 30000): Promise<{ png: PNG; bytes: number } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A missing template answers 200 with a tiny body rather than a 404.
    if (buf.length < 2000) return null;
    return { png: PNG.sync.read(buf), bytes: buf.length };
  } catch {
    return null;
  }
}

/**
 * Measure what a palette colour actually renders as.
 *
 * The palette gives names, not RGB, and the imaging host applies its own
 * lighting — so the only honest way to know what "RA ROYAL" looks like on cloth
 * is to render it and read the pixels.
 */
export async function calibrateProbe(
  host: string, pattern: string, style: string, designLineSlug: string,
  zones: string[], colourName: string,
): Promise<ProbeColour | null> {
  const probes = zones.map((z) => ({ zone: z, colour: { render: colourName, rgb: [0, 0, 0] as [number, number, number] } }));
  const got = await fetchPng(buildProbeUrl(host, pattern, style, designLineSlug, probes, 400));
  if (!got) return null;

  // Dominant non-neutral colour = the garment wearing this colour everywhere.
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  const { png } = got;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      if (png.data[i + 3] < 200) continue;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (isNeutral(r, g, b)) continue;
      const k = `${r >> 4}:${g >> 4}:${b >> 4}`;
      const s = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      s.n++; s.r += r; s.g += g; s.b += b;
      buckets.set(k, s);
    }
  }
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < 500) return null;
  const rgb: [number, number, number] = [Math.round(top.r / top.n), Math.round(top.g / top.n), Math.round(top.b / top.n)];
  return { render: colourName, rgb, hsv: hsv(...rgb) };
}
