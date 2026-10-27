'use client';

/**
 * The home screen of a person who has a dashboard: the board comes first (what needs them now, then their figures, then the lists of their
 * team), and the message box waits underneath for whoever wants to start a conversation. Pressing a figure or a line starts that
 * conversation. Everything comes from the shop's pack and the person's own access, through the same answer the corner tile and the
 * dashboard panel use; this only decides where it sits on the page.
 */
import { askInChat } from '@/lib/shell/askInChat';
import { homeSections, splitFigures, updatedWords, type DashboardSection } from '@/lib/shell/dashboard';
import { loadDashboard, useDashboardState } from '@/lib/shell/dashboardStore';
import { Figure, RowItem } from '@/components/canvas/dashboard/parts';

/** A list on the home screen shows this many lines; the rest is one press away in the chat. */
export const HOME_ROWS = 5;

export interface HomeLink { label: string; onOpen: () => void }

function HomeSection({ section }: { section: DashboardSection }) {
  const shown = section.rows.slice(0, HOME_ROWS);
  const hidden = Math.max(0, section.total - shown.length);
  return (
    <section className="home__section" aria-label={section.title}>
      <h2 className="home__h">
        <span>{section.title}</span>
        {section.state === 'ok' && section.total > 0 && <span className="dash__count">{section.total}{section.atLeast ? '+' : ''}</span>}
      </h2>
      {section.state === 'unavailable' && <p className="dash__note">Could not be read just now. It will try again in a minute.</p>}
      {section.state === 'ok' && shown.length === 0 && <p className="dash__note">{section.empty || 'Nothing to show.'}</p>}
      {shown.length > 0 && (
        <ul className="dash__rows">
          {shown.map((row, index) => (
            <li key={`${index}-${row.title}`}><RowItem row={row} className={row.tone === 'bad' ? 'rec__row--hot' : row.tone === 'warn' ? 'rec__row--warm' : ''} /></li>
          ))}
        </ul>
      )}
      {section.state === 'ok' && section.more && (
        <button type="button" className="cv__link dash__more" onClick={() => askInChat(section.more!.prompt)}>
          {section.more.label}{hidden > 0 ? ` (${hidden} more)` : ''}
        </button>
      )}
    </section>
  );
}

export default function DashboardHome({ title, subtitle, links = [] }: { title: string; subtitle?: string; links?: HomeLink[] }) {
  const { data, refreshing } = useDashboardState();
  if (!data) return null;
  const { alerts, rest } = splitFigures(data);
  const sections = homeSections(data);
  return (
    <div className="home" role="region" aria-label={data.title}>
      <div className="home__inner">
        <header className="home__head">
          <div className="home__intro">
            {title && <h1 className="home__title">{title}</h1>}
            {subtitle && <p className="home__sub">{subtitle}</p>}
          </div>
          <div className="home__tools">
            {links.map((link) => <button key={link.label} type="button" className="cv__link" onClick={link.onOpen}>{link.label}</button>)}
            <span className="cv__meta" aria-live="polite">{refreshing ? 'Updating…' : updatedWords(data.asOf)}</span>
            <button type="button" className="cv__link" onClick={() => { void loadDashboard(); }} disabled={refreshing}>Refresh</button>
          </div>
        </header>
        {alerts.length > 0 && (
          <section className="home__alerts" aria-label="Needs you now">
            <h2 className="home__h home__h--alert">Needs you now</h2>
            <div className="home__alert-row">
              {alerts.map((figure) => <Figure key={figure.id} figure={figure} className={`home__alert home__alert--${figure.tone}`} />)}
            </div>
          </section>
        )}
        {rest.length > 0 && (
          <div className="dash__figs home__figs">
            {rest.map((figure) => <Figure key={figure.id} figure={figure} />)}
          </div>
        )}
        <div className="home__cols">
          {sections.map((section) => <HomeSection key={section.id} section={section} />)}
        </div>
      </div>
    </div>
  );
}
