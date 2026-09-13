'use client';

/**
 * WorkingStrip — the "Working for Ns…" strip (docs/v3-card-cms-architecture.md,
 * artboards: PlaceMakers Voice Bar Main.dc.html / Expanded.dc.html). Collapsed:
 * a pulsing dot, elapsed seconds, current step label. Tap to expand into the
 * trace (what the agent is doing), the "Heard" line (the voice safety net),
 * and the last spoken reply. Renders through the card catalog's primitives so
 * it always matches the tenant's theme tokens — no bespoke CSS palette here.
 */
import { useEffect, useMemo, useState } from 'react';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { DEFAULT_TEMPLATES } from '@journeyax/ui-cards';
import type { JourneyState } from '@/lib/types';

export default function WorkingStrip({ working }: { working: JourneyState['working'] }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  // Collapse back down automatically once a new turn's steps start again.
  useEffect(() => { if (working?.steps?.length === 0) setExpanded(false); }, [working?.startedAt]);

  const elapsed = working ? Math.max(0, Math.round((now - working.startedAt) / 1000)) : 0;
  const currentLabel = useMemo(() => {
    if (!working?.steps?.length) return 'Thinking…';
    const running = [...working.steps].reverse().find((s) => s.status === 'running');
    return running?.title || working.steps[working.steps.length - 1]?.title || 'Thinking…';
  }, [working?.steps]);

  if (!working) return null;

  return (
    <div className="working-strip" data-expanded={expanded}>
      {!expanded ? (
        <button type="button" className="working-strip__collapsed" onClick={() => working.steps.length > 0 && setExpanded(true)}>
          <span className="working-strip__dot" />
          <span className="working-strip__elapsed">Working for {elapsed}s</span>
          <span className="working-strip__label">{currentLabel}</span>
          {working.steps.length > 0 && <span className="working-strip__chevron">▾</span>}
        </button>
      ) : (
        <div className="working-strip__expanded">
          <button type="button" className="working-strip__collapse" onClick={() => setExpanded(false)} aria-label="Collapse">
            <span className="working-strip__chevron working-strip__chevron--up">▴</span>
          </button>
          <CardRenderer
            template={DEFAULT_TEMPLATES.working}
            state={{ elapsed, label: currentLabel, heard: working.heard, steps: working.steps, lastReply: working.lastReply }}
            stateKey={`${working.startedAt}:${working.steps.length}`}
          />
        </div>
      )}
    </div>
  );
}
