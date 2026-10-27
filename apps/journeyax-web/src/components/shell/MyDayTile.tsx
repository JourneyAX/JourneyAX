'use client';

/**
 * The small tile in the corner of the chat: two or three figures from the shop's own dashboard for this person's team (open deals, closing
 * soon, open cases for a sales rep). Pressing it opens the dashboard in the side panel. Which figures, and how they are worked out, is the
 * shop's pack; this only draws what the server sent, and draws nothing for a person (a shopper, a team) who has no dashboard.
 */
import { useEffect } from 'react';
import { trackDashboard, useDashboardState } from '@/lib/shell/dashboardStore';
import { tileHasGap } from '@/lib/shell/dashboard';
import { closeCanvas, getCanvas, openCanvas, useCanvas } from '@/lib/shell/sidePanelStore';

export const DASHBOARD_KIND = 'dashboard';

export default function MyDayTile({ person, projectId }: { person: string | null | undefined; projectId?: string }) {
  useEffect(() => {
    trackDashboard(person, projectId);
    return () => trackDashboard(null, projectId);
  }, [person, projectId]);
  const { status, data } = useDashboardState();
  const canvas = useCanvas();
  if (status !== 'ready' || !data) return null;
  const open = canvas?.kind === DASHBOARD_KIND;
  const summary = data.tile.map((figure) => `${figure.value} ${figure.label}`).join(', ');
  return (
    <button
      type="button"
      className="myday"
      aria-pressed={open}
      aria-label={`${data.title}: ${summary}${tileHasGap(data) ? ' (some figures could not be read)' : ''}. ${open ? 'Close' : 'Open'} the dashboard`}
      title={open ? 'Close the dashboard' : 'Open the dashboard'}
      onClick={() => { if (getCanvas()?.kind === DASHBOARD_KIND) closeCanvas(); else openCanvas({ kind: DASHBOARD_KIND, title: data.title }); }}
    >
      <span className="myday__title">{data.title}</span>
      {data.tile.map((figure) => (
        <span className="myday__fig" key={figure.id}>
          <span className={`myday__val myday__val--${figure.tone}`}>{figure.value}</span>
          <span className="myday__lab">{figure.label}</span>
        </span>
      ))}
      <span className="myday__chev" aria-hidden="true">›</span>
    </button>
  );
}
