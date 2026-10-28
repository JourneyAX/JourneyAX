'use client';

/**
 * A short list of records the assistant looked up (open deals, cases, a customer), drawn as one card in the thread. The server builds it from
 * the connected system's own answer and the shop's own wording, so every line is a fact from the system and the reply above it can stay
 * short. A line with a question attached asks that question in the chat when pressed.
 */
import { askInChat } from '@/lib/shell/askInChat';
import { rebrandText } from '@/lib/brand/overlay';

interface Row { title: string; subtitle?: string; detail?: string; badge?: string; tone?: 'good' | 'warn' | 'bad' | 'info'; amount?: string; ask?: string }
export interface RecordsState { heading: string; rows: Row[]; total?: number; shown?: number; atLeast?: boolean }

export default function RecordsCard({ state }: { state: RecordsState }) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  if (!state.heading || rows.length === 0) return null;
  const total = typeof state.total === 'number' && state.total > rows.length ? state.total : undefined;
  return (
    <section className="rec" aria-label={state.heading}>
      <header className="rec__head">
        <h3 className="rec__title">{state.heading}</h3>
        {total !== undefined && <span className="rec__count">{rows.length} of {total}{state.atLeast ? '+' : ''}</span>}
      </header>
      <ul className="rec__rows">
        {rows.map((row, index) => {
          const body = (
            <>
              <span className="rec__main">
                <span className="rec__name">{rebrandText(row.title)}</span>
                {row.subtitle && <span className="rec__sub">{rebrandText(row.subtitle)}</span>}
                {row.detail && <span className="rec__detail">{rebrandText(row.detail)}</span>}
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
    </section>
  );
}
