'use client';

/**
 * Loads the Customize overview (agents, skills, knowledge, connectors) once per tenant and shares it between the pages that
 * need it (the Customize page and the composer's agent chip). A failure is kept as a message, never thrown into the page.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CustomizeOverview } from '@/lib/customize/types';

interface Entry {
  data?: CustomizeOverview;
  error?: string;
  promise?: Promise<void>;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const keyFor = () => (typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('project') || '');

function load(key: string, force = false): Promise<void> {
  const entry = cache.get(key) || {};
  if (entry.promise) return entry.promise;
  if (entry.data && !force) return Promise.resolve();
  const search = key ? `?project=${encodeURIComponent(key)}` : '';
  const promise = fetch(`/api/customize/overview${search}`, { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || 'The assistant configuration could not be loaded.');
      cache.set(key, { data: body as CustomizeOverview });
    })
    .catch((err: unknown) => {
      cache.set(key, { data: entry.data, error: err instanceof Error ? err.message : 'The assistant configuration could not be loaded.' });
    })
    .finally(notify);
  cache.set(key, { ...entry, promise });
  return promise;
}

export function useOverview(): { data?: CustomizeOverview; error?: string; loading: boolean; reload: () => void } {
  const [, force] = useState(0);
  const key = keyFor();

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    void load(key);
    return () => { listeners.delete(rerender); };
  }, [key]);

  const reload = useCallback(() => { cache.set(key, { data: cache.get(key)?.data }); void load(key, true); force((n) => n + 1); }, [key]);
  const entry = cache.get(key);
  return { data: entry?.data, error: entry?.error, loading: !entry || (!!entry.promise && !entry.data && !entry.error), reload };
}
