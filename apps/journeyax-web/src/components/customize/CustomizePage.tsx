'use client';

/**
 * Customize — what the assistant is made of: its agents, the skills they carry, the knowledge they answer from, and the
 * connectors (tools) they can call. Tabs, a Yours | Discover switch, search, an Add menu, a banner and a grid of cards.
 *
 * "Yours" is the tenant's ACTIVE pack, read through /api/customize/overview, plus agent drafts kept in this browser. Nothing is
 * derived to fill a gap: an empty pack shows an honest empty state. "Discover" lists what exists on the platform but is not
 * in use yet (connectors) and says plainly where nothing exists. Drafts are never live; see lib/customize/drafts.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import AppShell from '@/components/shell/AppShell';
import { useShell } from '@/components/shell/ShellContext';
import { useConversationNav } from '@/components/shell/useConversationNav';
import {
  AgentIcon, BookIcon, CopyIcon, PlugIcon, PlusIcon, SearchIcon, SidebarIcon, SkillIcon, SparkIcon, TrashIcon, UploadIcon,
} from '@/components/shell/icons';
import { useDismiss } from '@/components/shell/useDismiss';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { forSidebar } from '@/lib/shell/conversationNav';
import { copyText } from '@/lib/shell/clipboard';
import { type AgentDraft, type AgentDraftInput, draftToPackAgentJson, loadDrafts, removeDraft, saveDrafts, upsertDraft } from '@/lib/customize/drafts';
import { describePluginAccess, describeSkillAccess } from '@/lib/customize/overview';
import type { CustomizeOverview, OverviewAgent, OverviewConnectorRules, OverviewKnowledgeSource, OverviewPlugin, OverviewSkill, OverviewSystem, ToolState } from '@/lib/customize/types';
import {
  EMPTY_SKILL, agentsCarrying, draftFromSkill, draftToInput, fingerprintOfOverviewSkill, loadSkillDrafts, removeSkillDraft, saveSkillDrafts, upsertSkillDraft,
  type SkillDraft, type SkillDraftInput,
} from '@/lib/customize/skillDrafts';
import { connectorRows } from '@/lib/customize/connectorPage';
import { readDeepLink } from '@/lib/customize/deepLink';
import { MAX_SKILL_FILE_BYTES, parseSkillFile } from '@/lib/customize/skillFile';
import AgentForm from './AgentForm';
import ConnectorRulesDialog from './ConnectorRulesDialog';
import ConnectorsPane from './ConnectorsPane';
import SkillForm from './SkillForm';
import SkillsPane from './SkillsPane';
import { useOverview } from './useOverview';
import { ViewAs } from './ViewAs';

type TabId = 'agents' | 'skills' | 'plugins' | 'knowledge' | 'connectors';
type Scope = 'yours' | 'discover';

const TABS: { id: TabId; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'connectors', label: 'Connectors' },
];

const BANNERS: Record<TabId, { title: string; text: string; icons: ReactNode[] }> = {
  agents: {
    title: 'Build agents from skills and knowledge',
    text: 'An agent is a specialist: its instructions, the skills it carries, the knowledge it answers from and the connectors it may call. Draft one here, then hand it to your team to publish.',
    icons: [<SkillIcon key="s" size={22} />, <BookIcon key="b" size={22} />, <PlugIcon key="p" size={22} />],
  },
  skills: {
    title: 'Skills teach an agent how you want things done',
    text: 'A skill is a reusable set of instructions, like how to open a broad request or what to do once an item is added. Agents carry the skills they need.',
    icons: [<SkillIcon key="s" size={22} />, <AgentIcon key="a" size={22} />],
  },
  plugins: {
    title: 'Plugins switch a whole bundle on for the people you choose',
    text: 'A plugin names an agent, its skills, a form, the other systems it reaches and the tools it needs, and gives them to a group together. A person without the plugin does not have any of its parts.',
    icons: [<PlugIcon key="p" size={22} />, <SkillIcon key="s" size={22} />, <AgentIcon key="a" size={22} />],
  },
  knowledge: {
    title: 'Knowledge is what your assistant answers from',
    text: 'Verified business knowledge and the data sources behind it. Agents consult it instead of guessing, so what they tell customers can be traced back.',
    icons: [<BookIcon key="b" size={22} />, <SparkIcon key="s" size={22} />],
  },
  connectors: {
    title: 'Connected systems, and the tools agents can call',
    text: 'The other systems your assistant reaches (the CRM, the shop, the ticket desk) with who may do what in each, and the platform\'s own built-in tools. Each agent is allowed only the tools it needs.',
    icons: [<PlugIcon key="p" size={22} />, <AgentIcon key="a" size={22} />],
  },
};

const matches = (query: string, ...parts: Array<string | undefined>) => {
  const q = query.trim().toLowerCase();
  return !q || parts.some((p) => (p || '').toLowerCase().includes(q));
};

export default function CustomizePage({ embed }: { embed: boolean }) {
  const nav = useConversationNav();
  return (
    <AppShell
      active="customize"
      embed={embed}
      conversations={forSidebar(nav.conversations, '')}
      onNewChat={nav.newChat}
      onOpenConversation={nav.open}
      onDeleteConversation={nav.remove}
    >
      <CustomizeContent onTry={(agentId) => nav.newChat(agentId)} />
    </AppShell>
  );
}

function CustomizeContent({ onTry }: { onTry: (agentId?: string) => void }) {
  const cfg = useStorefrontConfig();
  const { sidebarVisible, isMobile, toggleSidebar } = useShell();
  const { data, error, loading, reload } = useOverview();
  const [tab, setTab] = useState<TabId>('agents');
  const [scope, setScope] = useState<Scope>('yours');
  const [query, setQuery] = useState('');
  // The connector or skill whose own page is open (its id), and where the address says to start (the chat's "+" menu links here).
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [addressRead, setAddressRead] = useState(false);
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [form, setForm] = useState<{ draft?: AgentDraft; presetTools?: string[] } | null>(null);
  const [skillDrafts, setSkillDrafts] = useState<SkillDraft[]>([]);
  const [skillForm, setSkillForm] = useState<{ draft?: SkillDraft; seed: SkillDraftInput } | null>(null);
  const [skillBusy, setSkillBusy] = useState('');
  const [rulesFor, setRulesFor] = useState<OverviewConnectorRules | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  useDismiss(addRef, addOpen, closeAdd);
  const tenant = cfg.projectId;

  useEffect(() => { setDrafts(loadDrafts(tenant)); setSkillDrafts(loadSkillDrafts(tenant)); }, [tenant]);
  useEffect(() => {
    const link = readDeepLink(window.location.search);
    if (link.tab) setTab(link.tab);
    if (link.scope) setScope(link.scope);
    if (link.open) setOpen(link.open);
    setAddressRead(true);
  }, []);
  // Keep the address in step with the tab, Yours or Discover, and the open page, so a reload or a shared link lands in the same place.
  useEffect(() => {
    if (!addressRead) return;
    try {
      const url = new URL(window.location.href);
      for (const key of ['tab', 'scope', 'open']) url.searchParams.delete(key);
      if (tab !== 'agents') url.searchParams.set('tab', tab);
      if (scope === 'discover') url.searchParams.set('scope', 'discover');
      if (open) url.searchParams.set('open', open);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* the address is a convenience, never a requirement */ }
  }, [addressRead, tab, scope, open]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const persist = (next: AgentDraft[]) => {
    setDrafts(next);
    if (!saveDrafts(tenant, next)) setToast('This browser would not keep the draft (storage is blocked or full).');
  };
  const saveDraft = (input: AgentDraftInput) => {
    const { list, draft } = upsertDraft(drafts, input, form?.draft?.draftId);
    persist(list);
    setForm(null);
    setTab('agents');
    setScope('yours');
    setToast(`Saved “${draft.name}” as a draft. It is not live.`);
  };

  const [publishing, setPublishing] = useState('');
  // Makes a draft a live agent: the server adds it to the project and publishes through the publication gate (add-only, reverted if refused).
  const publishDraft = async (draft: AgentDraft) => {
    if (publishing) return;
    const ok = window.confirm(`Make “${draft.name}” live?\n\nIt is added as a new agent and the configuration is published, so customers can be answered by it. Existing agents are not changed, and the publish can be rolled back from the back office.`);
    if (!ok) return;
    setPublishing(draft.draftId);
    try {
      const res = await fetch(`/api/customize/agents?project=${encodeURIComponent(tenant || '')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: { name: draft.name, purpose: draft.purpose, instructions: draft.instructions, skills: draft.skills, tools: draft.tools, knowledgeNote: draft.knowledgeNote } }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { setToast(String(result?.error || 'The agent could not be made live.')); return; }
      persist(removeDraft(drafts, draft.draftId));
      setToast(`“${draft.name}” is live${result?.version ? ` (configuration ${result.version})` : ''}. Pick it from the agent chip in the chat.`);
      reload();
    } catch {
      setToast('The agent could not be made live: the service did not answer.');
    } finally {
      setPublishing('');
    }
  };

  const persistSkills = (next: SkillDraft[]) => {
    setSkillDrafts(next);
    if (!saveSkillDrafts(tenant, next)) setToast('This browser would not keep the draft (storage is blocked or full).');
  };
  const saveSkillDraft = (input: SkillDraftInput) => {
    const { list, draft } = upsertSkillDraft(skillDrafts, input, skillForm?.draft?.draftId);
    persistSkills(list);
    setSkillForm(null);
    setTab('skills');
    setScope('yours');
    setToast(`Saved “${draft.name}” as a draft. It is not live.`);
  };
  const skillsApi = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/customize/skills?project=${encodeURIComponent(tenant || '')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, result };
  };
  // Makes a skill draft live: the server writes it, publishes through the publication gate, and puts everything back if the gate refuses.
  const makeSkillLive = async (draft: SkillDraft) => {
    if (skillBusy || !data) return;
    const holders = describeHolders(draft);
    const ok = window.confirm(`Make “${draft.name}” live?\n\n${draft.replaces ? 'It replaces the live skill and the configuration is published.' : 'It is added as a new skill and the configuration is published.'} It is carried by ${draft.agents.length ? draft.agents.map((id) => data.agents.find((a) => a.agentId === id)?.name || id).join(', ') : 'no assistant yet'}. ${holders}\n\nThe publication check runs first; if it refuses, nothing is changed.`);
    if (!ok) return;
    setSkillBusy(draft.draftId);
    try {
      const { ok: saved, status, result } = await skillsApi({ op: 'save', mode: draft.replaces ? 'update' : 'create', base: draft.base, skill: draftToInput(draft) });
      if (!saved) { setToast(status === 409 ? `${String(result?.error || 'The skill changed elsewhere.')}` : String(result?.error || 'The skill could not be made live.')); return; }
      persistSkills(removeSkillDraft(skillDrafts, draft.draftId));
      setToast(`“${draft.name}” is live${result?.version ? ` (configuration ${result.version})` : ''}.`);
      reload();
    } catch {
      setToast('The skill could not be made live: the service did not answer.');
    } finally {
      setSkillBusy('');
    }
  };
  const deleteLiveSkill = async (skill: OverviewSkill) => {
    if (skillBusy || !data) return;
    const carriers = agentsCarrying(data.agents, skill.skillId).map((id) => data.agents.find((a) => a.agentId === id)?.name || id);
    const plugins = data.plugins.filter((p) => p.provides.skills.includes(skill.skillId)).map((p) => p.name);
    const ok = window.confirm(`Delete the skill “${skill.name}” and publish?\n\n${carriers.length ? `It stops being carried by ${carriers.join(', ')}.` : 'No assistant carries it.'}${plugins.length ? ` It is also removed from ${plugins.join(', ')}.` : ''}\n\nThe publication check runs first; if it refuses, nothing is changed. Deleting cannot be undone from this page (the earlier configuration can be restored from the back office).`);
    if (!ok) return;
    setSkillBusy(skill.skillId);
    try {
      const { ok: done, result } = await skillsApi({ op: 'delete', skillId: skill.skillId, base: fingerprintOfOverviewSkill(skill, data.agents) });
      if (!done) { setToast(String(result?.error || 'The skill could not be deleted.')); return; }
      setToast(`“${skill.name}” was deleted${result?.version ? ` (configuration ${result.version})` : ''}.`);
      reload();
    } catch {
      setToast('The skill could not be deleted: the service did not answer.');
    } finally {
      setSkillBusy('');
    }
  };
  /** Keep my edits on top of the latest live version of the skill the draft changes (the next Make live overwrites what was changed elsewhere). */
  const rebaseSkillDraft = (draft: SkillDraft) => {
    if (!data) return;
    const live = data.skills.find((s) => s.skillId === draft.replaces);
    if (!live) {
      // The skill it changed has been deleted: the draft becomes a new skill.
      persistSkills(skillDrafts.map((d) => { if (d.draftId !== draft.draftId) return d; const { replaces: _r, base: _b, ...rest } = d; return rest; }));
      setToast('The skill you were changing is gone, so this draft will be added as a new skill when you make it live.');
      return;
    }
    persistSkills(skillDrafts.map((d) => (d.draftId === draft.draftId ? { ...d, base: fingerprintOfOverviewSkill(live, data.agents) } : d)));
    setToast('Your draft will now replace the latest live version when you make it live.');
  };
  const describeHolders = (draft: SkillDraft) => (draft.access.length === 0
    ? 'It has no rows saying who has it, so EVERYONE, shoppers included, gets it.'
    : `Who has it: ${draft.access.map((r) => describeSkillAccess({ audience: r.audience, groups: r.groups, level: r.level })).join('; ')}.`);

  // Saves the rules of one connected system and makes them live: the server publishes through the publication gate and puts everything back if it is refused.
  const saveRules = async (system: OverviewConnectorRules, change: { enabled?: boolean; cells?: Record<string, Record<string, ToolState>> }, summary: string) => {
    if (rulesBusy) return;
    const ok = window.confirm(`${system.name}: ${summary}, and publish?\n\nThe change is live for everyone as soon as it is published. The publication check runs first; if it refuses, nothing is changed.`);
    if (!ok) return;
    setRulesBusy(true);
    try {
      const res = await fetch(`/api/customize/connectors?project=${encodeURIComponent(tenant || '')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectorId: system.connectorId, base: system.base, ...change }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToast(String(result?.error || 'The rules could not be made live.'));
        if (res.status === 409) { setRulesFor(null); reload(); }
        return;
      }
      setRulesFor(null);
      setToast(`${system.name}: ${summary}${result?.version ? ` (configuration ${result.version})` : ''}.${Array.isArray(result?.warnings) && result.warnings.length ? ` Note: ${result.warnings[0]}` : ''}`);
      reload();
    } catch {
      setToast('The rules could not be made live: the service did not answer.');
    } finally {
      setRulesBusy(false);
    }
  };

  const by = cfg.companyName || 'Your organisation';
  const agents = useMemo(() => data?.agents ?? [], [data]);

  const changeTab = (id: TabId) => { setTab(id); setQuery(''); setOpen(null); };
  const changeScope = (next: Scope) => { setScope(next); setOpen(null); };
  // Upload a skill file: it only fills in the skill form as a draft; nothing is saved or live.
  const onSkillFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_SKILL_FILE_BYTES * 4) { setToast('That file is too large to be a skill.'); return; }
    try {
      const result = parseSkillFile(await file.text(), file.name);
      if (!result.ok) { setToast(result.error); return; }
      setSkillForm({ seed: result.seed });
      if (result.note) setToast(result.note);
    } catch {
      setToast('The file could not be read.');
    }
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    changeTab(TABS[next].id);
    requestAnimationFrame(() => document.getElementById(`ax-tab-${TABS[next].id}`)?.focus());
  };

  const counts: Record<TabId, number | undefined> = {
    agents: data ? agents.length + drafts.length : undefined,
    skills: data?.skills.length,
    plugins: data?.plugins.length,
    knowledge: data ? (data.knowledge.releaseId ? 1 : 0) + data.knowledge.sources.length : undefined,
    connectors: data ? data.connectors.filter((c) => c.usedBy.length > 0).length + data.systems.length : undefined,
  };

  const banner = BANNERS[tab];
  // A connector's or skill's own page replaces the list (and its toolbar and banner), as in Claude.
  const inDetail = !!(open && data && (
    (tab === 'skills' && data.skills.some((skill) => skill.skillId === open))
    || (tab === 'connectors' && (() => { const rows = connectorRows(data); return [...rows.yours, ...rows.discover].some((row) => row.id === open); })())
  ));

  return (
    <div className="ax-page">
      <div className="ax-page__bar">
        {(!sidebarVisible || isMobile) && (
          <button type="button" className="ax-iconbtn" onClick={toggleSidebar} aria-label="Open sidebar" title="Open sidebar"><SidebarIcon /></button>
        )}
      </div>
      <div className="ax-page__scroll">
        <div className="ax-page__inner">
          <h1 className="ax-page__title">Customize</h1>
          <p className="ax-page__lede">See what your assistant is made of and sketch new agents. Agents you draft here are not live until you press Make live (or have them published from the back office).</p>

          <div className="ax-tabs" role="tablist" aria-label="Customize" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id} id={`ax-tab-${t.id}`} type="button" role="tab" className="ax-tab"
                aria-selected={tab === t.id} aria-controls="ax-tabpanel" tabIndex={tab === t.id ? 0 : -1}
                onClick={() => changeTab(t.id)}
              >
                {t.label}
                {counts[t.id] !== undefined && <span className="ax-tab__count">{counts[t.id]}</span>}
              </button>
            ))}
          </div>

          <div id="ax-tabpanel" role="tabpanel" aria-labelledby={`ax-tab-${tab}`}>
            {!inDetail && (
            <div className="ax-toolbar">
              <div className="ax-segment" role="group" aria-label="Show">
                <button type="button" aria-pressed={scope === 'yours'} onClick={() => changeScope('yours')}>Yours</button>
                <button type="button" aria-pressed={scope === 'discover'} onClick={() => changeScope('discover')}>Discover</button>
              </div>
              <label className="ax-field">
                <SearchIcon size={16} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${TABS.find((t) => t.id === tab)!.label.toLowerCase()}`} aria-label={`Search ${tab}`} />
              </label>
              <span className="ax-toolbar__spacer" />
              <div className="ax-add" ref={addRef}>
                <button type="button" className="ax-btn ax-btn--primary" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}>
                  <PlusIcon size={16} /> Add
                </button>
                {addOpen && (
                  <div className="ax-menu" role="menu" aria-label="Add">
                    {tab === 'skills' ? (
                      data?.canEdit ? (
                        <>
                          <button type="button" role="menuitem" className="ax-menu__item" onClick={() => { setAddOpen(false); setSkillForm({ seed: EMPTY_SKILL }); }}>
                            <SkillIcon size={16} /> Create a skill
                          </button>
                          <button type="button" role="menuitem" className="ax-menu__item" onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>
                            <UploadIcon size={16} /> Upload a skill file
                          </button>
                        </>
                      ) : (
                        <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()} title="Changing skills needs permission to publish the configuration">
                          <SkillIcon size={16} /> Create a skill <span className="ax-badge">Needs publish permission</span>
                        </button>
                      )
                    ) : tab === 'connectors' ? (
                      <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()} title="New systems are connected by your technical team in the back office">
                        <PlugIcon size={16} /> Add custom connector <span className="ax-badge">Back office</span>
                      </button>
                    ) : (
                      <>
                        <button type="button" role="menuitem" className="ax-menu__item" onClick={() => { setAddOpen(false); setForm({}); }}>
                          <AgentIcon size={16} /> New agent
                        </button>
                        {data?.canEdit ? (
                          <button type="button" role="menuitem" className="ax-menu__item" onClick={() => { setAddOpen(false); setSkillForm({ seed: EMPTY_SKILL }); }}>
                            <SkillIcon size={16} /> New skill
                          </button>
                        ) : (
                          <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()} title="Changing skills needs permission to publish the configuration">
                            <SkillIcon size={16} /> New skill <span className="ax-badge">Needs publish permission</span>
                          </button>
                        )}
                        <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                          <BookIcon size={16} /> Add knowledge <span className="ax-badge">Back office</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            )}
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden aria-hidden="true" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void onSkillFile(file); }} />

            {!inDetail && !((tab === 'skills' || tab === 'connectors') && scope === 'yours') && (
            <section className="ax-herocard" aria-label="About this tab">
              <div>
                <h2>{banner.title}</h2>
                <p>{banner.text}</p>
                {tab === 'agents' && <button type="button" className="ax-btn ax-btn--primary" style={{ marginTop: 14 }} onClick={() => setForm({})}><PlusIcon size={16} /> New agent</button>}
                {tab === 'skills' && data?.canEdit && <button type="button" className="ax-btn ax-btn--primary" style={{ marginTop: 14 }} onClick={() => setSkillForm({ seed: EMPTY_SKILL })}><PlusIcon size={16} /> New skill</button>}
              </div>
              <div className="ax-herocard__art" aria-hidden="true">{banner.icons.map((icon, i) => <span key={i}>{icon}</span>)}</div>
            </section>
            )}

            {error && !data && (
              <div className="ax-notice ax-notice--error" role="alert">
                {error} <button type="button" className="ax-linkbtn" onClick={reload}>Try again</button>
              </div>
            )}
            {loading && !data && <LoadingGrid />}

            {data && tab === 'agents' && (
              <AgentsTab
                scope={scope} query={query} overview={data} drafts={drafts} by={by}
                onTry={onTry}
                onPublish={publishDraft}
                publishing={publishing}
                onNew={() => setForm({})}
                onEdit={(draft) => setForm({ draft })}
                onDelete={(draft) => { if (window.confirm(`Delete the draft “${draft.name}”?`)) { persist(removeDraft(drafts, draft.draftId)); setToast('Draft deleted.'); } }}
                onCopy={async (draft) => {
                  const defaultAgent = data.agents.find((a) => a.isDefault) || data.agents[0];
                  const ok = await copyText(draftToPackAgentJson(draft, { modelPolicyRef: defaultAgent?.modelPolicyRef || undefined, takenIds: data.agents.map((a) => a.agentId) }));
                  setToast(ok ? 'Copied the agent JSON.' : 'Could not copy to the clipboard.');
                }}
              />
            )}
            {data && tab === 'skills' && (
              <SkillsPane
                scope={scope} query={query} overview={data} drafts={skillDrafts} busy={skillBusy} open={open} onOpen={setOpen}
                onNew={() => setSkillForm({ seed: EMPTY_SKILL })}
                onChange={(skill) => setSkillForm({ seed: draftFromSkill(skill, data.agents) })}
                onEditDraft={(draft) => setSkillForm({ draft, seed: EMPTY_SKILL })}
                onMakeLive={makeSkillLive}
                onDeleteDraft={(draft) => { if (window.confirm(`Delete the draft “${draft.name}”?`)) { persistSkills(removeSkillDraft(skillDrafts, draft.draftId)); setToast('Draft deleted.'); } }}
                onRebase={rebaseSkillDraft}
                onDelete={deleteLiveSkill}
                onTry={onTry}
              />
            )}
            {data && tab === 'plugins' && <PluginsTab scope={scope} query={query} plugins={data.plugins} agents={agents} skills={data.skills} systems={data.systems} />}
            {data && tab === 'knowledge' && <KnowledgeTab scope={scope} query={query} knowledge={data.knowledge} by={by} />}
            {data && tab === 'connectors' && (
              <ConnectorsPane
                scope={scope} query={query} overview={data} open={open} busy={rulesBusy} onOpen={setOpen}
                onSave={saveRules} onFullTable={setRulesFor} onAddToAgent={(id) => setForm({ presetTools: [id] })}
              />
            )}
          </div>
        </div>
      </div>

      {form && <AgentForm overview={data} draft={form.draft} presetTools={form.presetTools} onSave={saveDraft} onClose={() => setForm(null)} />}
      {rulesFor && <ConnectorRulesDialog key={rulesFor.connectorId} system={rulesFor} busy={rulesBusy} onSave={(change, summary) => saveRules(rulesFor, change, summary)} onClose={() => setRulesFor(null)} />}
      {skillForm && data && <SkillForm overview={data} draft={skillForm.draft} seed={skillForm.seed} onSave={saveSkillDraft} onClose={() => setSkillForm(null)} />}
      {toast && <div className="ax-toast" role="status">{toast}</div>}
    </div>
  );
}

function LoadingGrid() {
  return (
    <ul className="ax-grid" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => <li key={i} className="ax-skeleton" />)}
    </ul>
  );
}

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ax-empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

function Card({ icon, title, by, description, tags, children, actions }: {
  icon: ReactNode; title: string; by: string; description?: string; tags?: ReactNode[]; children?: ReactNode; actions?: ReactNode;
}) {
  return (
    <li className="ax-card">
      <div className="ax-card__head">
        <span className="ax-card__icon" aria-hidden="true">{icon}</span>
        <div className="ax-card__titles">
          <h3 className="ax-card__title">{title}</h3>
          <p className="ax-card__by">by {by}</p>
        </div>
      </div>
      {description && <p className="ax-card__desc">{description}</p>}
      {tags && tags.length > 0 && <div className="ax-card__meta">{tags}</div>}
      {children}
      {actions && <div className="ax-card__actions">{actions}</div>}
    </li>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── Agents ──────────────────────────────────────────────────────────── */
function AgentsTab({ scope, query, overview, drafts, by, onTry, onPublish, publishing, onNew, onEdit, onDelete, onCopy }: {
  scope: Scope; query: string; overview: CustomizeOverview; drafts: AgentDraft[]; by: string;
  onPublish: (d: AgentDraft) => void; publishing: string;
  onTry: (agentId?: string) => void; onNew: () => void; onEdit: (d: AgentDraft) => void; onDelete: (d: AgentDraft) => void; onCopy: (d: AgentDraft) => void;
}) {
  if (scope === 'discover') {
    return (
      <Empty title="No agent templates yet">
        Ready-made agents to start from will appear here once your organisation or the platform offers some. You can still start from scratch.
      </Empty>
    );
  }
  const packAgents = overview.agents.filter((a) => matches(query, a.name, a.purpose));
  const shownDrafts = drafts.filter((d) => matches(query, d.name, d.purpose));
  const connectorName = (id: string) => overview.connectors.find((c) => c.id === id)?.name || id;
  const skillName = (id: string) => overview.skills.find((s) => s.skillId === id)?.name || id;

  if (packAgents.length === 0 && shownDrafts.length === 0) {
    return query.trim() ? (
      <Empty title="No agents match your search">Try a different word, or clear the search.</Empty>
    ) : (
      <Empty title="No agents in this pack yet" action={<button type="button" className="ax-btn ax-btn--primary" onClick={onNew}><PlusIcon size={16} /> New agent</button>}>
        The active pack does not list any agents. You can draft one here; it is not live until it is published from the back office.
      </Empty>
    );
  }

  return (
    <>
      {shownDrafts.length > 0 && (
        <>
          <h2 className="ax-section-title">Your drafts · not live</h2>
          <ul className="ax-grid">
            {shownDrafts.map((d) => (
              <Card
                key={d.draftId} icon={<AgentIcon size={20} />} title={d.name} by="you, in this browser" description={d.purpose}
                tags={[
                  <span key="draft" className="ax-tag ax-tag--draft">Draft</span>,
                  <span key="t" className="ax-tag">{plural(d.tools.length, 'connector')}</span>,
                  <span key="s" className="ax-tag">{plural(d.skills.length, 'skill')}</span>,
                ]}
                actions={(
                  <>
                    <button type="button" className="ax-btn ax-btn--small" onClick={() => onEdit(d)}>Edit</button>
                    <button type="button" className="ax-btn ax-btn--small ax-btn--primary" disabled={publishing !== ''} onClick={() => onPublish(d)}>{publishing === d.draftId ? 'Publishing…' : 'Make live'}</button>
                    <button type="button" className="ax-btn ax-btn--small ax-btn--quiet" onClick={() => onCopy(d)}><CopyIcon size={15} /> Copy JSON</button>
                    <span className="ax-toolbar__spacer" />
                    <button type="button" className="ax-iconbtn" onClick={() => onDelete(d)} aria-label={`Delete draft ${d.name}`} title="Delete draft"><TrashIcon size={16} /></button>
                  </>
                )}
              />
            ))}
          </ul>
          <p className="ax-notice">Drafts live only in this browser until you press Make live, which adds the agent to the assistant and publishes it. Copy JSON gives the definition for the back office instead.</p>
        </>
      )}
      {packAgents.length > 0 && (
        <>
          {shownDrafts.length > 0 && <h2 className="ax-section-title">In your assistant</h2>}
          <ul className="ax-grid">
            {packAgents.map((a) => (
              <PackAgentCard key={a.agentId} agent={a} by={by} onTry={onTry} connectorName={connectorName} skillName={skillName} />
            ))}
          </ul>
        </>
      )}
      {!query.trim() && <ViewAs />}
    </>
  );
}

function PackAgentCard({ agent, by, onTry, connectorName, skillName }: {
  agent: OverviewAgent; by: string; onTry: (agentId?: string) => void; connectorName: (id: string) => string; skillName: (id: string) => string;
}) {
  return (
    <Card
      icon={<AgentIcon size={20} />} title={agent.name} by={by} description={agent.purpose}
      tags={[
        ...(agent.isDefault ? [<span key="d" className="ax-tag ax-tag--draft" style={{ background: 'var(--ax-accent-soft)', color: 'var(--ax-accent-text)' }}>Default</span>] : []),
        <span key="t" className="ax-tag">{plural(agent.allowedTools.length, 'connector')}</span>,
        <span key="s" className="ax-tag">{plural(agent.skills.length, 'skill')}</span>,
      ]}
      actions={<button type="button" className="ax-btn ax-btn--small" onClick={() => onTry(agent.agentId)} title="Start a new chat with this agent.">Try</button>}
    >
      <details>
        <summary>What it can do</summary>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agent.skills.length > 0 && <div><strong>Skills:</strong> {agent.skills.map(skillName).join(', ')}</div>}
          <div><strong>Connectors:</strong> {agent.allowedTools.length ? agent.allowedTools.map(connectorName).join(', ') : 'none'}</div>
          {agent.handoffConditions.length > 0 && (
            <div>
              <strong>Hands over to a person when:</strong>
              <ul style={{ margin: '4px 0 0 18px' }}>{agent.handoffConditions.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

/* ── Knowledge ───────────────────────────────────────────────────────── */
function KnowledgeTab({ scope, query, knowledge, by }: {
  scope: Scope; query: string; knowledge: CustomizeOverview['knowledge']; by: string;
}) {
  if (scope === 'discover') {
    return <Empty title="Nothing to discover yet">More knowledge sources can be connected from the back office. They will be listed under Yours once they are part of the active pack.</Empty>;
  }
  const hasRelease = !!knowledge.releaseId;
  const sources = knowledge.sources.filter((s) => matches(query, s.label, s.kind, s.role));
  const showRelease = hasRelease && matches(query, 'business knowledge', knowledge.releaseId, knowledge.version);
  if (!hasRelease && knowledge.sources.length === 0) {
    return <Empty title="No knowledge in this pack yet">No knowledge release or data source is attached to the active pack.</Empty>;
  }
  if (!showRelease && sources.length === 0) return <Empty title="No knowledge matches your search">Try a different word, or clear the search.</Empty>;
  return (
    <ul className="ax-grid">
      {showRelease && (
        <Card
          icon={<BookIcon size={20} />} title="Business knowledge" by={by}
          description="The verified knowledge release your assistant answers from: facts, guides and relationships it can cite."
          tags={[
            ...(knowledge.version ? [<span key="v" className="ax-tag">Version {knowledge.version}</span>] : []),
            ...(knowledge.status ? [<span key="st" className="ax-tag">{knowledge.status}</span>] : []),
            ...(knowledge.required ? [<span key="r" className="ax-tag">Required</span>] : []),
            ...(knowledge.publishedAt ? [<span key="p" className="ax-tag">Published {new Date(knowledge.publishedAt).toLocaleDateString()}</span>] : []),
            ...(typeof knowledge.conceptCount === 'number' ? [<span key="c" className="ax-tag">{plural(knowledge.conceptCount, 'concept')}</span>] : []),
          ]}
        >
          <details><summary>Release</summary><pre>{knowledge.releaseId}</pre></details>
        </Card>
      )}
      {sources.map((s: OverviewKnowledgeSource) => (
        <Card
          key={s.id} icon={<BookIcon size={20} />} title={s.label} by={by}
          tags={[
            <span key="k" className="ax-tag">{s.kind}</span>,
            ...(s.role ? [<span key="r" className="ax-tag">{s.role}</span>] : []),
            <span key="e" className="ax-tag">{s.enabled ? 'On' : 'Off'}</span>,
          ]}
        />
      ))}
    </ul>
  );
}

/* ── Plugins ─────────────────────────────────────────────────────────── */
function PluginsTab({ scope, query, plugins, agents, skills, systems }: {
  scope: Scope; query: string; plugins: OverviewPlugin[]; agents: OverviewAgent[]; skills: OverviewSkill[]; systems: OverviewSystem[];
}) {
  if (scope === 'discover') {
    return <Empty title="No plugins to discover yet">Plugin templates will appear here when the platform or your organisation offers some.</Empty>;
  }
  if (plugins.length === 0) {
    return (
      <Empty title="No plugins in this pack yet">
        A plugin bundles an agent, its skills, a form, the systems it reaches and its tools, and switches them on together for the people you choose.
      </Empty>
    );
  }
  const shown = plugins.filter((p) => matches(query, p.name, p.description, p.pluginId));
  if (shown.length === 0) return <Empty title="No plugins match your search">Try a different word, or clear the search.</Empty>;
  const nameOf = (list: Array<{ id: string; name: string }>) => (id: string) => list.find((entry) => entry.id === id)?.name || id;
  const agentName = nameOf(agents.map((a) => ({ id: a.agentId, name: a.name })));
  const skillName = nameOf(skills.map((s) => ({ id: s.skillId, name: s.name })));
  const systemName = nameOf(systems.map((s) => ({ id: s.connectorId, name: s.name })));
  return (
    <ul className="ax-grid">
      {shown.map((p) => {
        const parts: Array<[string, string[]]> = [
          ['Agents', p.provides.agents.map(agentName)],
          ['Skills', p.provides.skills.map(skillName)],
          ['Forms', p.provides.forms],
          ['Systems', p.provides.connectors.map(systemName)],
          ['Tools', p.provides.tools],
        ];
        return (
          <Card
            key={p.pluginId} icon={<PlugIcon size={20} />} title={p.name} by="your shop" description={p.description}
            tags={p.access.length === 0 ? [<span key="all" className="ax-tag">Everyone has it</span>] : p.access.map((row, index) => <span key={`row-${index}`} className="ax-tag">{describePluginAccess(row)}</span>)}
          >
            <div className="ax-hint">
              {parts.filter(([, names]) => names.length > 0).map(([label, names]) => <div key={label}><strong>{label}:</strong> {names.join(', ')}</div>)}
              {parts.every(([, names]) => names.length === 0) && <div>This plugin does not name anything yet.</div>}
            </div>
          </Card>
        );
      })}
    </ul>
  );
}
