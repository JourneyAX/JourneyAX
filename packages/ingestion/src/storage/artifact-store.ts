/**
 * Artifact storage (AUG-8) — the "Object Storage" block on the architecture board.
 *
 * Ingestion pulls large binaries (CSV feeds, catalogue PDFs — 2.6 GB for one
 * tenant). Those must never live in the repo or on a pod's local disk in prod.
 * The pipeline talks to `ArtifactStorePort`; which implementation backs it is a
 * deployment concern:
 *
 *   local  → dev (a directory per project)
 *   gcs    → prod (gs://<bucket>/<projectId>/<key>)
 *
 * Keys are ALWAYS project-scoped, so tenants can never collide or read each
 * other's artifacts, and a project's data can be deleted wholesale.
 */
import { ArtifactStorePort } from '../ports';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** Local filesystem store — development and single-node runs. */
export class LocalArtifactStore implements ArtifactStorePort {
  readonly kind = 'local' as const;
  constructor(private readonly root: string) {}

  resolve(projectId: string, key: string): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    return path.join(this.root, projectId, key);
  }

  async exists(projectId: string, key: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, statSync } = require('fs');
    const p = this.resolve(projectId, key);
    return existsSync(p) && statSync(p).size > 1024;
  }

  async fetchInto(projectId: string, key: string, url: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync, createWriteStream } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const { Readable } = await import('stream');
    const { pipeline } = await import('stream/promises');

    const dest = this.resolve(projectId, key);
    if (await this.exists(projectId, key)) return dest;      // idempotent
    mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return dest;
  }
}

/**
 * Google Cloud Storage store — production.
 *
 * Objects live at gs://<bucket>/<projectId>/<key>. Because the PDF/CSV parsers
 * need a real file handle, `fetchInto` streams the object down to a local cache
 * path and returns that; the durable copy stays in the bucket. `@google-cloud/storage`
 * is loaded lazily so dev installs don't need the dependency.
 */
export class GcsArtifactStore implements ArtifactStorePort {
  readonly kind = 'gcs' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bucketRef: any;

  constructor(
    private readonly bucket: string,
    private readonly localCacheRoot: string,
    private readonly prefix = '',
  ) {}

  private async getBucket() {
    if (!this.bucketRef) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Storage } = require('@google-cloud/storage');
      this.bucketRef = new Storage().bucket(this.bucket);
    }
    return this.bucketRef;
  }

  private objectName(projectId: string, key: string): string {
    return [this.prefix, projectId, key].filter(Boolean).join('/');
  }

  resolve(projectId: string, key: string): string {
    return `gs://${this.bucket}/${this.objectName(projectId, key)}`;
  }

  async exists(projectId: string, key: string): Promise<boolean> {
    const bucket = await this.getBucket();
    const [ok] = await bucket.file(this.objectName(projectId, key)).exists();
    return ok;
  }

  /** Ensure the object is in the bucket, then materialise a local copy to parse. */
  async fetchInto(projectId: string, key: string, url: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync, existsSync, statSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const bucket = await this.getBucket();
    const object = bucket.file(this.objectName(projectId, key));

    if (!(await this.exists(projectId, key))) {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
      const { Readable } = await import('stream');
      const { pipeline } = await import('stream/promises');
      await pipeline(Readable.fromWeb(res.body as never), object.createWriteStream({ resumable: true }));
    }

    const local = path.join(this.localCacheRoot, projectId, key);
    if (!existsSync(local) || statSync(local).size < 1024) {
      mkdirSync(path.dirname(local), { recursive: true });
      await object.download({ destination: local });
    }
    return local;
  }
}

/**
 * Build the store from deployment config — the pipeline never chooses.
 *   ARTIFACT_STORE=gcs + ARTIFACT_BUCKET=<name> → GCS
 *   otherwise                                    → local (ARTIFACT_DIR or ./data)
 */
export function createArtifactStore(env: NodeJS.ProcessEnv = process.env): ArtifactStorePort {
  const cacheRoot = env.ARTIFACT_DIR || './data';
  if ((env.ARTIFACT_STORE || '').toLowerCase() === 'gcs' && env.ARTIFACT_BUCKET) {
    return new GcsArtifactStore(env.ARTIFACT_BUCKET, cacheRoot, env.ARTIFACT_PREFIX || '');
  }
  return new LocalArtifactStore(cacheRoot);
}
