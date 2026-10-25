'use client';

/**
 * "View as" for the Agents tab: pick shopper or staff (and staff groups) and see which agents that person would get from the project's
 * current settings, which one opens first, and any group that matches no team. Read-only; it asks the project service through the BFF
 * and never changes anything.
 */
import { useState } from 'react';
import { describePreviewAgent, previewNote, previewQuery, readAccessPreview, type AccessPreview, type PreviewAudience } from '@/lib/customize/accessPreview';

export function ViewAs() {
  const [audience, setAudience] = useState<PreviewAudience>('shopper');
  const [groups, setGroups] = useState('');
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; message?: string; preview?: AccessPreview }>({ status: 'idle' });

  const show = async () => {
    setState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const search = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('project') || '';
      const res = await fetch(`/api/customize/access-preview?${previewQuery(audience, groups)}${search ? `&project=${encodeURIComponent(search)}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || 'The preview could not be read just now.');
      const preview = readAccessPreview(body);
      if (!preview) throw new Error('The preview came back in a shape this page does not understand.');
      setState({ status: 'idle', preview });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'The preview could not be read just now.' });
    }
  };

  const { preview } = state;
  return (
    <section aria-label="View as" style={{ marginTop: 28 }}>
      <h2 className="ax-section-title">Who can use which agent</h2>
      <p style={{ margin: '0 0 10px', color: 'var(--ax-text-muted, #6b6b6b)' }}>
        Pick a kind of person and see the agents they would get. Nothing here changes what anyone sees.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          View as{' '}
          <select value={audience} onChange={(e) => setAudience(e.target.value as PreviewAudience)} aria-label="View as">
            <option value="shopper">A shopper</option>
            <option value="staff">A member of staff</option>
          </select>
        </label>
        {audience === 'staff' && (
          <label>
            Groups{' '}
            <input type="text" value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="customer-service, sales" aria-label="Staff groups, separated by commas" style={{ minWidth: 220 }} />
          </label>
        )}
        <button type="button" className="ax-btn ax-btn--small" onClick={show} disabled={state.status === 'loading'}>{state.status === 'loading' ? 'Looking…' : 'Show'}</button>
      </div>
      {state.status === 'error' && <p role="alert" style={{ color: 'var(--ax-danger, #b3261e)' }}>{state.message}</p>}
      {preview && (
        <div style={{ marginTop: 12 }}>
          {preview.agents.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {preview.agents.map((agent) => (
                <li key={agent.agentId} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <strong>{agent.name}</strong>
                  <span className="ax-tag">{describePreviewAgent(agent)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p><strong>No agents.</strong></p>
          )}
          {preview.unknownGroups.length > 0 && (
            <p style={{ marginTop: 8 }}>
              <strong>Not a team of this project:</strong> {preview.unknownGroups.join(', ')}. A group has to match a team name to apply to anyone.
            </p>
          )}
          <p style={{ marginTop: 8, color: 'var(--ax-text-muted, #6b6b6b)' }}>{previewNote(preview)}</p>
        </div>
      )}
    </section>
  );
}
