'use client';

/**
 * The Connectors tab, laid out like Claude's: a table (Connector, Type, Status), and a page for each connector.
 *
 * A connected system's page has the switch for the whole assistant, then "Tool permissions": its tools in two groups, "Interactive tools"
 * (they change data in that system) and "Read-only tools", each tool with three buttons (Allow, Ask first, Blocked). Claude sets these
 * for one person; here they are set for one team at a time, chosen above the list. Nothing changes until "Make live": the server writes
 * the rules, publishes through the publication check, and puts everything back if the check refuses (see connectorPublish.ts).
 * The full table (every team side by side) stays one button away.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { BlockIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlugIcon, PlusIcon, QuestionIcon } from '@/components/shell/icons';
import {
  connectorRows, defaultColumn, describeEdit, filterRows, groupSetting, pickableColumns, setGroupState, setToolState, splitTools, stateOf, summarizeTools,
  type ConnectorRow,
} from '@/lib/customize/connectorPage';
import { countChanges, describeStatus, type RuleEdit } from '@/lib/customize/ruleGrid';
import type { CustomizeOverview, OverviewConnectorRules, OverviewSystem, ToolState } from '@/lib/customize/types';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export interface RulesChange { enabled?: boolean; cells?: Record<string, Record<string, ToolState>> }

export default function ConnectorsPane({ scope, query, overview, open, busy, onOpen, onSave, onFullTable, onAddToAgent }: {
  scope: 'yours' | 'discover';
  query: string;
  overview: CustomizeOverview;
  /** The id of the connector whose page is open, if any. */
  open: string | null;
  busy: boolean;
  onOpen: (id: string | null) => void;
  onSave: (system: OverviewConnectorRules, change: RulesChange, summary: string) => void;
  onFullTable: (system: OverviewConnectorRules) => void;
  onAddToAgent: (toolId: string) => void;
}) {
  const rows = useMemo(() => connectorRows(overview), [overview]);
  const opened = open ? [...rows.yours, ...rows.discover].find((row) => row.id === open) : undefined;
  if (opened) {
    const back = () => onOpen(null);
    if (opened.kind === 'system') {
      const rules = overview.connectorRules.find((system) => system.connectorId === opened.id);
      if (rules) return <SystemPage key={`${rules.connectorId}:${rules.base}`} system={rules} busy={busy} onBack={back} onSave={(change, summary) => onSave(rules, change, summary)} onFullTable={() => onFullTable(rules)} />;
      const info = overview.systems.find((system) => system.connectorId === opened.id);
      if (info) return <ReadOnlySystemPage system={info} row={opened} onBack={back} />;
    } else {
      const tool = overview.connectors.find((entry) => entry.id === opened.id);
      if (tool) {
        const names = tool.usedBy.map((id) => overview.agents.find((agent) => agent.agentId === id)?.name || id);
        return (
          <section className="ax-detail" aria-label={tool.name}>
            <BackLink label="Your connectors" onClick={back} />
            <Header icon={<PlugIcon size={22} />} title={tool.name} sub="Built into the platform" />
            <p className="ax-detail__text">{tool.description}</p>
            <h3 className="ax-detail__h">Who uses it</h3>
            <p className="ax-detail__text">{names.length ? `${names.join(', ')} may call it.` : 'No assistant may call it yet.'}</p>
            <button type="button" className="ax-btn ax-btn--small" onClick={() => onAddToAgent(tool.id)}><PlusIcon size={15} /> Add to a new agent</button>
          </section>
        );
      }
    }
  }

  const list = filterRows(scope === 'yours' ? rows.yours : rows.discover, query);
  if (list.length === 0) {
    if (query.trim()) return <Empty title="No connectors match your search">Try a different word, or clear the search.</Empty>;
    return scope === 'yours'
      ? <Empty title="No connectors in use">None of the agents in the active pack is allowed to call a connector.</Empty>
      : <Empty title="Everything is already in use">Every connected system is switched on, and every built-in tool is allowed for at least one agent.</Empty>;
  }
  return (
    <>
      <table className="ax-ctable" aria-label={scope === 'yours' ? 'Your connectors' : 'Connectors you can add'}>
        <thead>
          <tr><th scope="col">Connector</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col" className="ax-ctable__go"><span className="ax-sr">Open</span></th></tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.key} onClick={() => onOpen(row.id)}>
              <th scope="row">
                <button type="button" className="ax-ctable__name" onClick={(event) => { event.stopPropagation(); onOpen(row.id); }}>
                  <span className="ax-card__icon" aria-hidden="true"><PlugIcon size={18} /></span>
                  <span><strong>{row.name}</strong><small>{row.description}</small></span>
                </button>
              </th>
              <td>{row.type}</td>
              <td><StatusMark row={row} /></td>
              <td className="ax-ctable__go"><ChevronRightIcon size={16} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <aside className="ax-callout">
        <div>
          <strong>Need another system?</strong>
          <p>New systems are connected by your technical team in the back office. Once one is connected it shows up here, under Discover, until you switch it on.</p>
        </div>
      </aside>
    </>
  );
}

