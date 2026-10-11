import defaults from './defaults/limits.json';

/**
 * Operational ceilings for authoring payloads. Values are data (defaults/limits.json); drafts are single
 * documents, so the draft ceiling keeps headroom under the database's per-document limit.
 */
export interface OkfLimits {
  draftMaxBytes: number;
  importArchiveMaxBytes: number;
}

export const OKF_LIMITS: Readonly<OkfLimits> = Object.freeze({ ...defaults });

export function resolveOkfLimits(overrides: Partial<OkfLimits> = {}): OkfLimits {
  const merged = { ...OKF_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid OKF limit ${key}`);
  }
  return merged;
}

export class OkfLimitError extends Error {
  constructor(public readonly code: 'draft_too_large', message: string) {
    super(message);
    this.name = 'OkfLimitError';
  }
}

export function assertDraftSize(content: unknown, limits: OkfLimits): number {
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (bytes > limits.draftMaxBytes) {
    throw new OkfLimitError(
      'draft_too_large',
      `OKF draft is ${bytes} bytes; the limit is ${limits.draftMaxBytes}. Split the knowledge into smaller scopes or move large evidence into sources.`,
    );
  }
  return bytes;
}
