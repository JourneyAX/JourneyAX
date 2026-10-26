'use client';

/**
 * Which tools one scenario (use case) needs. The tools its playbooks already use are listed and checked for the persona's team; here a
 * person ticks any others the scenario needs, and each is checked under that team's rules as it is ticked. Saving changes nothing the
 * assistant says or may do: it is a note, kept in the project database, that the Personas page checks.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/shell/icons';
import { judgeContext, judgeTool, OUTCOME_WORDS, type ToolCheck } from '@/lib/customize/personas';
import type { CustomizeOverview } from '@/lib/customize/types';

export default function ScenarioToolsDialog({ title, audience, audienceName, overview, fromPlaybook, current, busy, error, onSave, onClose }: {
  title: string;
  /** The team whose rules apply (or `shopper`), and its name. */
  audience: string;
  audienceName: string;
  overview: Pick<CustomizeOverview, 'toolOptions' | 'connectorRules'>;
  /** The tools the playbooks already use (read only here). */
  fromPlaybook: ToolCheck[];
  /** The extra tools already saved for this scenario. */
  current: string[];
  busy: boolean;
  error: string;
  onSave: (tools: string[]) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(current);
  const [filter, setFilter] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const context = useMemo(() => judgeContext(overview), [overview]);
  const playbookIds = useMemo(() => new Set(fromPlaybook.map((tool) => tool.id)), [fromPlaybook]);
  const q = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const map = new Map<string, { system: string; options: typeof overview.toolOptions }>();
    for (const option of overview.toolOptions) {
      if (playbookIds.has(option.id)) continue;
      if (q && ![option.label, option.system, option.id, option.summary].some((part) => part.toLowerCase().includes(q))) continue;
      const group = map.get(option.systemId) ?? { system: option.system, options: [] };
      group.options.push(option);
      map.set(option.systemId, group);
    }
    return [...map.entries()];
  }, [overview.toolOptions, playbookIds, q]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => setChosen((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  const dirty = chosen.length !== current.length || chosen.some((id) => !current.includes(id));
  const submit = (event: FormEvent) => { event.preventDefault(); if (dirty) onSave(chosen); };
  const stale = chosen.filter((id) => !context.options.has(id));

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog ax-dialog--wide" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ax-dialog__head">
          <h2 id={titleId}>Tools for “{title}”</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <p className="ax-hint" style={{ margin: 0 }}>
              Tick the tools this scenario needs. Each is checked under the rules for {audienceName}. This is a note on the persona page: it does not give anyone a tool, and it does not change what the assistant does.
            </p>

            {fromPlaybook.length > 0 && (
              <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="ax-legend">Already used by its playbook</legend>
                <ul className="ax-plainlist">
                  {fromPlaybook.map((tool) => <li key={tool.id}>{tool.label} <span className="ax-muted">({tool.system})</span> <span className={`ax-outcome ax-outcome--${tool.outcome}`}>{OUTCOME_WORDS[tool.outcome]}</span></li>)}
                </ul>
              </fieldset>
            )}

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend">Other tools it needs</legend>
              <input type="search" className="ax-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tool or a system" aria-label="Find a tool" />
              {groups.length === 0 && <span className="ax-hint">No tool matches.</span>}
              {groups.map(([systemId, group]) => (
                <details key={systemId} open={systemId !== 'platform' || group.options.some((o) => chosen.includes(o.id)) || !!q} className="ax-toolgroup">
                  <summary>{group.system}{group.options.some((o) => !o.enabled) && ' · switched off'} <span className="ax-tag">{chosen.filter((t) => group.options.some((o) => o.id === t)).length} ticked</span></summary>
                  <div className="ax-checks ax-checks--tools">
                    {group.options.map((option) => {
                      const verdict = judgeTool(context, option.id, 'you', audience, audienceName);
                      return (
                        <label key={option.id} className="ax-check">
                          <input type="checkbox" checked={chosen.includes(option.id)} onChange={() => toggle(option.id)} />
                          <span>
                            {option.label}
                            {option.sideEffect === 'write' && <span className="ax-tag ax-tag--draft" style={{ marginLeft: 6 }}>changes data</span>}
                            <small>{option.summary || option.id}</small>
                            <small><span className={`ax-outcome ax-outcome--${verdict.outcome}`}>{OUTCOME_WORDS[verdict.outcome]}</span> for {audienceName}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </details>
              ))}
              {stale.length > 0 && <span className="ax-hint ax-hint--warn">Saved earlier, but the assistant no longer has: {stale.join(', ')}. Untick to remove.</span>}
            </fieldset>
            {error && <p className="ax-error" role="alert">{error}</p>}
          </div>
          <div className="ax-dialog__foot">
            <span className="ax-hint" role="status" style={{ marginRight: 'auto' }}>{dirty ? `${chosen.length} extra tool${chosen.length === 1 ? '' : 's'} ticked.` : 'No changes yet.'}</span>
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save tools'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
