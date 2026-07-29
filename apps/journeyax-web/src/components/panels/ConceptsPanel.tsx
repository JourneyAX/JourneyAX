'use client';

/**
 * Three concepts, in the team's colours, before the 3D view.
 *
 * Opening the designer on one arbitrary design line asks the customer to judge a
 * single option with nothing to judge it against — and the design line they
 * landed on was whichever the style happened to list first. A coach choosing kit
 * wants to see a few directions side by side, in their own colours, and then go
 * deep on the one they like.
 *
 * Each card is the real composed print for that design line on that style, not
 * an illustration of one: the same artwork the 3D view wraps onto the mesh and
 * the same file the printer receives. A concept that cannot be composed is not
 * shown, because a card the customer picks must always open.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

interface Concept {
  slug: string;
  label: string;
  texture: string;
}

/** How many directions to offer. Enough to compare, few enough to decide. */
const CONCEPT_COUNT = 3;

/** Route an external asset through our own origin (same reason as the 3D view). */
const proxied = (url: string, project: string) =>
  `/api/products/asset?url=${encodeURIComponent(url)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;

export default function ConceptsPanel() {
  const cfg = useStorefrontConfig();
  const { state, dispatch } = useJourney();
  const design = state.design || {};

  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('loading');
  /* Each card's print is composed on demand and can take seconds to arrive.
     Until it does the card shows a shimmer rather than an empty frame, so the
     panel reads as "being prepared" instead of "broken". */
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});

  const project = useMemo(
    () => (typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('project') || ''),
    [],
  );

  const colours = useMemo(
    () => [design.baseColor, design.accentColor].filter(Boolean) as string[],
    [design.baseColor, design.accentColor],
  );
  const colourKey = colours.join('|');

  useEffect(() => {
    if (!design.sku) return;
    let alive = true;
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    const renderOne = (designLine?: string) =>
      fetch(`/api/products/render${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: design.sku, colours, designLine }),
      }).then((r) => r.json()).catch(() => null);

    (async () => {
      setStatus('loading');
      setConcepts([]);
      setLoaded({});
      /* One probe first: it returns the design lines this STYLE actually offers,
         so we never propose a look it cannot print. */
      const probe = await renderOne(design.designLine);
      if (!alive) return;
      const lines: { slug: string; label: string }[] = probe?.designLines || [];
      if (!lines.length) { setStatus('empty'); return; }

      const wanted = lines.slice(0, CONCEPT_COUNT);
      const built = await Promise.all(wanted.map(async (l) => {
        const r = l.slug === probe?.appliedDesignLine ? probe : await renderOne(l.slug);
        return r?.texture ? { slug: l.slug, label: l.label || l.slug, texture: r.texture } : null;
      }));
      if (!alive) return;
      const ok = built.filter(Boolean) as Concept[];
      setConcepts(ok);
      setStatus(ok.length ? 'ready' : 'empty');
    })();

    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.sku, colourKey, project]);

  /* Picking a concept goes straight to 3D with that design line applied.
     No agent turn in between: the card already holds the exact design line, so
     the same click always opens the same garment. */
  const choose = (c: Concept) => {
    dispatch({ type: 'SET_DESIGN', design: { designLine: c.slug } });
    dispatch({ type: 'SET_PHASE', phase: 'configurator' });
    /* A note, not a message to the agent.
     *
     * Asking it to acknowledge the choice made it render the garment again on
     * its own terms; its answer raced the designer that was already opening and
     * left the panel stuck on "Building your garment…". The click has already
     * applied the design line — there is nothing for the agent to decide, only
     * something for it to know. */
    dispatch({ type: 'ADD_MESSAGE', role: 'note',
      text: `Opening the ${c.label.toLowerCase()} design in 3D — say the word to change the colours, the design or the lettering.` });
  };

  const skip = () => dispatch({ type: 'SET_PHASE', phase: 'configurator' });

  /* Nothing composable for this style — move straight to the designer.
   *
   * This ran as `skip()` inside the render body, which dispatches into
   * JourneyProvider while ConceptsPanel is still rendering. React warns about
   * it because the update is not guaranteed to be applied to the tree being
   * built — so a style with no concepts could sit on a blank step instead of
   * advancing. The move belongs after the render commits, which is what an
   * effect is for. Placed above the early returns so the hook order is the
   * same on every render. */
  useEffect(() => {
    if (status === 'empty') dispatch({ type: 'SET_PHASE', phase: 'configurator' });
  }, [status, dispatch]);

  if (!design.sku) return null;

  if (status === 'loading') {
    return (
      <div className="concepts-panel">
        <div className="concepts-panel__eyebrow">Design directions</div>
        <h2 className="concepts-panel__heading">Sketching a few looks</h2>
        <p className="concepts-panel__desc">
          Putting {colours.length ? colours.join(' and ') : 'your'} colours onto this style…
        </p>
        <div className="thinking" style={{ marginTop: 24 }}>
          <span className="thinking__dot" /><span className="thinking__dot" /><span className="thinking__dot" />
        </div>
      </div>
    );
  }

  // The effect above is moving us to the designer; render nothing meanwhile.
  if (status === 'empty') return null;

  return (
    <div className="concepts-panel">
      <div className="concepts-panel__eyebrow">Design directions</div>
      <h2 className="concepts-panel__heading">
        {concepts.length} looks in {colours.length ? colours.join(' and ') : 'your colours'}
      </h2>
      <p className="concepts-panel__desc">
        {`Same ${(cfg.labels?.itemsSingular || 'style').toLowerCase()} — ${concepts.length} different designs. `}
        Pick one and I&apos;ll open it in 3D, where you can turn it around and change anything.
      </p>

      <div className="concepts-grid">
        {concepts.map((c) => (
          <button
            key={c.slug}
            type="button"
            className={`concept-card${design.designLine === c.slug ? ' is-current' : ''}`}
            onClick={() => choose(c)}
          >
            <div className={`concept-card__art${loaded[c.slug] ? ' is-loaded' : ''}`}>
              {/* The print itself, flat — the same artwork the 3D view wraps.
                  Through our own origin: the imaging host refuses cross-origin
                  requests outright, so a direct src is a broken image.
                  Not lazy: all three are on screen and are the reason the
                  customer is here — deferring them leaves three empty boxes. */}
              <img
                src={proxied(c.texture, project)}
                alt={`${c.label} design`}
                onLoad={() => setLoaded((m) => ({ ...m, [c.slug]: true }))}
              />
            </div>
            <div className="concept-card__label">{c.label}</div>
            <div className="concept-card__cta">
              Open in 3D
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 6 }}>
                <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2"
                      strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </button>
        ))}
      </div>

      <button type="button" className="concepts-panel__skip" onClick={skip}>
        Skip — take me straight to the designer
      </button>
    </div>
  );
}
