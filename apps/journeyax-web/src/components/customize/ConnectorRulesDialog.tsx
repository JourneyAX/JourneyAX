'use client';

/**
 * The rules of one connected system: whether the assistant may reach it at all, and for each of its tools what each team may do with it
 * (allow, ask first, blocked). Nothing changes until "Make live"; the server then writes the rules, publishes through the publication
 * gate, and puts everything back if the gate refuses. Shoppers can never use a connected system, so they have no column.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { tidyName } from '@/lib/customize/connectorPage';
import { CloseIcon } from '@/components/shell/icons';
import { changedTools, countChanges, describeStatus, rulesToSend, setColumn, type RuleEdit } from '@/lib/customize/ruleGrid';
import type { OverviewConnectorRules, ToolState } from '@/lib/customize/types';

const LABEL: Record<ToolState, string> = { allow: 'Allow', ask: 'Ask first', blocked: 'Blocked' };

export default function ConnectorRulesDialog({ system, busy, onSave, onClose }: {
  system: OverviewConnectorRules;
  busy: boolean;
  /** Called with what changed; the page confirms, saves and closes. */
  onSave: (change: { enabled?: boolean; cells?: Record<string, Record<string, ToolState>> }, summary: string) => void;
  onClose: () => void;
}) {
  const [edit, setEdit] = useState<RuleEdit>(() => ({ enabled: system.enabled, grid: JSON.parse(JSON.stringify(system.grid)) }));
  const dialogRef = useRef<HTMLDivElement>(null);
  const ids = { title: useId(), on: useId() };

  const changed = useMemo(() => changedTools(system, edit), [system, edit]);
  const total = useMemo(() => countChanges(system, edit), [system, edit]);
  const switched = edit.enabled !== system.enabled;
  const status = describeStatus(system.status);
  const nobody = useMemo(() => edit.enabled && !system.tools.some((tool) => system.columns.some((column) => edit.grid[tool.name]?.[column.id] !== 'blocked')), [edit, system]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setCell = (tool: string, column: string, state: ToolState) => setEdit((prev) => ({ ...prev, grid: { ...prev.grid, [tool]: { ...prev.grid[tool], [column]: state } } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (total === 0 && !switched) return;
    const { cells } = rulesToSend(system, edit);
    const parts = [
      ...(switched ? [edit.enabled ? `switch ${system.name} ON` : `switch ${system.name} OFF`] : []),
      ...(total > 0 ? [`change ${total} setting${total === 1 ? '' : 's'} on ${changed.length} tool${changed.length === 1 ? '' : 's'}`] : []),
    ];
    onSave({ ...(switched ? { enabled: edit.enabled } : {}), ...(total > 0 ? { cells } : {}) }, parts.join(' and '));
  };

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog ax-dialog--xwide" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="ax-dialog__head">
          <h2 id={ids.title}>{tidyName(system.name)}</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <div className="ax-rules__switch">
              <label className="ax-check" htmlFor={ids.on}>
                <input id={ids.on} type="checkbox" checked={edit.enabled} onChange={(e) => setEdit((prev) => ({ ...prev, enabled: e.target.checked }))} />
                <span>On</span>
              </label>
              <div className="ax-card__meta">
                <span className="ax-tag">{system.sample ? 'Data' : 'Connector'}</span>
                <span className={`ax-tag${status.tone === 'bad' ? ' ax-tag--draft' : ''}`} title={status.detail}>{system.sample ? 'Built in' : status.tone === 'bad' ? 'Not connected' : 'Connected'}</span>
              </div>
            </div>
            <div className="ax-rules__scroll">
              <table className="ax-rules" aria-label={`What each team may do with each tool of ${tidyName(system.name)}`}>
                <thead>
                  <tr>
                    <th scope="col" className="ax-rules__tool">Tool</th>
                    {system.columns.map((column) => (
                      <th key={column.id} scope="col" title={column.note}>
                        <span>{column.name}</span>
                        <select aria-label={`Set every tool for ${column.name}`} className="ax-rules__bulk" value="" onChange={(e) => { const v = e.target.value as 'reads' | 'ask' | 'blocked'; if (v) setEdit((prev) => setColumn(system, prev, column.id, v)); }}>
                          <option value="">Set all…</option>
                          <option value="reads">Allow reads, ask for changes</option>
                          <option value="ask">Ask first for all</option>
                          <option value="blocked">Block all</option>
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {system.tools.map((tool) => (
                    <tr key={tool.name}>
                      <th scope="row" className="ax-rules__tool">
                        <span>{tool.label}</span>
                        {tool.sideEffect === 'write' && <span className="ax-tag ax-tag--draft" style={{ marginLeft: 6 }}>changes data</span>}
                        {tool.summary && <small>{tool.summary}</small>}
                      </th>
                      {system.columns.map((column) => {
                        const state = edit.grid[tool.name]?.[column.id] ?? 'blocked';
                        const was = system.grid[tool.name]?.[column.id];
                        return (
                          <td key={column.id} className={was !== state ? 'ax-rules__changed' : undefined}>
                            <select
                              className={`ax-rules__cell ax-rules__cell--${state}`}
                              aria-label={`${tool.label} for ${column.name}`}
                              value={state}
                              onChange={(e) => setCell(tool.name, column.id, e.target.value as ToolState)}
                            >
                              {(['allow', 'ask', 'blocked'] as ToolState[]).map((s) => <option key={s} value={s} disabled={s === 'allow' && tool.sideEffect === 'write'}>{LABEL[s]}</option>)}
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ax-hint">Shoppers can never use a connected system, so they have no column. A tool that changes data in {system.name} cannot be simply allowed: it asks the person first. Someone in two teams gets the stricter of the two.</p>
            {nobody && <p className="ax-draftnote" role="status">With these settings no team may use any tool of {system.name}, so switching it on does nothing.</p>}
          </div>
          <div className="ax-dialog__foot">
            <span className="ax-hint" role="status" style={{ marginRight: 'auto' }}>{total === 0 && !switched ? 'No changes yet.' : `${switched ? `Will switch ${edit.enabled ? 'on' : 'off'}. ` : ''}${total > 0 ? `${total} setting${total === 1 ? '' : 's'} changed on ${changed.length} tool${changed.length === 1 ? '' : 's'}.` : ''}`}</span>
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary" disabled={busy || (total === 0 && !switched)}>{busy ? 'Publishing…' : 'Make live'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
