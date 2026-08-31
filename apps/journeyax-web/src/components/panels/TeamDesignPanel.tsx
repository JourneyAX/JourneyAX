'use client';

/**
 * Team Design panel — the coach's approval checkpoint for a whole-team look
 * (Coach Team-Order Journey, Step 2).
 *
 * `generateTeamDesign` produces up to four FLAT 2D views (front/back/left/
 * right) from the accumulated brief — no 3D bake yet, that happens once the
 * coach approves and the roster + real mesh take over (teamPreview phase).
 * A view can be absent if its generation failed; that view shows a "not
 * generated" placeholder rather than a broken image, and never blocks the
 * others from rendering.
 *
 * Each loaded view gets a client-side manufacturability heuristic (imageAudit,
 * GARMENT_THRESHOLDS) — resolution / contrast / edge-margin proxy, the same
 * honest-heuristic framing as CandyDesignPanel's print audit. This reads
 * PIXELS, not real cut-piece geometry.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { auditImageUrl, AuditReport, GARMENT_THRESHOLDS } from '@/lib/imageAudit';

type ViewKey = 'front' | 'back' | 'left' | 'right';
const VIEWS: { key: ViewKey; label: string; idKey: 'frontId' | 'backId' | 'leftId' | 'rightId' }[] = [
  { key: 'front', label: 'Front', idKey: 'frontId' },
  { key: 'back', label: 'Back', idKey: 'backId' },
  { key: 'left', label: 'Left sleeve', idKey: 'leftId' },
  { key: 'right', label: 'Right sleeve', idKey: 'rightId' },
];

export default function TeamDesignPanel() {
  const { state, dispatch } = useJourney();
  const teamDesign = state.teamDesign || {};

  // Same project-id resolution as ConfiguratorPanel/CandyDesignPanel — a URL
  // query param, since this panel has no config context of its own to read it from.
  const project = useMemo(
    () => (typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('project') || ''),
    [],
  );

  const conceptUrl = (id?: string) =>
    id ? `/api/cdl/concept/${encodeURIComponent(id)}${project ? `?project=${encodeURIComponent(project)}` : ''}` : '';

  const [audits, setAudits] = useState<Record<string, AuditReport[]>>({});

  useEffect(() => {
    let cancelled = false;
    for (const v of VIEWS) {
      const id = (teamDesign as any)[v.idKey] as string | undefined;
      if (!id) continue;
      auditImageUrl(conceptUrl(id), GARMENT_THRESHOLDS).then((rep) => {
        if (!cancelled) setAudits((prev) => ({ ...prev, [id]: rep }));
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamDesign.frontId, teamDesign.backId, teamDesign.leftId, teamDesign.rightId]);

  const anyView = !!(teamDesign.frontId || teamDesign.backId || teamDesign.leftId || teamDesign.rightId);

  const send = (t: string) => (window as any).__journeySend?.(t);

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Team design</div>
          <h2 className="clarify-panel__heading">Your team's look</h2>
          <p className="clarify-panel__desc">
            Four flat views of the design — front, back, and both sleeves. This is a fast 2D preview, not the
            final 3D mesh; once you approve, the roster and the real garment take over.
          </p>

          {teamDesign.brief && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 18,
                          padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--surface-alt)' }}>
              <strong style={{ color: 'var(--text)' }}>Brief:</strong> {teamDesign.brief}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {VIEWS.map((v) => {
              const id = (teamDesign as any)[v.idKey] as string | undefined;
              const rep = id ? audits[id] : undefined;
              return (
                <div key={v.key} className="product-card" style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
                                color: 'var(--text-muted)', padding: '10px 12px 0' }}>{v.label}</div>
                  <div style={{ aspectRatio: '1 / 1', margin: 10, borderRadius: 8, overflow: 'hidden',
                                background: 'var(--surface-alt)', display: 'flex', alignItems: 'center',
                                justifyContent: 'center' }}>
                    {id ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={conceptUrl(id)} alt={`${v.label} view`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    ) : (
                      <span style={{ fontSize: 11.5, color: 'var(--text-faint)', textAlign: 'center', padding: 12 }}>
                        Not generated
                      </span>
                    )}
                  </div>
                  {id && (
                    <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(rep || []).map((r, i) => (
                        <span key={i} style={{ fontSize: 10.5, lineHeight: 1.4, borderRadius: 6, padding: '3px 7px',
                                                display: 'inline-flex', alignItems: 'flex-start', gap: 4,
                                                color: r.level === 'warn' ? '#B58A3C' : 'var(--text-muted)',
                                                background: r.level === 'warn' ? 'rgba(181,138,60,.10)' : 'var(--surface-alt)' }}>
                          <span>{r.level === 'warn' ? '⚠' : '✅'}</span>
                          <span>{r.text}</span>
                        </span>
                      ))}
                      {!rep && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Checking print feasibility…</span>}
                    </div>
                  )}
                  {!id && (teamDesign as any)[`${v.key}Error`] && (
                    <div style={{ padding: '0 12px 12px', fontSize: 10.5, color: '#B58A3C' }}>
                      {(teamDesign as any)[`${v.key}Error`]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!anyView && (
            <p style={{ color: 'var(--text-muted)', marginTop: 16 }}>
              No views generated yet — describe the team's look in chat (sport, colours, garment, any lettering) to get started.
            </p>
          )}
        </div>
      </div>

      <div className="clarify-panel__footer" style={{ display: 'flex', gap: 10 }}>
        <button
          className="clarify-build-btn"
          style={{ flex: 1 }}
          disabled={!anyView}
          onClick={() => {
            dispatch({ type: 'SET_PHASE', phase: 'teamRoster' });
            send("That design looks great — let's do the roster.");
          }}
        >
          Approve — let's do the roster →
        </button>
        <button
          className="clarify-build-btn"
          style={{ flex: 1, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
          onClick={() => send('Can you make some changes to the design first?')}
        >
          Ask for changes
        </button>
      </div>
    </div>
  );
}
