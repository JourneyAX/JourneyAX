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
  AgentIcon, BookIcon, CopyIcon, PlugIcon, PlusIcon, SearchIcon, SidebarIcon, SkillIcon, SparkIcon, TrashIcon,
} from '@/components/shell/icons';
import { useDismiss } from '@/components/shell/useDismiss';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { forSidebar } from '@/lib/shell/conversationNav';
import { copyText } from '@/lib/shell/clipboard';
import { type AgentDraft, type AgentDraftInput, draftToPackAgentJson, loadDrafts, removeDraft, saveDrafts, upsertDraft } from '@/lib/customize/drafts';
import type { CustomizeOverview, OverviewAgent, OverviewConnector, OverviewKnowledgeSource, OverviewSkill } from '@/lib/customize/types';
import AgentForm from './AgentForm';
import { useOverview } from './useOverview';

type TabId = 'agents' | 'skills' | 'knowledge' | 'connectors';
type Scope = 'yours' | 'discover';

const TABS: { id: TabId; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
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
  knowledge: {
    title: 'Knowledge is what your assistant answers from',
    text: 'Verified business knowledge and the data sources behind it. Agents consult it instead of guessing, so what they tell customers can be traced back.',
    icons: [<BookIcon key="b" size={22} />, <SparkIcon key="s" size={22} />],
  },
  connectors: {
    title: 'Connectors are the tools agents can call',
    text: 'Search the range, check stock, build a quote, hand over to a person. Each agent is allowed only the connectors it needs.',
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
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [form, setForm] = useState<{ draft?: AgentDraft; presetTools?: string[] } | null>(null);
  const [toast, setToast] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  useDismiss(addRef, addOpen, closeAdd);
  const tenant = cfg.projectId;

  useEffect(() => { setDrafts(loadDrafts(tenant)); }, [tenant]);
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

  const by = cfg.companyName || 'Your organisation';
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const skillCountByAgent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of agents) for (const id of a.skills) map.set(id, [...(map.get(id) || []), a.name]);
    return map;
  }, [agents]);

  const changeTab = (id: TabId) => { setTab(id); setQuery(''); };
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
    knowledge: data ? (data.knowledge.releaseId ? 1 : 0) + data.knowledge.sources.length : undefined,
    connectors: data ? data.connectors.filter((c) => c.usedBy.length > 0).length : undefined,
  };

  const banner = BANNERS[tab];

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
          <p className="ax-page__lede">See what your assistant is made of and sketch new agents. Changes you draft here are not live until they are published from the back office.</p>

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
            <div className="ax-toolbar">
              <div className="ax-segment" role="group" aria-label="Show">
                <button type="button" aria-pressed={scope === 'yours'} onClick={() => setScope('yours')}>Yours</button>
                <button type="button" aria-pressed={scope === 'discover'} onClick={() => setScope('discover')}>Discover</button>
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
                    <button type="button" role="menuitem" className="ax-menu__item" onClick={() => { setAddOpen(false); setForm({}); }}>
                      <AgentIcon size={16} /> New agent
                    </button>
                    <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                      <SkillIcon size={16} /> New skill <span className="ax-badge">Back office</span>
                    </button>
                    <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                      <BookIcon size={16} /> Add knowledge <span className="ax-badge">Back office</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <section className="ax-herocard" aria-label="About this tab">
              <div>
                <h2>{banner.title}</h2>
                <p>{banner.text}</p>
                {tab === 'agents' && <button type="button" className="ax-btn ax-btn--primary" style={{ marginTop: 14 }} onClick={() => setForm({})}><PlusIcon size={16} /> New agent</button>}
              </div>
              <div className="ax-herocard__art" aria-hidden="true">{banner.icons.map((icon, i) => <span key={i}>{icon}</span>)}</div>
            </section>

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
            {data && tab === 'skills' && <SkillsTab scope={scope} query={query} skills={data.skills} usedBy={skillCountByAgent} by={by} canViewInstructions={data.canViewInstructions} />}
            {data && tab === 'knowledge' && <KnowledgeTab scope={scope} query={query} knowledge={data.knowledge} by={by} />}
            {data && tab === 'connectors' && (
              <ConnectorsTab scope={scope} query={query} connectors={data.connectors} agents={agents} onAddToAgent={(id) => setForm({ presetTools: [id] })} />
            )}
          </div>
        </div>
      </div>

      {form && <AgentForm overview={data} draft={form.draft} presetTools={form.presetTools} onSave={saveDraft} onClose={() => setForm(null)} />}
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
function AgentsTab({ scope, query, overview, drafts, by, onTry, onNew, onEdit, onDelete, onCopy }: {
  scope: Scope; query: string; overview: CustomizeOverview; drafts: AgentDraft[]; by: string;
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
                    <button type="button" className="ax-btn ax-btn--small ax-btn--quiet" onClick={() => onCopy(d)}><CopyIcon size={15} /> Copy JSON</button>
                    <span className="ax-toolbar__spacer" />
                    <button type="button" className="ax-iconbtn" onClick={() => onDelete(d)} aria-label={`Delete draft ${d.name}`} title="Delete draft"><TrashIcon size={16} /></button>
                  </>
                )}
              />
            ))}
          </ul>
          <p className="ax-notice">Drafts live only in this browser. To make one live, copy its JSON and have it published from the back office.</p>
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

