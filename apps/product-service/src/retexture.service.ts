import { Injectable, Logger } from '@nestjs/common';

/**
 * Client for the Python retexture-service (apps/retexture-service). That service
 * bakes a customer's design onto the real per-SKU 3D mesh: it renders the mesh
 * from each axis, has Gemini paint the design onto each silhouette, then back-
 * projects and bakes the painted views into a UV atlas — producing a
 * `retextured.glb` that wraps the design correctly around collar, hem and sleeves.
 *
 * This is the faithful-in-3D path (P2). It supersedes the flat GPT-image planar
 * projection: that could only front-fill, this wraps the whole garment and comes
 * with real diagnostics (palette+hex, coverage, per-view IoU, verdict).
 *
 * Best-effort by policy (platform rule 10): with no base URL, or on any failure,
 * `bake()` returns null and the caller falls back to the existing flat path.
 */
export interface RetextureDiagnostics {
  mesh?: { name: string; tris: number; verts: number };
  atlas?: string;
  islands?: number;
  coverage?: number;
  views?: { view: string; iou: number; locked: boolean }[];
  palette?: { rgb: number[]; hex: string; share: number }[];
  keepIslands?: number[];
  verdict?: 'good' | 'usable' | 'poor' | 'unknown';
  warnings?: string[];
}

export interface RetextureResult {
  jobId: string;
  /** Absolute URLs (base + the service's /jobs/<id>/… path). */
  glbUrl: string;
  atlasUrl: string;
  previewUrl: string;
  diagnostics: RetextureDiagnostics;
}

export interface BakeInput {
  /** Base mesh — a public URL the service can fetch, or base64. */
  glb: { url?: string; base64?: string; path?: string };
  /** Design references. front is required; back/left/right optional (4-side upload). */
  front: { url?: string; base64?: string; path?: string };
  back?: { url?: string; base64?: string; path?: string };
  left?: { url?: string; base64?: string; path?: string };
  right?: { url?: string; base64?: string; path?: string };
  tier?: 'quality' | 'fast';
  size?: number;
  backText?: string;
  /** Paint a pattern-only back from the front so per-player lettering can be
   *  overlaid client-side (one bake dresses a whole roster). */
  paintBack?: boolean;
  /** Paint the left+right flanks/sleeves from the front (pattern only), so the
   *  sides aren't filled by projection spill. */
  paintSides?: boolean;
  projectId?: string;
}

@Injectable()
export class RetextureService {
  private readonly log = new Logger('RetextureService');
  private readonly baseUrl = (process.env.RETEXTURE_SERVICE_URL || '').replace(/\/$/, '');
  private readonly internalKey = process.env.INTERNAL_API_KEY || '';

  /** Reason the last bake() returned null — surfaced for debugging the path. */
  lastReason = '';

  get enabled(): boolean { return this.baseUrl.length > 0; }

  /** Bake a design onto a mesh. Returns absolute URLs + diagnostics, or null. */
  async bake(input: BakeInput): Promise<RetextureResult | null> {
    if (!this.enabled) { this.lastReason = 'disabled:no-RETEXTURE_SERVICE_URL'; return null; }
    try {
      // The bake renders, calls Gemini per view, and bakes a multi-MB atlas —
      // minutes, not seconds. Give it a generous ceiling (a 4096 quality bake of
      // front+back has been measured ~4-5 min); timing out early wastes the work.
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 15 * 60_000);
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/retexture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': this.internalKey },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(to);
      }
      if (!res.ok) {
        const t = (await res.text().catch(() => '')).slice(0, 300);
        this.lastReason = `http-${res.status}:${t}`;
        this.log.warn(`retexture ${res.status}: ${t}`);
        return null;
      }
      const j: any = await res.json();
      if (!j?.ok) { this.lastReason = `not-ok:${String(j?.error).slice(0, 200)}`; return null; }
      // The service returns root-relative /jobs/<id>/… — make them absolute so
      // the browser (a different origin) can load them directly.
      const abs = (u: string) => (u?.startsWith('http') ? u : `${this.baseUrl}${u}`);
      this.lastReason = 'ok';
      return {
        jobId: j.jobId,
        glbUrl: abs(j.glbUrl),
        atlasUrl: abs(j.atlasUrl),
        previewUrl: abs(j.previewUrl),
        diagnostics: j.diagnostics || {},
      };
    } catch (e: any) {
      this.lastReason = `exc:${String(e?.message || e).slice(0, 200)}`;
      this.log.warn(`retexture bake error: ${e?.message || e}`);
      return null;
    }
  }
}
