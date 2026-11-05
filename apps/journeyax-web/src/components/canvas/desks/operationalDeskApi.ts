'use client';
import { useEffect, useState } from 'react';

export interface DeskSummary { deskId: string; title: string; description?: string; boardTitle?: string; recordType?: string }
export interface CasePreparation { status: string; workId?: string; summary?: string; actionCount?: number; progress?: { summary: string; actions: Array<{ confirmationId: string; outcome: string }> } }
export interface DeskRecord { prepared?: CasePreparation; canonicalId: string; thing: string; values: Record<string, unknown>; ask: string; provenance: Array<{ fact: string; status: string; source?: { displayName?: string; sample?: boolean }; contract?: { unit?: string; currency?: string } }> }
export interface DeskField { field: string; label: string; format?: 'text' | 'date' | 'messages' | 'tags'; messageFields?: { body: string; author?: string; time?: string; visibility?: string } }
export interface DeskBoard { title: string; groupBy: string; titleField: string; groups: Array<{ value: string; label: string }> }
export interface DeskView { ok: true; desk: DeskSummary; columns: DeskField[]; records: DeskRecord[]; status: 'complete' | 'partial' | 'ambiguous' | 'no_match'; sample: boolean; queryId: string; page?: { more: boolean; nextCursor?: string }; board?: DeskBoard; refreshSeconds?: number; preparationAvailable?: boolean; preparationMode?: 'background' }

export const deskUrl = (projectId: string, deskId?: string, recordId?: string, cursor?: string) => `/api/desks${deskId ? `/${encodeURIComponent(deskId)}` : ''}?project=${encodeURIComponent(projectId)}${recordId !== undefined ? `&recordId=${encodeURIComponent(recordId)}` : ''}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

export function useOperationalDesks(person: string | undefined, projectId: string): DeskSummary[] {
  const [state, setState] = useState<{ owner: string; entries: DeskSummary[] }>({ owner: '', entries: [] });
  const owner = `${projectId}:${person ?? ''}`;
  useEffect(() => {
    const controller = new AbortController();
    if (person) void fetch(deskUrl(projectId), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = response.ok ? await response.json() : {};
      if (!controller.signal.aborted) setState({ owner, entries: Array.isArray(data.desks) ? data.desks.filter((desk: any) => typeof desk?.deskId === 'string' && typeof desk.title === 'string') : [] });
    }).catch(() => { if (!controller.signal.aborted) setState({ owner, entries: [] }); });
    return () => controller.abort();
  }, [owner, person, projectId]);
  return person && state.owner === owner ? state.entries : [];
}