/* ── Skills ──────────────────────────────────────────────────────────── */
function SkillsTab({ scope, query, skills, usedBy, by, canViewInstructions }: {
  scope: Scope; query: string; skills: OverviewSkill[]; usedBy: Map<string, string[]>; by: string; canViewInstructions: boolean;
}) {
  if (scope === 'discover') {
    return <Empty title="No skills to discover yet">Skill templates will appear here when the platform or your organisation offers some.</Empty>;
  }
  if (skills.length === 0) {
    return (
      <Empty title="No skills in this pack yet">
        Skills are reusable instructions an agent can carry. When the active pack defines some, they are listed here with the agents that use them.
      </Empty>
    );
  }
  const shown = skills.filter((s) => matches(query, s.name, s.description));
  if (shown.length === 0) return <Empty title="No skills match your search">Try a different word, or clear the search.</Empty>;
  return (
    <ul className="ax-grid">
      {shown.map((s) => {
        const agents = usedBy.get(s.skillId) || [];
        return (
          <Card
            key={s.skillId} icon={<SkillIcon size={20} />} title={s.name} by={by} description={s.description}
            tags={[
              <span key="tier" className="ax-tag">{s.tier === 'always' ? 'Always on' : 'On demand'}</span>,
              ...(s.tools.length ? [<span key="t" className="ax-tag">{plural(s.tools.length, 'connector')}</span>] : []),
              <span key="a" className="ax-tag">{agents.length ? `Used by ${agents.join(', ')}` : 'Not used by an agent yet'}</span>,
            ]}
          >
            {canViewInstructions && s.instructions && (
              <details><summary>Instructions</summary><pre>{s.instructions}</pre></details>
            )}
          </Card>
        );
      })}
    </ul>
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

/* ── Connectors ──────────────────────────────────────────────────────── */
function ConnectorsTab({ scope, query, connectors, agents, onAddToAgent }: {
  scope: Scope; query: string; connectors: OverviewConnector[]; agents: OverviewAgent[]; onAddToAgent: (id: string) => void;
}) {
  const wanted = connectors.filter((c) => (scope === 'yours' ? c.usedBy.length > 0 : c.usedBy.length === 0));
  const shown = wanted.filter((c) => matches(query, c.name, c.description, c.id));
  if (wanted.length === 0) {
    return scope === 'yours'
      ? <Empty title="No connectors in use">None of the agents in the active pack is allowed to call a connector.</Empty>
      : <Empty title="Everything is already in use">Every built-in connector is allowed for at least one agent.</Empty>;
  }
  if (shown.length === 0) return <Empty title="No connectors match your search">Try a different word, or clear the search.</Empty>;
  const agentName = (id: string) => agents.find((a) => a.agentId === id)?.name || id;
  return (
    <ul className="ax-grid">
      {shown.map((c) => (
        <Card
          key={c.id} icon={<PlugIcon size={20} />} title={c.name} by="the platform (built in)" description={c.description}
          tags={c.usedBy.length ? [<span key="u" className="ax-tag" title={c.usedBy.map(agentName).join(', ')}>Used by {c.usedBy.map(agentName).join(', ')}</span>] : [<span key="n" className="ax-tag">Not used yet</span>]}
          actions={(
            <button type="button" className="ax-btn ax-btn--small" onClick={() => onAddToAgent(c.id)} title="Start a new agent draft with this connector">
              <PlusIcon size={15} /> Add to a new agent
            </button>
          )}
        />
      ))}
    </ul>
  );
}
