import { createHash } from 'node:crypto';

export interface OkfArtifactStore {
  put(key: string, bytes: Uint8Array, checksum: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  verify(key: string, checksum: string): Promise<boolean>;
}

export function okfArtifactKey(input: { tenantId: string; environmentId: string; releaseId: string; checksum: string }): string {
  for (const [field, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error(`Invalid OKF artifact ${field}`);
  }
  return `${input.tenantId}/${input.environmentId}/${input.releaseId}/${input.checksum}/bundle.zip`;
}

export function okfArtifactChecksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Isolated tests can use this store without cloud credentials. */
export class MemoryOkfArtifactStore implements OkfArtifactStore {
  private readonly objects = new Map<string, Uint8Array>();
  constructor(private readonly bucket = 'isolated-okf-test') {}
  async put(key: string, bytes: Uint8Array, checksum: string): Promise<string> {
    if (okfArtifactChecksum(bytes) !== checksum.replace(/^sha256:/, '')) throw new Error('OKF artifact checksum mismatch');
    const existing = this.objects.get(key);
    if (existing && okfArtifactChecksum(existing) !== checksum.replace(/^sha256:/, '')) throw new Error('Immutable OKF artifact collision');
    if (!existing) this.objects.set(key, new Uint8Array(bytes));
    return `gs://${this.bucket}/${key}`;
  }
  async get(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`OKF artifact not found: ${key}`);
    return new Uint8Array(found);
  }
  async exists(key: string): Promise<boolean> { return this.objects.has(key); }
  async verify(key: string, checksum: string): Promise<boolean> {
    return this.objects.has(key) && okfArtifactChecksum(this.objects.get(key)!) === checksum.replace(/^sha256:/, '');
  }
}

/** Uses GCS JSON API with generation precondition zero for write-once snapshots. */
export class GcsOkfArtifactStore implements OkfArtifactStore {
  constructor(private readonly bucket: string, private readonly tokenProvider?: () => Promise<string>) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bucket)) throw new Error('Invalid GCS bucket');
  }

  private async token(): Promise<string> {
    if (this.tokenProvider) return this.tokenProvider();
    const { GoogleAuth } = require('google-auth-library') as typeof import('google-auth-library');
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] }).getClient();
    const result = await client.getAccessToken();
    if (!result.token) throw new Error('GCS access token unavailable');
    return result.token;
  }

  private objectUrl(key: string, media = false): string {
    if (!key || key.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid GCS object key');
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
    return media ? `${url}?alt=media` : url;
  }

  async put(key: string, bytes: Uint8Array, checksum: string): Promise<string> {
    if (okfArtifactChecksum(bytes) !== checksum.replace(/^sha256:/, '')) throw new Error('OKF artifact checksum mismatch');
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=0`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/zip' },
      body: Buffer.from(bytes),
    });
    if (response.status === 412) {
      if (!await this.verify(key, checksum)) throw new Error('Immutable GCS object exists with a different checksum');
    } else if (!response.ok) {
      throw new Error(`GCS immutable upload failed: HTTP ${response.status}`);
    }
    return `gs://${this.bucket}/${key}`;
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await fetch(this.objectUrl(key, true), { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!response.ok) throw new Error(`GCS artifact read failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const response = await fetch(this.objectUrl(key), { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`GCS metadata read failed: HTTP ${response.status}`);
    return true;
  }

  async verify(key: string, checksum: string): Promise<boolean> {
    if (!await this.exists(key)) return false;
    return okfArtifactChecksum(await this.get(key)) === checksum.replace(/^sha256:/, '');
  }
}
