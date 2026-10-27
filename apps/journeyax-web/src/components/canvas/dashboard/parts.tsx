'use client';

/**
 * The two pieces the dashboard panel and the home screen both draw: a figure, and a line of a list. A figure or a line with a question
 * attached asks that question in the chat when pressed.
 */
import { askInChat } from '@/lib/shell/askInChat';
import type { DashboardFigure, DashboardRow } from '@/lib/shell/dashboard';

export function Figure({ figure, className = '' }: { figure: DashboardFigure; className?: string }) {
  const body = (
    <>
      <span className={`dash__val dash__val--${figure.tone}`}>{figure.value}</span>
      <span className="dash__lab">{figure.label}</span>
      {figure.hint && <span className="dash__hint">{figure.hint}</span>}
      {!figure.ok && <span className="dash__hint">Could not be read just now</span>}
    </>
  );
  const classes = `dash__fig${className ? ` ${className}` : ''}`;
  return figure.ask
    ? <button type="button" className={`${classes} dash__fig--ask`} onClick={() => askInChat(figure.ask!)}>{body}</button>
    : <div className={classes}>{body}</div>;
}

export function RowItem({ row, className = '' }: { row: DashboardRow; className?: string }) {
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
  const classes = `rec__row${className ? ` ${className}` : ''}`;
  return row.ask
    ? <button type="button" className={`${classes} rec__row--ask`} onClick={() => askInChat(row.ask!)} title="Ask about this">{body}</button>
    : <div className={classes}>{body}</div>;
}