function StatusMark({ row }: { row: ConnectorRow }) {
  const { status } = row;
  return (
    <span className={`ax-status ax-status--${status.tone}`} title={status.detail || undefined}>
      {status.tone === 'good' && <CheckIcon size={15} />}
      {status.label}
      {status.tone === 'warn' && status.detail ? <small>{status.detail}</small> : null}
    </span>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="ax-back" onClick={onClick}><ChevronLeftIcon size={16} /> {label}</button>;
}

function Header({ icon, title, sub, actions }: { icon: ReactNode; title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ax-detail__head">
      <span className="ax-card__icon ax-card__icon--big" aria-hidden="true">{icon}</span>
      <div className="ax-detail__titles">
        <h2>{title}</h2>
        {sub && <p className="ax-detail__sub">{sub}</p>}
      </div>
      {actions && <div className="ax-detail__actions">{actions}</div>}
    </div>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="ax-empty"><h3>{title}</h3><p>{children}</p></div>;
}

function ReadOnlySystemPage({ system, row, onBack }: { system: OverviewSystem; row: ConnectorRow; onBack: () => void }) {
  return (
    <section className="ax-detail" aria-label={system.name}>
      <BackLink label="Your connectors" onClick={onBack} />
      <Header icon={<PlugIcon size={22} />} title={system.name} sub={`${row.type}${system.owner ? ` · ${system.owner}` : ''}`} />
      <p className="ax-detail__text">{system.description}</p>
      <p className="ax-detail__text">{system.tools} tool{system.tools === 1 ? '' : 's'}{system.writes > 0 ? `, ${system.writes} of which change data and ask first` : ''}.</p>
      <p className="ax-notice">Changing who may use this system needs permission to publish the configuration.</p>
    </section>
  );
}

const PERMS: Array<{ state: ToolState; label: string; icon: ReactNode }> = [
  { state: 'allow', label: 'Allow', icon: <CheckIcon size={15} /> },
  { state: 'ask', label: 'Ask first', icon: <QuestionIcon size={15} /> },
  { state: 'blocked', label: 'Blocked', icon: <BlockIcon size={15} /> },
];
const SETTING_LABEL: Record<ToolState | 'custom', string> = { allow: 'Always allow', ask: 'Ask first', blocked: 'Blocked', custom: 'Custom' };

function SystemPage({ system, busy, onBack, onSave, onFullTable }: {
  system: OverviewConnectorRules;
  busy: boolean;
  onBack: () => void;
  onSave: (change: RulesChange, summary: string) => void;
  onFullTable: () => void;
}) {
  const [edit, setEdit] = useState<RuleEdit>(() => ({ enabled: system.enabled, grid: clone(system.grid) }));
  const teams = useMemo(() => pickableColumns(system), [system]);
  const [team, setTeam] = useState(() => defaultColumn(system));
  const { interactive, readOnly } = useMemo(() => splitTools(system), [system]);
  const status = describeStatus(system.status);
  const changes = countChanges(system, edit);
  const switched = edit.enabled !== system.enabled;
  const teamName = teams.find((column) => column.id === team)?.name ?? team;

  const submit = () => {
    const cells: Record<string, Record<string, ToolState>> = {};
    for (const tool of system.tools) {
      if (system.columns.some((column) => stateOf(edit, tool.name, column.id) !== system.grid[tool.name]?.[column.id])) {
        cells[tool.name] = Object.fromEntries(system.columns.map((column) => [column.id, stateOf(edit, tool.name, column.id)]));
      }
    }
    onSave({ ...(switched ? { enabled: edit.enabled } : {}), ...(changes > 0 ? { cells } : {}) }, describeEdit(system, edit));
  };

  const group = (title: string, tools: typeof interactive, writes: boolean) => {
    if (tools.length === 0) return null;
    const setting = groupSetting(edit, tools, team);
    const options: Array<ToolState | 'custom'> = [...(setting === 'custom' ? (['custom'] as const) : []), ...(writes ? [] : (['allow'] as const)), 'ask', 'blocked'];
    return (
      <div className="ax-permgroup" role="group" aria-label={title}>
        <div className="ax-permgroup__head">
          <h4>{title} <span className="ax-muted">({tools.length})</span></h4>
          <select
            className="ax-permgroup__set"
            aria-label={`Setting for all ${title.toLowerCase()} for ${teamName}`}
            value={setting}
            onChange={(event) => { const value = event.target.value as ToolState | 'custom'; if (value !== 'custom') setEdit((prev) => setGroupState(prev, tools, team, value)); }}
          >
            {options.map((value) => <option key={value} value={value} disabled={value === 'custom'}>{SETTING_LABEL[value]}</option>)}
          </select>
        </div>
        <ul className="ax-permlist">
          {tools.map((tool) => {
            const state = stateOf(edit, tool.name, team);
            const was = system.grid[tool.name]?.[team];
            return (
              <li key={tool.name} className={was !== state ? 'ax-permlist__changed' : undefined}>
                <div className="ax-permlist__text">
                  <strong>{tool.label}</strong>
                  {tool.summary && <small>{tool.summary}</small>}
                </div>
                <div className="ax-perm" role="group" aria-label={`${tool.label} for ${teamName}`}>
                  {PERMS.map((perm) => (
                    <button
                      key={perm.state}
                      type="button"
                      className={`ax-perm__btn ax-perm__btn--${perm.state}`}
                      aria-pressed={state === perm.state}
                      aria-label={perm.label}
                      title={perm.state === 'allow' && writes ? 'A tool that changes data always asks first' : perm.label}
                      disabled={perm.state === 'allow' && writes}
                      onClick={() => setEdit((prev) => setToolState(prev, tool, team, perm.state))}
                    >
                      {perm.icon}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <section className="ax-detail" aria-label={system.name}>
      <BackLink label="Your connectors" onClick={onBack} />
      <Header
        icon={<PlugIcon size={22} />}
        title={system.name}
        sub={<>{system.sample ? 'Sample data' : 'Real data'}{system.owner ? ` · ${system.owner}` : ''} · <span className={`ax-status ax-status--${status.tone === 'bad' ? 'warn' : status.tone === 'good' ? 'good' : 'plain'}`}>{status.label}{status.detail ? ` (${status.detail})` : ''}</span></>}
        actions={(
          <>
            <button type="button" className="ax-btn ax-btn--small" onClick={onFullTable}>All teams</button>
            <div className="ax-switchlabel">
              <span>{edit.enabled ? 'On' : 'Off'}</span>
              <button type="button" role="switch" aria-checked={edit.enabled} aria-label={`${system.name} is ${edit.enabled ? 'on' : 'off'} for the assistant`} className="ax-switch ax-switch--button" data-on={edit.enabled ? 'true' : 'false'} onClick={() => setEdit((prev) => ({ ...prev, enabled: !prev.enabled }))}>
                <span className="ax-switch__knob" />
              </button>
            </div>
          </>
        )}
      />
      <p className="ax-detail__text">{system.description}</p>
      <p className="ax-detail__meta">{summarizeTools(system)}</p>
      {edit.enabled && !system.enabled && status.tone === 'bad' && (
        <p className="ax-draftnote" role="status">The connection check says {system.name} is not connected yet{status.detail ? ` (${status.detail})` : ''}. If you switch it on now, the assistant will offer it and its calls will fail until it is connected.</p>
      )}
      {!edit.enabled && <p className="ax-notice">While it is off the assistant never sees {system.name}, whatever the tool settings below say.</p>}

      <h3 className="ax-detail__h">Tool permissions</h3>
      <div className="ax-teampick">
        <label htmlFor={`team-${system.connectorId}`}>What may</label>
        <select id={`team-${system.connectorId}`} value={team} onChange={(event) => setTeam(event.target.value)}>
          {teams.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
        </select>
        <span className="ax-muted">do with {system.name}? Shoppers can never use a connected system.</span>
      </div>
      {system.tools.length === 0 ? <p className="ax-muted">This system lists no tools.</p> : (
        <>
          {group('Interactive tools', interactive, true)}
          {group('Read-only tools', readOnly, false)}
        </>
      )}
      {(system.notes.defaultRows > 0 || system.notes.allStaffRows > 0 || system.notes.everyoneRows > 0) && (
        <p className="ax-hint ax-hint--warn">This system also has default or all-staff rules. The settings above show what they add up to; changing a tool writes its rules for each team explicitly. The “All teams” table shows the same.</p>
      )}

      {(changes > 0 || switched) && (
        <div className="ax-savebar" role="region" aria-label="Unsaved changes">
          <span>{describeEdit(system, edit)}.</span>
          <span className="ax-toolbar__spacer" />
          <button type="button" className="ax-btn ax-btn--quiet" onClick={() => setEdit({ enabled: system.enabled, grid: clone(system.grid) })}>Discard</button>
          <button type="button" className="ax-btn ax-btn--primary" disabled={busy} onClick={submit}>{busy ? 'Publishing…' : 'Make live'}</button>
        </div>
      )}
    </section>
  );
}
