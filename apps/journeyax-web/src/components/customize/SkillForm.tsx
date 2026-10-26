'use client';

/**
 * "New skill" / "Edit skill": a form that makes a DRAFT skill. Nothing here reaches the live pack. The draft is kept in this browser
 * (lib/customize/skillDrafts.ts) until "Make live" on the draft sends it to the server, which writes it and publishes through the
 * publication gate. The form says so in plain words, and says before anything is saved what would go wrong for the people who get the
 * skill (a tool a team may not use, a system that is switched off, a tool shoppers can never use).
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/shell/icons';
import { describeSkillAccess } from '@/lib/customize/overview';
import { ACCESS_PRESETS, SKILL_LIMITS, cleanAccessRows, presetOf, presetRows, slugifySkillId, toolWarnings, validateSkill, type AccessPreset, type AccessRowInput } from '@/lib/customize/skillEdit';
import type { SkillDraft, SkillDraftInput } from '@/lib/customize/skillDrafts';
import type { CustomizeOverview, OverviewToolOption } from '@/lib/customize/types';

const LEVELS: Array<{ id: AccessRowInput['level']; label: string }> = [
  { id: 'available', label: 'Opened when a request fits' },
  { id: 'default', label: 'Always on' },
  { id: 'required', label: 'Always on, cannot be turned off' },
];
const STATE_WORDS = { allow: 'may use it', ask: 'is asked first', blocked: 'may not use it' } as const;

export default function SkillForm({ overview, draft, seed, onSave, onClose }: {
  overview: CustomizeOverview;
  /** The draft being edited, if any. */
  draft?: SkillDraft;
  /** The values a new draft starts with (for example a live skill being changed). */
  seed: SkillDraftInput;
  onSave: (input: SkillDraftInput) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<SkillDraftInput>(() => {
    if (!draft) return seed;
    const { draftId: _id, createdAt: _c, updatedAt: _u, ...rest } = draft;
    return rest;
  });
  const [submitted, setSubmitted] = useState(false);
  const [filter, setFilter] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), description: useId(), instructions: useId(), tier: useId(), title: useId() };

  const options = overview.toolOptions;
  const set = <K extends keyof SkillDraftInput>(key: K, next: SkillDraftInput[K]) => setValue((prev) => ({ ...prev, [key]: next }));
  const toggle = (key: 'tools' | 'agents', id: string) => setValue((prev) => ({ ...prev, [key]: prev[key].includes(id) ? prev[key].filter((x) => x !== id) : [...prev[key], id] }));

  const context = useMemo(() => ({
    platformTools: options.filter((o) => o.systemId === 'platform').map((o) => o.id),
    connectorTools: options.filter((o) => o.systemId !== 'platform').map((o) => o.id),
    agentIds: overview.agents.map((a) => a.agentId),
  }), [options, overview.agents]);
  const checked = useMemo(() => validateSkill({ ...value, skillId: value.replaces }, context), [value, context]);
  // A team in an existing row that the project no longer lists is still shown, so nothing is dropped without being seen.
  const teams = useMemo(() => {
    const known = new Map(overview.teams.map((t) => [t.id, t.name]));
    for (const row of value.access) for (const g of row.groups) if (g !== 'administrators' && !known.has(g)) known.set(g, `${g} (not a team of this project)`);
    return [...known].map(([id, name]) => ({ id, name }));
  }, [overview.teams, value.access]);
  const warnings = useMemo(() => toolWarnings(value.tools, value.access, options, teams), [value.tools, value.access, options, teams]);
  const chosenTeams = useMemo(() => new Set(value.access.filter((r) => r.audience === 'staff').flatMap((r) => r.groups.filter((g) => g !== 'administrators'))), [value.access]);

  // Focus the first field on open and give focus back on close; Escape closes; Tab stays inside.
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
    if (!checked.ok) { (dialogRef.current?.querySelector('[role="alert"]') as HTMLElement | null)?.focus(); return; }
    onSave({ ...value, access: cleanAccessRows(value.access).map((r) => ({ ...r, groups: r.groups.filter((g) => g !== 'administrators') })) });
  };

  const setRow = (index: number, patch: Partial<AccessRowInput>) => set('access', value.access.map((row, i) => (i === index ? { ...row, ...patch, ...(patch.audience === 'shopper' ? { groups: [] } : {}) } : row)));
  const toggleTeam = (index: number, team: string) => setRow(index, { groups: value.access[index].groups.includes(team) ? value.access[index].groups.filter((g) => g !== team) : [...value.access[index].groups, team] });
  const preset = presetOf(value.access);
  const applyPreset = (p: AccessPreset) => set('access', presetRows(p, p === 'everyone' ? [] : [...chosenTeams]));

  const q = filter.trim().toLowerCase();
  const shown = options.filter((o) => value.tools.includes(o.id) || !q || `${o.label} ${o.id} ${o.system} ${o.summary}`.toLowerCase().includes(q));
  const groups = new Map<string, OverviewToolOption[]>();
  for (const option of shown) groups.set(option.systemId, [...(groups.get(option.systemId) ?? []), option]);

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog ax-dialog--wide" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="ax-dialog__head">
          <h2 id={ids.title}>{value.replaces ? 'Change skill' : 'New skill'}</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <p className="ax-draftnote">
              This makes a draft. It is not live: it stays in this browser, and nothing here changes what anyone sees, until you press Make live on the draft.
              {value.replaces && <> It will replace the live skill “{value.replaces}”.</>}
            </p>

            {submitted && !checked.ok && (
              <div className="ax-notice ax-notice--error" role="alert" tabIndex={-1}>
                <strong>Not saved yet:</strong>
                <ul style={{ margin: '4px 0 0 18px' }}>{checked.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}

            <div className="ax-formrow">
              <label htmlFor={ids.name}>Name</label>
              <input id={ids.name} ref={nameRef} className="ax-input" value={value.name} maxLength={SKILL_LIMITS.name} onChange={(e) => set('name', e.target.value)} />
              {!value.replaces && value.name.trim() && <span className="ax-hint">The skill gets its id from this name once (“{slugifySkillId(value.name, overview.skills.map((s) => s.skillId))}”) and keeps it if you rename it later.</span>}
            </div>

            <div className="ax-formrow">
              <label htmlFor={ids.description}>When should the assistant use it?</label>
              <input id={ids.description} className="ax-input" value={value.description} maxLength={SKILL_LIMITS.description} onChange={(e) => set('description', e.target.value)} />
              <span className="ax-hint">One sentence. This is what the assistant reads to decide whether to open the skill.</span>
            </div>

            <div className="ax-formrow">
              <label htmlFor={ids.instructions}>Instructions</label>
              <textarea id={ids.instructions} className="ax-textarea" rows={12} value={value.instructions} onChange={(e) => set('instructions', e.target.value)} aria-describedby={`${ids.instructions}-hint`} />
              <span id={`${ids.instructions}-hint`} className="ax-hint">What to ask, which tools to use in which order, what to say, what never to do. {value.instructions.length.toLocaleString()} of {SKILL_LIMITS.instructions.toLocaleString()} characters.</span>
            </div>

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend">Who has it</legend>
              <div className="ax-segment ax-segment--wrap" role="group" aria-label="Quick choices">
                {(Object.keys(ACCESS_PRESETS) as AccessPreset[]).map((p) => (
                  <button key={p} type="button" aria-pressed={preset === p} onClick={() => applyPreset(p)} disabled={p !== 'everyone' && teams.length === 0}>{ACCESS_PRESETS[p]}</button>
                ))}
              </div>
              {teams.length === 0 && <span className="ax-hint">The project&apos;s teams could not be read, so teams cannot be chosen here.</span>}
              {value.access.length === 0 ? (
                <span className="ax-hint ax-hint--warn">No row: <strong>everyone, shoppers included,</strong> has this skill, carried as its own setting below says. Choose a team to keep it to staff.</span>
              ) : (
                value.access.map((row, index) => (
                  <div key={index} className="ax-accessrow">
                    <div className="ax-accessrow__line">
                      <select aria-label={`Row ${index + 1}: who`} className="ax-input" value={row.audience} onChange={(e) => setRow(index, { audience: e.target.value as 'staff' | 'shopper' })}>
                        <option value="staff">Staff</option>
                        <option value="shopper">Everyone (shoppers too)</option>
                      </select>
                      <select aria-label={`Row ${index + 1}: how`} className="ax-input" value={row.level} onChange={(e) => setRow(index, { level: e.target.value as AccessRowInput['level'] })}>
                        {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                      </select>
                      <button type="button" className="ax-btn ax-btn--small ax-btn--quiet" onClick={() => set('access', value.access.filter((_, i) => i !== index))}>Remove row</button>
                    </div>
                    {row.audience === 'staff' && (
                      <div className="ax-checks ax-checks--teams" role="group" aria-label={`Row ${index + 1}: teams`}>
                        {teams.map((team) => (
                          <label key={team.id} className="ax-check">
                            <input type="checkbox" checked={row.groups.includes(team.id)} onChange={() => toggleTeam(index, team.id)} />
                            <span>{team.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    <span className="ax-hint">{describeSkillAccess({ audience: row.audience, groups: row.groups, level: row.level })}{row.audience === 'staff' && row.groups.length === 0 ? ' (no team ticked means every member of staff)' : ''}.</span>
                  </div>
                ))
              )}
              <div><button type="button" className="ax-btn ax-btn--small" onClick={() => set('access', [...value.access, { audience: 'staff', groups: [], level: 'available' }])}>Add a row</button></div>
              <div className="ax-formrow" style={{ marginTop: 6 }}>
                <label htmlFor={ids.tier}>Its own setting</label>
                <select id={ids.tier} className="ax-input" value={value.tier} onChange={(e) => set('tier', e.target.value as 'always' | 'on_demand')}>
                  <option value="on_demand">Opened when a request fits</option>
                  <option value="always">Always on</option>
                </select>
                <span className="ax-hint">Used only when no row above says who has the skill.</span>
              </div>
            </fieldset>

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend">Which assistants carry it</legend>
              <div className="ax-checks">
                {overview.agents.map((agent) => (
                  <label key={agent.agentId} className="ax-check">
                    <input type="checkbox" checked={value.agents.includes(agent.agentId)} onChange={() => toggle('agents', agent.agentId)} />
                    <span>{agent.name}{agent.isDefault ? ' (default)' : ''}<small>{agent.purpose}</small></span>
                  </label>
                ))}
              </div>
              {value.agents.length === 0 && <span className="ax-hint ax-hint--warn">No assistant carries it, so nobody will ever use it.</span>}
            </fieldset>

            <fieldset className="ax-formrow" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ax-legend">Tools it relies on</legend>
              <input type="search" className="ax-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a tool or a system" aria-label="Find a tool" />
              <span className="ax-hint">Naming a tool tells the people who read the skill what it uses. It does not give anyone the tool: that is decided by the team rules{chosenTeams.size > 0 ? ', shown here for the teams you ticked' : ''}.</span>
              {options.length === 0 && <span className="ax-hint">The list of tools could not be read.</span>}
              {[...groups].map(([systemId, list]) => (
                <details key={systemId} open={systemId !== 'platform' || list.some((o) => value.tools.includes(o.id)) || !!q} className="ax-toolgroup">
                  <summary>{list[0].system}{list.some((o) => !o.enabled) && ' · switched off'} <span className="ax-tag">{value.tools.filter((t) => list.some((o) => o.id === t)).length} of {options.filter((o) => o.systemId === systemId).length}</span></summary>
                  <div className="ax-checks ax-checks--tools">
                    {list.map((option) => (
                      <label key={option.id} className="ax-check">
                        <input type="checkbox" checked={value.tools.includes(option.id)} onChange={() => toggle('tools', option.id)} />
                        <span>
                          {option.label}
                          {option.sideEffect === 'write' && <span className="ax-tag ax-tag--draft" style={{ marginLeft: 6 }}>changes data</span>}
                          <small>{option.summary || option.id}</small>
                          {option.states && value.tools.includes(option.id) && chosenTeams.size > 0 && (
                            <small>{[...chosenTeams].map((team) => `${teams.find((t) => t.id === team)?.name ?? team} ${STATE_WORDS[option.states![team] ?? 'blocked']}`).join(' · ')}</small>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              ))}
            </fieldset>

            {warnings.length > 0 && (
              <div className="ax-draftnote" role="status">
                <strong>Worth a look before you make it live</strong>
                <ul style={{ margin: '4px 0 0 18px' }}>{warnings.map((w) => <li key={`${w.tool}|${w.who}`}>{w.text}</li>)}</ul>
              </div>
            )}
          </div>
          <div className="ax-dialog__foot">
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary">Save draft</button>
          </div>
        </form>
      </div>
    </div>
  );
}
