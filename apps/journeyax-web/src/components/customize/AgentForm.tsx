'use client';

/**
 * "New agent": a form that makes a DRAFT agent. Nothing here reaches the live pack: the draft is kept in this browser
 * (lib/customize/drafts.ts) and "Copy JSON" hands over a pack-shaped definition for whoever publishes it from the back
 * office. The form says so, in plain words, where the person is deciding.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/shell/icons';
import { copyText } from '@/lib/shell/clipboard';
import { type AgentDraft, type AgentDraftInput, draftToPackAgentJson, validateDraft } from '@/lib/customize/drafts';
import type { CustomizeOverview } from '@/lib/customize/types';

const EMPTY: AgentDraftInput = { name: '', purpose: '', instructions: '', skills: [], tools: [], knowledgeNote: '' };

export default function AgentForm({ overview, draft, presetTools, onSave, onClose }: {
  overview: CustomizeOverview | undefined;
  /** The draft being edited, if any. */
  draft?: AgentDraft;
  /** Connectors ticked when the form opens for a new agent (from "+" on a connector card). */
  presetTools?: string[];
  onSave: (input: AgentDraftInput) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<AgentDraftInput>(() => draft
    ? { name: draft.name, purpose: draft.purpose, instructions: draft.instructions, skills: draft.skills, tools: draft.tools, knowledgeNote: draft.knowledgeNote }
    : { ...EMPTY, tools: presetTools || [] });
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), purpose: useId(), instructions: useId(), knowledge: useId(), title: useId(), skillsHint: useId() };

  const skills = overview?.skills ?? [];
  const connectors = overview?.connectors ?? [];
  const validation = useMemo(() => validateDraft(value), [value]);
  const set = <K extends keyof AgentDraftInput>(key: K, next: AgentDraftInput[K]) => setValue((prev) => ({ ...prev, [key]: next }));
  const toggle = (key: 'skills' | 'tools', id: string) => setValue((prev) => ({
    ...prev,
    [key]: prev[key].includes(id) ? prev[key].filter((x) => x !== id) : [...prev[key], id],
  }));

  // Focus the first field on open and give focus back to what opened the form on close; Escape closes; Tab stays inside.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    nameRef.current?.focus();
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!validation.ok) {
      (dialogRef.current?.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
      return;
    }
    onSave(value);
  };

  const copyJson = async () => {
    const fake: AgentDraft = {
      draftId: draft?.draftId || 'preview', createdAt: 0, updatedAt: 0, ...value,
    };
    const defaultAgent = overview?.agents.find((a) => a.isDefault) || overview?.agents[0];
    const json = draftToPackAgentJson(fake, { modelPolicyRef: defaultAgent?.modelPolicyRef || undefined, takenIds: (overview?.agents ?? []).map((a) => a.agentId) });
    setCopied((await copyText(json)) ? 'yes' : 'no');
    window.setTimeout(() => setCopied(null), 2500);
  };

  const show = (field: 'name' | 'purpose' | 'instructions') => (submitted ? validation.errors[field] : undefined);

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="ax-dialog__head">
          <h2 id={ids.title}>{draft ? 'Edit agent draft' : 'New agent'}</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <p className="ax-draftnote">
              This makes a draft. It is not live: it stays in this browser, and nothing here changes what customers see, until you press Make live on the draft (or have it published from the back office).
            </p>

            <div className="ax-formrow">
              <label htmlFor={ids.name}>Name</label>
              <input
                id={ids.name} ref={nameRef} className="ax-input" value={value.name} maxLength={80}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={show('name') ? true : undefined} aria-describedby={show('name') ? `${ids.name}-err` : undefined}
              />
              {show('name') && <span id={`${ids.name}-err`} className="ax-error">{show('name')}</span>}
            </div>

            <div className="ax-formrow">
              <label htmlFor={ids.purpose}>What is it for?</label>
              <input
                id={ids.purpose} className="ax-input" value={value.purpose} maxLength={240}
                onChange={(e) => set('purpose', e.target.value)}
                aria-invalid={show('purpose') ? true : undefined} aria-describedby={show('purpose') ? `${ids.purpose}-err` : undefined}
              />
              {show('purpose') && <span id={`${ids.purpose}-err`} className="ax-error">{show('purpose')}</span>}
            </div>

            <div className="ax-formrow">
              <label htmlFor={ids.instructions}>Instructions</label>
              <textarea
                id={ids.instructions} className="ax-textarea" rows={6} value={value.instructions}
                onChange={(e) => set('instructions', e.target.value)}
                aria-invalid={show('instructions') ? true : undefined} aria-describedby={`${ids.instructions}-hint${show('instructions') ? ` ${ids.instructions}-err` : ''}`}
              />
              <span id={`${ids.instructions}-hint`} className="ax-hint">How the agent should behave: what to ask, what to check, what to avoid.</span>
              {show('instructions') && <span id={`${ids.instructions}-err`} className="ax-error">{show('instructions')}</span>}
            </div>

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend" style={{ fontSize: '13.5px', fontWeight: 600, marginBottom: 6 }}>Skills</legend>
              {skills.length === 0 ? (
                <span className="ax-hint">No skills in this pack yet. Skills the pack defines will be listed here to tick.</span>
              ) : (
                <div className="ax-checks">
                  {skills.map((skill) => (
                    <label key={skill.skillId} className="ax-check">
                      <input type="checkbox" checked={value.skills.includes(skill.skillId)} onChange={() => toggle('skills', skill.skillId)} />
                      <span>{skill.name}<small>{skill.description}</small></span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend" style={{ fontSize: '13.5px', fontWeight: 600, marginBottom: 6 }}>Connectors (tools it may call)</legend>
              {connectors.length === 0 ? (
                <span className="ax-hint">No connectors are available.</span>
              ) : (
                <div className="ax-checks">
                  {connectors.map((c) => (
                    <label key={c.id} className="ax-check">
                      <input type="checkbox" checked={value.tools.includes(c.id)} onChange={() => toggle('tools', c.id)} />
                      <span>{c.name}<small>{c.description}</small></span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <div className="ax-formrow">
              <label htmlFor={ids.knowledge}>Knowledge note <span className="ax-hint">(optional)</span></label>
              <textarea
                id={ids.knowledge} className="ax-textarea" rows={3} value={value.knowledgeNote}
                onChange={(e) => set('knowledgeNote', e.target.value)}
                aria-describedby={`${ids.knowledge}-hint`}
              />
              <span id={`${ids.knowledge}-hint`} className="ax-hint">Which knowledge should this agent lean on? A note for whoever publishes it.</span>
            </div>
          </div>
          <div className="ax-dialog__foot">
            {copied && <span className="ax-hint" role="status">{copied === 'yes' ? 'Copied the agent JSON.' : 'Could not copy; select and copy from the draft card instead.'}</span>}
            <button type="button" className="ax-btn" onClick={copyJson} disabled={!validation.ok} title={validation.ok ? undefined : 'Fill in the name, purpose and instructions first'}>Copy JSON</button>
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary">Save draft</button>
          </div>
        </form>
      </div>
    </div>
  );
}
