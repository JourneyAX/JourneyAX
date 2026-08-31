import { Injectable, Logger } from '@nestjs/common';

/**
 * FabricDiffusion (Job 1 fidelity) — hosted on Replicate.
 *
 * Turns the rough Gemini-isolated layers into PRODUCTION-clean ingredients, the
 * way the FabricDiffusion paper does (arxiv 2410.01801):
 *   mode 'texture' → a distortion-free, SEAMLESS, tileable fabric texture
 *   mode 'print'   → a clean logo on a TRANSPARENT background (RGBA)
 * The 3D viewer then tiles the texture across the garment UV and overlays the
 * print (the paper's "Tiling & Overlaying" step).
 *
 * Runs on our own Replicate deployment (amahaveer/fabric-diffusion). Entirely
 * best-effort: with no token, or on any failure, returns null and the caller
 * falls back to the Gemini layer — the journey never blocks on it (platform
 * rule 10, graceful degradation).
 */
@Injectable()
export class FabricService {
  private readonly log = new Logger('FabricService');
  private readonly token = process.env.REPLICATE_API_TOKEN || '';
  private readonly version =
    process.env.FABRIC_DIFFUSION_VERSION
    || '28c3fe1bb6485fde2ace7407230682b70af4f309da3140516b5d60d6904bcb27';
  /** When set (owner/name), calls go to a keep-warm DEPLOYMENT — no cold starts,
   *  and it doesn't fight the account's version-based predictions for capacity. */
  private readonly deployment = process.env.FABRIC_DIFFUSION_DEPLOYMENT || '';

  /** Reason the last clean() returned null — surfaced for debugging the path. */
  lastReason = '';

  get enabled(): boolean { return this.token.length > 10; }

  /** Clean one layer. `dataUrl` is a data: URL; returns a data: URL or null. */
  async clean(dataUrl: string, mode: 'texture' | 'print'): Promise<string | null> {
    if (!this.enabled) { this.lastReason = `${mode}:disabled`; return null; }
    if (!dataUrl || !dataUrl.startsWith('data:')) { this.lastReason = `${mode}:bad-input`; return null; }
    const auth = { Authorization: `Bearer ${this.token}` };
    try {
      // A warm deployment has its own predictions endpoint (no version in body);
      // otherwise fall back to a version-pinned prediction (cold-starts).
      const url = this.deployment
        ? `https://api.replicate.com/v1/deployments/${this.deployment}/predictions`
        : 'https://api.replicate.com/v1/predictions';
      const payload = this.deployment
        ? { input: { image: dataUrl, mode, num_samples: 1 } }
        : { version: this.version, input: { image: dataUrl, mode, num_samples: 1 } };
      // Replicate throttles hard (6/min, burst 1) while the account balance is
      // under $5. Our two calls (texture then print) fire seconds apart, so the
      // 2nd routinely 429s. Retry with a backoff long enough to clear the window
      // (6/min = one per ~10s) so both layers complete even while throttled.
      let created = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      for (let attempt = 0; created.status === 429 && attempt < 3; attempt++) {
        this.lastReason = `${mode}:429-backoff-${attempt}`;
        await new Promise((r) => setTimeout(r, 12_000));
        created = await fetch(url, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      if (!created.ok) {
        const t = (await created.text()).slice(0, 200);
        this.lastReason = `${mode}:create-${created.status}:${t}`;
        this.log.warn(`replicate create ${created.status}: ${t}`);
        return null;
      }
      let pred: any = await created.json();
      const getUrl: string = pred?.urls?.get;
      // First call cold-starts: boot a GPU + load BOTH checkpoints (~8GB). That
      // has been observed at up to ~7 min, so wait generously — timing out early
      // just wastes the boot and silently drops to the rough Gemini layer.
      const deadline = Date.now() + 600_000;
      while (pred && !['succeeded', 'failed', 'canceled'].includes(pred.status)) {
        if (Date.now() > deadline) { this.lastReason = `${mode}:poll-timeout`; return null; }
        await new Promise((r) => setTimeout(r, 2500));
        pred = await fetch(getUrl, { headers: auth }).then((r) => r.json());
      }
      if (pred?.status !== 'succeeded') {
        this.lastReason = `${mode}:${pred?.status}:${String(pred?.error).slice(0, 160)}`;
        this.log.warn(`replicate ${pred?.status}: ${String(pred?.error).slice(0, 160)}`);
        return null;
      }
      const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (!out) { this.lastReason = `${mode}:no-output`; return null; }
      const img = await fetch(out);
      if (!img.ok) { this.lastReason = `${mode}:img-fetch-${img.status}`; return null; }
      const mime = img.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await img.arrayBuffer());
      this.lastReason = `${mode}:ok`;
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e: any) {
      this.lastReason = `${mode}:exc:${String(e?.message || e).slice(0, 160)}`;
      this.log.warn(`fabric clean error: ${e?.message || e}`);
      return null;
    }
  }
}
