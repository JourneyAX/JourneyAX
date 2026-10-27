'use client';

/**
 * The dashboard the corner tile opens: every figure of the person's team, then the lists under them. Everything on it comes from the shop's
 * pack and the person's own access (the server reads each system as them), so a figure they may not read says so instead of showing a guess.
 * A figure or a line with a question attached asks that question in the chat when pressed, and the dashboard stays where it is.
 */
import { askInChat } from '@/lib/shell/askInChat';
import { scopeWords, updatedWords, type DashboardSection } from '@/lib/shell/dashboard';
import { loadDashboard, useDashboardState } from '@/lib/shell/dashboardStore';
import { Figure, RowItem } from './parts';

function Section({ section }: { section: DashboardSection }) {
  return (
    <section className="dash__section" aria-label={section.title}>
      <h3 className="cv__h dash__h">
        <span>{section.title}</span>
        {section.state === 'ok' && section.total > 0 && <span className="dash__count">{section.total}{section.atLeast ? '+' : ''}</span>}
      </h3>
      {section.state === 'blocked' && <p className="dash__note">This one is not available to your team.</p>}
      {section.state === 'unavailable' && <p className="dash__note">Could not be read just now. It will try again in a minute.</p>}
      {section.state === 'ok' && section.rows.length === 0 && <p className="dash__note">{section.empty || 'Nothing to show.'}</p>}
      {section.state === 'ok' && section.rows.length > 0 && (
        <ul className="dash__rows">
          {section.rows.map((row, index) => <li key={`${index}-${row.title}`}><RowItem row={row} /></li>)}
        </ul>
      )}
      {section.state === 'ok' && section.more && (
        <button type="button" className="cv__link dash__more" onClick={() => askInChat(section.more!.prompt)}>{section.more.label}</button>
      )}
    </section>
  );
}

export default function DashboardCanvas() {
  const { status, data, refreshing } = useDashboardState();
  if (!data) {
    return (
      <div className="cv"><div className="cv__body">
        <p className="cv__empty-text" role="status">
          {status === 'error' ? 'The dashboard could not be reached just now.' : status === 'none' ? 'There is no dashboard for you.' : 'Getting your figures…'}
        </p>
        {status === 'error' && <button type="button" className="cv__btn cv__btn--ghost" onClick={() => { void loadDashboard(); }}>Try again</button>}
      </div></div>
    );
  }
  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="dash__scope">{scopeWords(data)}</div>
            {data.subtitle && <div className="cv__meta">{data.subtitle}</div>}
          </div>
          <div className="dash__refresh">
            <span className="cv__meta" aria-live="polite">{refreshing ? 'Updating…' : updatedWords(data.asOf)}</span>
            <button type="button" className="cv__link" onClick={() => { void loadDashboard(); }} disabled={refreshing}>Refresh</button>
          </div>
        </div>
        <div className="dash__figs">
          {data.metrics.map((figure) => <Figure key={figure.id} figure={figure} />)}
        </div>
        {data.sections.map((section) => <Section key={section.id} section={section} />)}
      </div>
    </div>
  );
}
