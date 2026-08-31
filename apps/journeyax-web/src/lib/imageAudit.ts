/**
 * Client-side print/manufacturability audit — pure pixel math on an already-
 * loaded <img>, no server call. Extracted from CandyDesignPanel's inline
 * `auditImage` (MMS-03, candy print feasibility) so the same resolution/
 * contrast/background-uniformity checks can be reused for other decoration
 * surfaces (garment panels, etc.) with their own tuned thresholds — the logic
 * was already generic; only the M&M'S-specific copy and 1cm-print framing were
 * candy-specific.
 *
 * Honest scope: this reads PIXELS, not geometry. It cannot know where a real
 * cut-piece seam falls on a 3D garment — the `edgeMarginPct` check is a proxy
 * ("does the artwork run close to the panel's own edge"), not real UV/seam
 * boundary detection. Label it as a heuristic wherever it's surfaced.
 */
export interface AuditReport { level: 'warn' | 'info'; text: string }

export interface AuditThresholds {
  /** Minimum shortest-side px before flagging as soft/low-res for print. */
  minPx: number;
  /** Below this dark-pixel ratio, the design reads as too pale/low-contrast. */
  minDarkPct: number;
  /** Edge-luminance std-dev below this reads as a "plain" background. */
  plainBgEdgeStd: number;
  /** Fraction of the canvas near each edge to sample for the seam-margin proxy. */
  edgeMarginPct: number;
}

export const CANDY_THRESHOLDS: AuditThresholds = {
  minPx: 250, minDarkPct: 0.06, plainBgEdgeStd: 26, edgeMarginPct: 0,
};

/** Tuned for a printed garment panel rather than a ~1cm candy print: a lower
 *  resolution floor (garment art is viewed from further away), and an added
 *  edge-margin check as the "near a cut-piece boundary" proxy. */
export const GARMENT_THRESHOLDS: AuditThresholds = {
  minPx: 400, minDarkPct: 0.04, plainBgEdgeStd: 30, edgeMarginPct: 0.06,
};

/** Read an already-loaded <img> element's pixels and report resolution,
 *  contrast and background/edge findings. Synchronous — caller ensures the
 *  image has finished loading (`img.complete` or an `onload` handler). */
export function auditImage(img: HTMLImageElement, thresholds: AuditThresholds = CANDY_THRESHOLDS): AuditReport[] {
  const w = img.naturalWidth, h = img.naturalHeight;
  const N = 120;
  const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  if (!ctx || !w || !h) return [];
  ctx.drawImage(img, 0, 0, N, N);
  let data: Uint8ClampedArray;
  try { data = ctx.getImageData(0, 0, N, N).data; } catch { return []; }

  let hasAlpha = false, dark = 0, total = 0;
  const edge: number[] = [];
  const margin = Math.max(1, Math.round(N * thresholds.edgeMarginPct));
  let nearMarginInk = 0, nearMarginTotal = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const a = data[i + 3];
    if (a < 245) hasAlpha = true;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (a > 40) { total++; if (lum < 110) dark++; }
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) edge.push(lum);
    // Seam-margin proxy: ink (opaque, non-background pixel) within `margin`
    // texels of the canvas edge — a stand-in for "artwork runs to the panel
    // boundary," since a flat 2D view carries no real cut-piece geometry.
    if (margin > 0 && (x < margin || y < margin || x >= N - margin || y >= N - margin)) {
      nearMarginTotal++;
      if (a > 40 && lum < 230) nearMarginInk++;
    }
  }
  const eMean = edge.reduce((s, v) => s + v, 0) / (edge.length || 1);
  const edgeStd = Math.sqrt(edge.reduce((s, v) => s + (v - eMean) ** 2, 0) / (edge.length || 1));
  const darkPct = total ? dark / total : 0;

  const rep: AuditReport[] = [];
  if (Math.min(w, h) < thresholds.minPx) {
    rep.push({ level: 'warn', text: `This image is ${w}×${h}px — a bit small for print; a sharper source will look cleaner.` });
  } else {
    rep.push({ level: 'info', text: `Resolution ${w}×${h}px — enough detail for a clean print.` });
  }
  if (darkPct < thresholds.minDarkPct) {
    rep.push({ level: 'warn', text: 'This design is very light/low-contrast — it may read as faint once printed.' });
  } else {
    rep.push({ level: 'info', text: 'Good contrast — the design should read clearly once printed.' });
  }
  if (hasAlpha) {
    rep.push({ level: 'info', text: 'Transparent background — lifts out cleanly.' });
  } else if (edgeStd < thresholds.plainBgEdgeStd) {
    rep.push({ level: 'info', text: 'Plain background detected — clean to isolate.' });
  } else {
    rep.push({ level: 'warn', text: 'Busy background — automatic background removal may leave stray marks.' });
  }
  if (margin > 0 && nearMarginTotal > 0 && nearMarginInk / nearMarginTotal > 0.35) {
    rep.push({ level: 'warn', text: 'Artwork runs close to the panel edge — this is a heuristic proxy, not real cut-piece geometry, but it often means a seam. Consider pulling it in a little.' });
  }
  return rep;
}

/** Convenience: load a data:/http URL into an <img> and audit it. */
export function auditImageUrl(url: string, thresholds?: AuditThresholds): Promise<AuditReport[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(auditImage(img, thresholds));
    img.onerror = () => resolve([{ level: 'warn', text: "Couldn't read that image — try a JPG or PNG." }]);
    img.src = url;
  });
}
