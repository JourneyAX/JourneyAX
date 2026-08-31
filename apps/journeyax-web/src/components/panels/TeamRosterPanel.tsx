'use client';

/**
 * Team Roster panel — thin wrapper around the real roster engine
 * (`components/studio/RosterPanel.tsx`, AUG-32: parse / confirm-columns /
 * price, all already built and used by `/studio`) so the coach team-order
 * chat flow can reach it too (Coach Team-Order Journey, Step 2/4).
 *
 * Derives garments/skuByGarment/sizeScale/teamName the same way
 * `app/studio/page.tsx` does: one garment ("jersey") on the matched design's
 * SKU, and the brand's size scale from `/api/products/renderer-config`.
 * `onRosterReady` — fired once RosterPanel has successfully priced the roster
 * — stores the rows in journey state and moves to the 3D preview phase.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import RosterPanel, { Row } from '../studio/RosterPanel';
import type { RosterRow } from '@/lib/types';

export default function TeamRosterPanel() {
  const { state, dispatch } = useJourney();

  const project = useMemo(
    () => (typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('project') || ''),
    [],
  );

  const [sizeScale, setSizeScale] = useState<string[]>([]);
  useEffect(() => {
    if (!project) return;
    fetch(`/api/products/renderer-config?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((c: { sizeScale?: string[] }) => setSizeScale(c?.sizeScale || []))
      .catch(() => setSizeScale([]));
  }, [project]);

  const sku = state.design?.sku || '';
  const teamName = state.design?.name || '';

  return (
    <RosterPanel
      project={project}
      garments={['jersey']}
      skuByGarment={sku ? { jersey: sku } : {}}
      sizeScale={sizeScale}
      teamName={teamName}
      onRosterReady={(rows: Row[]) => {
        const roster: RosterRow[] = rows.map((r) => ({ name: r.name, number: r.number, sizes: r.sizes }));
        dispatch({ type: 'SET_ROSTER', roster });
        dispatch({ type: 'SET_PHASE', phase: 'teamPreview' });
      }}
    />
  );
}
