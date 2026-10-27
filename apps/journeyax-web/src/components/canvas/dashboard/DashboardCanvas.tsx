'use client';

/**
 * The dashboard the corner tile opens: every figure of the person's team, then the lists under them. Everything on it comes from the shop's
 * pack and the person's own access (the server reads each system as them), so a figure they may not read says so instead of showing a guess.
 * A figure or a line with a question attached asks that question in the chat when pressed, and the dashboard stays where it is.
 */
import { askInChat } from '@/lib/shell/askInChat';
import { scopeWords, updatedWords, type DashboardFigure, type DashboardSection } from '@/lib/shell/dashboard';
import { loadDashboard, useDashboardState } from '@/lib/shell/dashboardStore';

function Figure({ figure }: { figure: DashboardFigure }) {
  const body = (
    <>
      <span className={`dash__val dash__val--${figure.tone}`}>{figure.value}</span>
      <span className="dash__lab">{figure.label}</span>
      {figure.hint && <span className="dash__hint">{figure.hint}</span>}
      {!figure.ok && <span className="dash__hint">Could not be read just now</span>}
    </>
  );
  return figure.ask
    ? <button type="button" className="dash__fig dash__fig--ask" onClick={() => askInChat(figure.ask!)}>{body}</button>
    : <div className="dash__fig">{body}</div>;
}

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
          {section.rows.map((row, index) => {
            const body = (
              <>
                <span className="rec__main">
                  <span className="rec__name">{row.title}</span>
                  {row.subtitle && <span className="rec__sub">{row.subtitle}</span>}
                  {row.detail && <span className="rec__detail">{row.detail}</span>}
                </span>
                {(row.amount || row.badge) && (
                  <span className="rec__side">
                    {row.amount && <span className="rec__amount">{row.amount}</span>}
                    {row.badge && <span className={`rec__badge rec__badge--${row.tone ?? 'plain'}`}>{row.badge}</span>}
                  </span>
                )}
              </>
            );
            return (
              <li key={`${index}-${row.title}`}>
                {row.ask
                  ? <button type="button" className="rec__row rec__row--ask" onClick={() => askInChat(row.ask!)} title="Ask about this">{body}</button>
                  : <div className="rec__row">{body}</div>}
              </li>
            );
          })}
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
