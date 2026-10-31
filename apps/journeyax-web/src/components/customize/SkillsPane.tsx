'use client';

/**
 * The Skills tab, laid out like Claude's: skills as rows in groups, and a page for each skill with Overview and Contents, a
 * "Connectors & tools" column, and "Try in chat". Drafts (kept in this browser, not live) sit on top, as before.
 *
 * Claude groups by who made a skill ("Created by you", "From Anthropic & Partners"). The pack does not record who made a skill, so
 * the groups here are by when it is used: always on, or opened when a request fits.
 */
import { useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, SkillIcon, TrashIcon } from '@/components/shell/icons';
import { describeSkillAccess } from '@/lib/customize/overview';
import { agentsCarrying, fingerprintOfOverviewSkill, type SkillDraft } from '@/lib/customize/skillDrafts';
import { groupSkills, groupSkillTools, matchesSkill } from '@/lib/customize/skillPage';
import type { CustomizeOverview, OverviewSkill } from '@/lib/customize/types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function SkillsPane({ scope, query, overview, drafts, busy, open, onOpen, onNew, onChange, onEditDraft, onMakeLive, onDeleteDraft, onRebase, onDelete, onTry }: {
  scope: 'yours' | 'discover';
  query: string;
  overview: CustomizeOverview;
  drafts: SkillDraft[];
  busy: string;
  /** The id of the skill whose page is open, if any. */
  open: string | null;
  onOpen: (skillId: string | null) => void;
  onNew: () => void;
  onChange: (skill: OverviewSkill) => void;
  onEditDraft: (draft: SkillDraft) => void;
  onMakeLive: (draft: SkillDraft) => void;
  onDeleteDraft: (draft: SkillDraft) => void;
  onRebase: (draft: SkillDraft) => void;
  onDelete: (skill: OverviewSkill) => void;
  onTry: (agentId?: string) => void;
}) {
  const { skills, canEdit } = overview;
  const groups = useMemo(() => groupSkills(skills.filter((skill) => matchesSkill(skill, query))), [skills, query]);
  const shownDrafts = drafts.filter((draft) => matchesSkill({ skillId: '', name: draft.name, description: draft.description } as OverviewSkill, query));
  const opened = open ? skills.find((skill) => skill.skillId === open) : undefined;

  if (scope === 'discover') {
    return (
      <div className="ax-empty">
        <h3>No skills to discover yet</h3>
        <p>Ready-made skills will appear here when the platform or your organisation offers some. You can write your own, or add one from a file, with Add.</p>
      </div>
    );
  }
  if (opened) {
    return <SkillPage overview={overview} skill={opened} busy={busy} onBack={() => onOpen(null)} onChange={onChange} onDelete={onDelete} onTry={onTry} />;
  }

  if (skills.length === 0 && shownDrafts.length === 0) {
    return (
      <div className="ax-empty">
        <h3>No skills in this pack yet</h3>
        <p>Skills are reusable instructions an agent can carry. When the active pack defines some, they are listed here with the agents that use them.</p>
        {canEdit && <button type="button" className="ax-btn ax-btn--primary" onClick={onNew}>Create a skill</button>}
      </div>
    );
  }
  if (groups.always.length + groups.onDemand.length === 0 && shownDrafts.length === 0) {
    return <div className="ax-empty"><h3>No skills match your search</h3><p>Try a different word, or clear the search.</p></div>;
  }

  const carriers = (skill: OverviewSkill) => agentsCarrying(overview.agents, skill.skillId).map((id) => overview.agents.find((a) => a.agentId === id)?.name || id);
  const list = (title: string, items: OverviewSkill[]) => items.length === 0 ? null : (
    <>
      <h2 className="ax-listhead">{title} <span className="ax-muted">({items.length})</span></h2>
      <ul className="ax-rowlist">
        {items.map((skill) => {
          const by = carriers(skill);
          return (
            <li key={skill.skillId}>
              <button type="button" className="ax-rowlist__item" onClick={() => onOpen(skill.skillId)}>
                <span className="ax-card__icon" aria-hidden="true"><SkillIcon size={18} /></span>
                <span className="ax-rowlist__text"><strong>{skill.name}</strong><small>{skill.description}</small></span>
                <span className="ax-rowlist__side">{by.length ? `Used by ${by.length === 1 ? by[0] : plural(by.length, 'agent')}` : 'No agent uses it'}</span>
                <ChevronRightIcon size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );

  return (
    <>
      {shownDrafts.length > 0 && (
        <>
          <h2 className="ax-listhead">Your drafts · not live <span className="ax-muted">({shownDrafts.length})</span></h2>
          <ul className="ax-rowlist">
            {shownDrafts.map((draft) => {
              const live = draft.replaces ? skills.find((s) => s.skillId === draft.replaces) : undefined;
              const stale = !!(draft.replaces && (!live || (draft.base && live.instructions !== undefined && fingerprintOfOverviewSkill(live, overview.agents) !== draft.base)));
              const names = draft.agents.map((id) => overview.agents.find((a) => a.agentId === id)?.name || id);
              return (
                <li key={draft.draftId} className="ax-rowlist__draft">
                  <span className="ax-card__icon" aria-hidden="true"><SkillIcon size={18} /></span>
                  <span className="ax-rowlist__text">
                    <strong>{draft.name} <span className="ax-tag ax-tag--draft">Draft</span></strong>
                    <small>{draft.description}</small>
                    <small>{draft.replaces ? `Changes “${live?.name ?? draft.replaces}”` : 'New skill'} · {plural(draft.tools.length, 'tool')} · {names.length ? `carried by ${names.join(', ')}` : 'no assistant carries it'}{stale ? ` · ${live ? 'changed elsewhere since you started' : 'the live skill is gone'}` : ''}</small>
                  </span>
                  <span className="ax-rowlist__actions">
                    <button type="button" className="ax-btn ax-btn--small" onClick={() => onEditDraft(draft)}>Edit</button>
                    {stale
                      ? <button type="button" className="ax-btn ax-btn--small" onClick={() => onRebase(draft)} title={live ? 'Keep my edits and replace the latest live version when I make it live' : 'The skill was deleted: keep my draft as a new skill'}>{live ? 'Keep mine' : 'Keep as a new skill'}</button>
                      : <button type="button" className="ax-btn ax-btn--small ax-btn--primary" disabled={busy !== ''} onClick={() => onMakeLive(draft)}>{busy === draft.draftId ? 'Publishing…' : 'Make live'}</button>}
                    <button type="button" className="ax-iconbtn" onClick={() => onDeleteDraft(draft)} aria-label={`Delete draft ${draft.name}`} title="Delete draft"><TrashIcon size={16} /></button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ax-notice">Drafts live only in this browser until you press Make live, which saves the skill, publishes through the publication check and puts everything back if it is refused.</p>
        </>
      )}
      {list('Always on', groups.always)}
      {list('Opened when a request fits', groups.onDemand)}
    </>
  );
}

function SkillPage({ overview, skill, busy, onBack, onChange, onDelete, onTry }: {
  overview: CustomizeOverview;
  skill: OverviewSkill;
  busy: string;
  onBack: () => void;
  onChange: (skill: OverviewSkill) => void;
  onDelete: (skill: OverviewSkill) => void;
  onTry: (agentId?: string) => void;
}) {
  const [view, setView] = useState<'overview' | 'contents'>('overview');
  const carrierIds = agentsCarrying(overview.agents, skill.skillId);
  const carrierNames = carrierIds.map((id) => overview.agents.find((a) => a.agentId === id)?.name || id);
  const toolGroups = groupSkillTools(skill.tools, overview.toolOptions);
  const plugins = overview.plugins.filter((plugin) => plugin.provides.skills.includes(skill.skillId)).map((plugin) => plugin.name);
  const editable = overview.canEdit && skill.instructions !== undefined;

  const tab = (id: 'overview' | 'contents', label: string) => (
    <button type="button" role="tab" id={`skilltab-${id}`} aria-selected={view === id} aria-controls="skillpanel" className="ax-tab" tabIndex={view === id ? 0 : -1} onClick={() => setView(id)}>{label}</button>
  );

  return (
    <section className="ax-detail" aria-label={skill.name}>
      <button type="button" className="ax-back" onClick={onBack}><ChevronLeftIcon size={16} /> Your skills</button>
      <div className="ax-detail__head">
        <span className="ax-card__icon ax-card__icon--big" aria-hidden="true"><SkillIcon size={22} /></span>
        <div className="ax-detail__titles">
          <h2>{skill.name}</h2>
          <p className="ax-detail__sub">{skill.tier === 'always' ? 'Always on' : 'Opened when a request fits'}{carrierNames.length ? ` · used by ${carrierNames.join(', ')}` : ' · no assistant uses it yet'}</p>
        </div>
        <div className="ax-detail__actions">
          <button type="button" className="ax-btn ax-btn--small" disabled={carrierIds.length === 0} onClick={() => onTry(carrierIds[0])} title={carrierIds.length ? `Start a new chat with ${carrierNames[0]}, which has this skill.` : 'No assistant has this skill yet.'}>Try in chat</button>
          {editable && <button type="button" className="ax-btn ax-btn--small" disabled={busy !== ''} onClick={() => onChange(skill)}>Change</button>}
          {editable && <button type="button" className="ax-iconbtn" disabled={busy !== ''} onClick={() => onDelete(skill)} aria-label={`Delete skill ${skill.name}`} title="Delete skill"><TrashIcon size={16} /></button>}
        </div>
      </div>

      <div className="ax-detail__cols">
        <div>
          <div className="ax-tabs ax-tabs--small" role="tablist" aria-label={`${skill.name}`}>
            {tab('overview', 'Overview')}
            {tab('contents', 'Contents')}
          </div>
          <div id="skillpanel" role="tabpanel" aria-labelledby={`skilltab-${view}`}>
            {view === 'overview' ? (
              <>
                <h3 className="ax-detail__h">What it is for</h3>
                <p className="ax-detail__text">{skill.description}</p>
                <h3 className="ax-detail__h">Who has it</h3>
                {skill.access.length === 0
                  ? <p className="ax-detail__text">No rows say who has it, so everyone, shoppers included, has it as its own setting says: {skill.tier === 'always' ? 'always on' : 'opened when a request fits'}.</p>
                  : <ul className="ax-plainlist">{skill.access.map((entry, index) => <li key={index}>{describeSkillAccess(entry)}</li>)}</ul>}
                <h3 className="ax-detail__h">Which assistants carry it</h3>
                <p className="ax-detail__text">{carrierNames.length ? carrierNames.join(', ') : 'None yet.'}{plugins.length ? ` It is also part of ${plugins.join(', ')}.` : ''}</p>
              </>
            ) : overview.canViewInstructions && skill.instructions ? (
              <pre className="ax-contents">{skill.instructions}</pre>
            ) : (
              <p className="ax-notice">The instructions of a skill are shown to people who may change the configuration.</p>
            )}
          </div>
        </div>
        <aside className="ax-detail__aside" aria-label="Connectors and tools">
          <h3 className="ax-detail__h ax-detail__h--first">Connectors &amp; tools</h3>
          {toolGroups.length === 0 ? <p className="ax-muted">This skill names no tools. It works with whatever its assistant may call.</p> : toolGroups.map((group) => (
            <div key={group.system} className="ax-toolside">
              <strong>{group.system}</strong>
              <ul>
                {group.tools.map((tool) => (
                  <li key={tool.id}>
                    {tool.label}
                    {tool.changesData && <span className="ax-tag">changes data</span>}
                    {tool.switchedOff && <span className="ax-tag ax-tag--draft">system is off</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
      </div>
    </section>
  );
}
