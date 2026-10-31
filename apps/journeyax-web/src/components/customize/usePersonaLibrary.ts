'use client';

/**
 * Loads the persona library for the Personas tab and saves the tools of one scenario. Nothing is fetched unless `enabled` (the tab is
 * open and the person may see it). A failure is kept as a plain message, never thrown into the page.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PersonaLibraryAnswer } from '@/lib/customize/personas';

export type SaveOutcome = { ok: true } | { ok: false; error: string; conflict: boolean };

export function usePersonaLibrary(enabled: boolean, tenant: string | undefined) {
  const [answer, setAnswer] = useState<PersonaLibraryAnswer | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const url = `/api/customize/personas?project=${encodeURIComponent(tenant || '')}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(String(body?.error || 'The persona library could not be loaded.')); return; }
      setAnswer(body as PersonaLibraryAnswer);
      setError('');
    } catch {
      setError('The persona library could not be loaded: the service did not answer.');
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { if (enabled) void load(); }, [enabled, load]);

  const save = useCallback(async (useCaseId: string, tools: string[]): Promise<SaveOutcome> => {
    if (!answer || !answer.present) return { ok: false, error: 'No persona library is loaded.', conflict: false };
    try {
      const res = await fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useCaseId, tools, expectedRevision: answer.revision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { if (res.status === 409) void load(); return { ok: false, error: String(body?.error || 'The tools could not be saved.'), conflict: res.status === 409 }; }
      await load();
      return { ok: true };
    } catch {
      return { ok: false, error: 'The tools could not be saved: the service did not answer.', conflict: false };
    }
  }, [answer, url, load]);

  const savePrompt = useCallback(async (useCaseId: string, prompt: string): Promise<SaveOutcome> => {
    if (!answer || !answer.present) return { ok: false, error: 'No persona library is loaded.', conflict: false };
    try {
      const res = await fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useCaseId, prompt, expectedRevision: answer.revision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { if (res.status === 409) void load(); return { ok: false, error: String(body?.error || 'The question could not be saved.'), conflict: res.status === 409 }; }
      await load();
      return { ok: true };
    } catch {
      return { ok: false, error: 'The question could not be saved: the service did not answer.', conflict: false };
    }
  }, [answer, url, load]);

  return { answer, error, loading: loading && !answer, reload: load, save, savePrompt };
}
