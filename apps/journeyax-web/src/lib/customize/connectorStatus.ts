/**
 * Whether each connected system is really connected, from the connector servers' own health answers (`GET /health`, which lists each system
 * with `connected` and the names of any settings it still needs). Optional: the web app learns where the servers are from
 * `CONNECTOR_STATUS_URLS` (addresses separated by commas); without it nothing is claimed, and the screen says "not checked".
 *
 * Only names of missing settings are passed on (for example SALESFORCE_CLIENT_ID), never a value, and only well-formed ones.
 */
import type { SystemStatus } from './types';

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export async function readConnectorStatuses(urls: string[], fetchImpl: typeof fetch = fetch): Promise<Record<string, SystemStatus>> {
  const out: Record<string, SystemStatus> = {};
  await Promise.all(urls.map(async (base) => {
    try {
      const res = await fetchImpl(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      if (!res.ok) return;
      const body: any = await res.json().catch(() => ({}));
      for (const entry of Array.isArray(body?.connectors) ? body.connectors : []) {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        if (!id || out[id]) continue;
        out[id] = {
          checked: true,
          connected: entry.connected === true,
          missing: (Array.isArray(entry.missing) ? entry.missing : []).filter((name: unknown): name is string => typeof name === 'string' && NAME.test(name)).slice(0, 12),
        };
      }
    } catch { /* an unreachable server is "not checked", not an error */ }
  }));
  return out;
}

export const statusUrlsFromEnv = (value: string | undefined): string[] => (value || '').split(',').map((entry) => entry.trim()).filter((entry) => /^https?:\/\//.test(entry));
