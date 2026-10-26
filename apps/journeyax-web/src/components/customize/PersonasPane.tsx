'use client';

/**
 * The Personas tab: who uses the assistant and what they want done, from the persona library kept in the project database.
 *
 *   By team        each team of staff with its personas as cards, how many of its use cases have working tools, and what it is waiting on
 *   Customers      the customers and partners, by group
 *   A persona      its description, how it signs in, and each use case with the sheet's readiness, the tools it needs, and whether
 *                  the persona's team can use each tool right now (lib/customize/personas.ts), with "Edit tools" to add tools a person knows it needs
 *
 * Saving the tools of a scenario changes nothing the assistant says or may do; it is a note the page checks. Shown to people who may change
 * the configuration (the project service checks that too).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, UserIcon } from '@/components/shell/icons';
import {
  checkScenarios, OUTCOME_WORDS, VERDICT_WORDS, VERDICTS,
  type Counts, type LibPersona, type LibUseCase, type PersonaChecks, type PersonaLibraryView, type UseCaseCheck,
} from '@/lib/customize/personas';
import type { CustomizeOverview } from '@/lib/customize/types';
import { buildScenarios, wordQuestion, type TestScenario } from '@/lib/customize/scenarios';
import ScenarioQuestionDialog from './ScenarioQuestionDialog';
import ScenarioToolsDialog from './ScenarioToolsDialog';
import { usePersonaLibrary, type SaveOutcome } from './usePersonaLibrary';

type Overview = CustomizeOverview;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const matches = (query: string, ...parts: Array<string | undefined>) => {
  const q = query.trim().toLowerCase();
  return !q || parts.some((part) => (part || '').toLowerCase().includes(q));
};

export default function PersonasPane({ overview, query, tenant, open, onOpen, onToast, onTryQuestion }: {
  overview: Overview;
  query: string;
  tenant: string | undefined;
  /** The id of the persona whose page is open, if any. */
  open: string | null;
  onOpen: (personaId: string | null) => void;
  onToast: (message: string) => void;
  /** Starts a new chat with this question typed in the message box (not sent). */
  onTryQuestion: (question: string) => void;
}) {
  const allowed = overview.canViewInstructions;
  const { answer, error, loading, reload, save, savePrompt } = usePersonaLibrary(allowed, tenant);

  if (!allowed) {
    return <Empty title="Personas are for people who manage the assistant">The personas and the tools each scenario needs are shown to people who may change the configuration.</Empty>;
  }
  if (error && !answer) {
    return <div className="ax-notice ax-notice--error" role="alert">{error} <button type="button" className="ax-linkbtn" onClick={() => void reload()}>Try again</button></div>;
  }
  if (loading || !answer) {
    return <ul className="ax-grid" aria-busy="true" aria-label="Loading">{[0, 1, 2].map((i) => <li key={i} className="ax-skeleton" />)}</ul>;
  }
  if (!answer.present) {
    return (
      <Empty title="No persona library is loaded yet">
        The persona library is the catalogue of personas and use cases built from the sheets. It is loaded into the project with the import script
        (<code>scripts/placemakers/import-personas.ts --load-into</code>), which your technical team runs. Once it is there, the personas show up here.
      </Empty>
    );
  }
  return <PersonasView overview={overview} library={answer} query={query} open={open} onOpen={onOpen} onToast={onToast} save={save} savePrompt={savePrompt} onTryQuestion={onTryQuestion} />;
}

/** The loaded library: team sections, a persona's page and the tools dialog. (Separate from the loading so it can be looked at on its own.) */
export function PersonasView({ overview, library, query, open, onOpen, onToast, save, savePrompt, onTryQuestion, initialView = 'teams' }: {
  overview: Overview;
  library: PersonaLibraryView;
  query: string;
  open: string | null;
  onOpen: (personaId: string | null) => void;
  onToast: (message: string) => void;
  save: (useCaseId: string, tools: string[]) => Promise<SaveOutcome>;
  savePrompt: (useCaseId: string, prompt: string) => Promise<SaveOutcome>;
  onTryQuestion: (question: string) => void;
  initialView?: 'teams' | 'customers' | 'scenarios';
}) {
  const [view, setView] = useState<'teams' | 'customers' | 'scenarios'>(initialView);
  const [asking, setAsking] = useState<TestScenario | null>(null);
  const [editing, setEditing] = useState<{ useCase: LibUseCase; check: UseCaseCheck } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const checks = useMemo(() => checkScenarios(library, overview), [library, overview]);
  const scenarios = useMemo(() => buildScenarios(library, checks), [library, checks]);
  // An address that names a persona the library does not have goes back to the list.
  useEffect(() => { if (open && !library.library.personas.some((p) => p.id === open)) onOpen(null); }, [open, library, onOpen]);

  const personas = new Map(library.library.personas.map((p) => [p.id, p]));
  const useCasesOf = (personaId: string) => library.library.useCases.filter((u) => u.personaId === personaId);
  const opened = open ? personas.get(open) : undefined;

  const submitTools = async (tools: string[]) => {
    if (!editing) return;
    setBusy(true);
    setSaveError('');
    const result = await save(editing.useCase.id, tools);
    setBusy(false);
    if (result.ok) { setEditing(null); onToast(tools.length ? `Saved ${plural(tools.length, 'extra tool')} for “${editing.useCase.title}”.` : `Cleared the extra tools of “${editing.useCase.title}”.`); return; }
    setSaveError(result.error);
    if (result.conflict) onToast('The library changed while you were editing; it has been reloaded. Try again.');
  };

  const submitQuestion = async (text: string) => {
    if (!asking) return;
    setBusy(true);
    setSaveError('');
    const result = await savePrompt(asking.useCaseId, text);
    setBusy(false);
    if (result.ok) { onToast(text ? `Saved the question for “${asking.title}”.` : `“${asking.title}” uses the suggested question again.`); setAsking(null); return; }
    setSaveError(result.error);
    if (result.conflict) onToast('The library changed while you were editing; it has been reloaded. Try again.');
  };

  const questionDialog = asking && (
    <ScenarioQuestionDialog
      key={asking.useCaseId}
      title={asking.title}
      suggested={library.library.testCases.find((c) => c.useCase === asking.useCaseId)?.prompt ?? wordQuestion(library.library.useCases.find((u) => u.id === asking.useCaseId)?.story ?? '', asking.title)}
      current={library.scenarioPrompts[asking.useCaseId] ?? ''}
      busy={busy}
      error={saveError}
      onSave={submitQuestion}
      onClose={() => { setAsking(null); setSaveError(''); }}
    />
  );

  const dialog = editing && (
    <ScenarioToolsDialog
      key={editing.useCase.id}
      title={editing.useCase.title}
      audience={editing.check.audience}
      audienceName={editing.check.audienceName}
      overview={overview}
      fromPlaybook={editing.check.tools.filter((tool) => tool.from !== 'you')}
      current={library.scenarioTools[editing.useCase.id] ?? []}
      busy={busy}
      error={saveError}
      onSave={submitTools}
      onClose={() => { setEditing(null); setSaveError(''); }}
    />
  );

  if (opened) {
    return (
      <>
        <PersonaPage persona={opened} useCases={useCasesOf(opened.id)} checks={checks} library={library} onBack={() => onOpen(null)} onEdit={(useCase, check) => { setSaveError(''); setEditing({ useCase, check }); }} />
        {dialog}
      </>
    );
  }

  const staff = library.library.personas.filter((p) => p.kind === 'staff');
  const customers = library.library.personas.filter((p) => p.kind === 'customer');
  const shown = (list: LibPersona[]) => list.filter((p) => matches(query, p.name, p.description, p.group, p.goal, ...useCasesOf(p.id).map((u) => u.title)));

  return (
    <>
      <SummaryStrip library={library} checks={checks} />
      <div className="ax-toolbar" style={{ marginTop: 14 }}>
        <div className="ax-segment" role="group" aria-label="Show personas">
          <button type="button" aria-pressed={view === 'teams'} onClick={() => setView('teams')}>Staff teams <span className="ax-muted">{staff.length}</span></button>
          <button type="button" aria-pressed={view === 'customers'} onClick={() => setView('customers')}>Customers and partners <span className="ax-muted">{customers.length}</span></button>
          <button type="button" aria-pressed={view === 'scenarios'} onClick={() => setView('scenarios')}>Test scenarios <span className="ax-muted">{scenarios.length}</span></button>
        </div>
      </div>

      {view === 'scenarios' ? (
        <ScenarioList scenarios={scenarios.filter((s) => matches(query, s.title, s.personaName, s.audienceName, s.question.text, s.signIn.kind === 'login' ? s.signIn.email : ''))} onTry={(s) => onTryQuestion(s.question.text)} onEdit={(s) => { setSaveError(''); setAsking(s); }} />
      ) : view === 'teams' ? (
        <>
          {library.library.teams.map((team) => {
            const list = shown(team.personas.map((id) => personas.get(id)).filter((p): p is LibPersona => !!p));
            if (list.length === 0 && (query.trim() || team.personas.length > 0)) return null;
            const counts = checks.byTeam[team.team];
            return (
              <section key={team.team} aria-label={team.name}>
                <h2 className="ax-listhead">
                  {team.name} <span className={`ax-tag${team.status === 'planned' ? ' ax-tag--draft' : ''}`}>{team.status === 'live' ? 'Live' : 'Planned'}</span>{' '}
                  <span className="ax-muted">{plural(team.personas.length, 'persona')} · {plural(team.useCases, 'use case')}</span>
                </h2>
                <p className="ax-hint ax-teamnote">
                  {team.note}{team.agent ? ` Answered by ${team.agent}.` : ' No assistant is set up for this team yet.'}
                  {team.waitingOn.length > 0 && <> Waiting on: {team.waitingOn.map((w) => `${w.system} (${w.state}, ${plural(w.useCases, 'use case')})`).join(', ')}.</>}
                </p>
                {counts && <VerdictChips counts={counts} />}
                <ul className="ax-grid">{list.map((p) => <PersonaCard key={p.id} persona={p} counts={checks.byPersona[p.id]} onOpen={() => onOpen(p.id)} />)}</ul>
              </section>
            );
          })}
        </>
      ) : (
        <>
          {groupBy(shown(customers), (p) => p.group || 'Customers').map(([group, list]) => (
            <section key={group} aria-label={group}>
              <h2 className="ax-listhead">{group} <span className="ax-muted">{plural(list.length, 'persona')}</span></h2>
              <ul className="ax-grid">{list.map((p) => <PersonaCard key={p.id} persona={p} counts={checks.byPersona[p.id]} onOpen={() => onOpen(p.id)} />)}</ul>
            </section>
          ))}
          <p className="ax-notice">Customers use the shop’s own tools, which are not listed as tools, so their scenarios show “Not checked” until someone names the tools one needs. A connected system (the CRM, the order system) is never available to a shopper.</p>
        </>
      )}
      {view !== 'scenarios' && shown(view === 'teams' ? staff : customers).length === 0 && <Empty title="No persona matches your search">Try a different word, or clear the search.</Empty>}
      {dialog}
      {questionDialog}
    </>
  );
}

/** Every use case as something to try: who to sign in as, what to type, what should be possible, and what the answer should and should not say. */
function ScenarioList({ scenarios, onTry, onEdit }: { scenarios: TestScenario[]; onTry: (scenario: TestScenario) => void; onEdit: (scenario: TestScenario) => void }) {
  if (scenarios.length === 0) return <Empty title="No scenario matches your search">Try a different word, or clear the search.</Empty>;
  return (
    <>
      <p className="ax-notice">A scenario to try for every use case. Sign in as the person named, then press <strong>Try in chat</strong>: the question is typed for you, not sent. Change a question with <strong>Edit question</strong>. Nothing here changes what the assistant does.</p>
      {groupBy(scenarios, (s) => s.audienceName || 'Other').sort(([a], [b]) => (a === 'shoppers' ? 1 : 0) - (b === 'shoppers' ? 1 : 0)).map(([group, list]) => (
        <section key={group} aria-label={group}>
          <h2 className="ax-listhead">{group} <span className="ax-muted">{plural(list.length, 'scenario')}</span></h2>
          {list.map((s) => (
            <article key={s.useCaseId} className="ax-uc ax-scn" aria-label={s.title}>
              <div className="ax-uc__head">
                <h4>{s.title} <span className="ax-muted">· {s.personaName}</span></h4>
                <div className="ax-card__meta"><span className={`ax-verdict ax-verdict--${s.verdict}`} title={s.summary}>{VERDICT_WORDS[s.verdict]}</span></div>
              </div>
              <dl className="ax-facts">
                <dt>Sign in as</dt>
                <dd>{s.signIn.kind === 'login' ? <code>{s.signIn.email}</code> : <span className="ax-muted">{s.signIn.note}</span>}</dd>
                <dt>Ask</dt>
                <dd><span className="ax-quote">“{s.question.text}”</span> <span className="ax-tag" title="Where this wording comes from">{s.question.source}</span></dd>
                <dt>Should be able to</dt>
                <dd>
                  {s.doors.works.length + s.doors.asks.length + s.doors.stopped.length === 0
                    ? <span className="ax-muted">No tools named for this scenario yet.</span>
                    : (
                      <span className="ax-doors">
                        {s.doors.works.length > 0 && <span className="ax-outcome ax-outcome--ok" title={s.doors.works.join(', ')}>{s.doors.works.length} work</span>}
                        {s.doors.asks.length > 0 && <span className="ax-outcome ax-outcome--ask" title={s.doors.asks.join(', ')}>{s.doors.asks.length} ask first</span>}
                        {s.doors.stopped.length > 0 && <span className="ax-outcome ax-outcome--blocked" title={s.doors.stopped.join('; ')}>{s.doors.stopped.length} stopped</span>}
                        <span className="ax-muted">{[...s.doors.works, ...s.doors.asks].slice(0, 4).join(', ')}{s.doors.works.length + s.doors.asks.length > 4 ? '…' : ''}</span>
                      </span>
                    )}
                </dd>
                {s.doors.stopped.length > 0 && <><dt>Stopped</dt><dd className="ax-muted">{s.doors.stopped.join('; ')}</dd></>}
                {s.shouldSay.length > 0 && <><dt>Should say</dt><dd><ul className="ax-plainlist">{s.shouldSay.map((line) => <li key={line}>{line}</li>)}</ul></dd></>}
                {s.shouldNot.length > 0 && <><dt>Should not</dt><dd><ul className="ax-plainlist">{s.shouldNot.map((line) => <li key={line}>{line}</li>)}</ul></dd></>}
                {s.note && <><dt>Note</dt><dd className="ax-muted">{s.note}</dd></>}
              </dl>
              <div className="ax-card__actions">
                <button type="button" className="ax-btn ax-btn--small ax-btn--primary" onClick={() => onTry(s)}>Try in chat</button>
                <button type="button" className="ax-btn ax-btn--small" onClick={() => onEdit(s)}>Edit question</button>
              </div>
            </article>
          ))}
        </section>
      ))}
    </>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()];
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="ax-empty"><h3>{title}</h3><p>{children}</p></div>;
}

function VerdictChips({ counts }: { counts: Counts }) {
  return (
    <div className="ax-card__meta" role="group" aria-label="What the tools check says">
      {VERDICTS.filter((v) => counts[v] > 0).map((v) => <span key={v} className={`ax-verdict ax-verdict--${v}`}>{counts[v]} {v === 'gaps' && counts[v] === 1 ? 'gap' : VERDICT_WORDS[v].toLowerCase()}</span>)}
    </div>
  );
}

function SummaryStrip({ library, checks }: { library: PersonaLibraryView; checks: PersonaChecks }) {
  const when = library.updatedAt ? new Date(library.updatedAt) : undefined;
  return (
    <div className="ax-summary">
      <p>
        <strong>{library.library.personas.length} personas</strong> and <strong>{library.library.useCases.length} use cases</strong>, from the sheets
        {when && !Number.isNaN(when.getTime()) ? `, loaded ${when.toLocaleDateString()}${library.updatedBy ? ` by ${library.updatedBy}` : ''}` : ''}.
        Each use case is checked against the tools the assistant has right now.
      </p>
      <VerdictChips counts={checks.totals} />
    </div>
  );
}

function PersonaCard({ persona, counts, onOpen }: { persona: LibPersona; counts: Counts | undefined; onOpen: () => void }) {
  return (
    <li className="ax-card">
      <div className="ax-card__head">
        <span className="ax-card__icon" aria-hidden="true"><UserIcon size={20} /></span>
        <div className="ax-card__titles">
          <h3 className="ax-card__title"><button type="button" className="ax-linkbtn ax-linkbtn--title" onClick={onOpen}>{persona.name}</button></h3>
          <p className="ax-card__by">{persona.group || persona.side}</p>
        </div>
      </div>
      <p className="ax-card__desc">{persona.description}</p>
      <div className="ax-card__meta">
        {persona.priority && <span className="ax-tag">{persona.priority}</span>}
        {persona.signIn && <span className="ax-tag">{persona.signIn === 'guest' ? 'No sign-in' : persona.signIn === 'buyer' ? 'Signs in as a buyer' : 'Staff sign-in'}</span>}
        <span className="ax-tag">{plural(persona.useCases.length, 'use case')}</span>
      </div>
      {counts && <VerdictChips counts={counts} />}
      <div className="ax-card__actions"><button type="button" className="ax-btn ax-btn--small" onClick={onOpen}>Open</button></div>
    </li>
  );
}

function PersonaPage({ persona, useCases, checks, library, onBack, onEdit }: {
  persona: LibPersona;
  useCases: LibUseCase[];
  checks: PersonaChecks;
  library: PersonaLibraryView;
  onBack: () => void;
  onEdit: (useCase: LibUseCase, check: UseCaseCheck) => void;
}) {
  const team = library.library.teams.find((t) => t.team === persona.team);
  return (
    <section className="ax-detail" aria-label={persona.name}>
      <button type="button" className="ax-back" onClick={onBack}><ChevronLeftIcon size={16} /> All personas</button>
      <div className="ax-detail__head">
        <span className="ax-card__icon ax-card__icon--big" aria-hidden="true"><UserIcon size={22} /></span>
        <div className="ax-detail__titles">
          <h2>{persona.name}</h2>
          <p className="ax-detail__sub">{persona.kind === 'customer' ? persona.group || 'Customer' : team ? `${team.name} team` : 'Staff'}{persona.priority ? ` · ${persona.priority}` : ''}</p>
        </div>
      </div>
      <p className="ax-detail__text">{persona.description}</p>
      <dl className="ax-facts">
        {persona.goal && <><dt>Wants</dt><dd>{persona.goal}</dd></>}
        {persona.channel && <><dt>Where</dt><dd>{persona.channel}</dd></>}
        {persona.systems.length > 0 && <><dt>Systems</dt><dd>{persona.systems.join(', ')}</dd></>}
        {persona.signIn && <><dt>Signs in</dt><dd>{persona.signIn === 'guest' ? 'Not signed in' : persona.signIn === 'buyer' ? 'As a buyer' : 'As staff'}{persona.accessRoles.length ? ` · ${persona.accessRoles.join(', ')}` : ''}</dd></>}
        {!persona.signIn && persona.accessRoles.length > 0 && <><dt>Access</dt><dd>{persona.accessRoles.join(', ')}</dd></>}
      </dl>

      <h3 className="ax-detail__h">Use cases <span className="ax-muted">({useCases.length})</span></h3>
      {useCases.length === 0 && <p className="ax-muted">No use cases are listed for this persona.</p>}
      {useCases.map((useCase) => {
        const check = checks.byUseCase[useCase.id];
        return <UseCaseBlock key={useCase.id} useCase={useCase} check={check} yours={library.scenarioTools[useCase.id] ?? []} onEdit={() => onEdit(useCase, check)} />;
      })}
    </section>
  );
}

function UseCaseBlock({ useCase, check, yours, onEdit }: { useCase: LibUseCase; check: UseCaseCheck; yours: string[]; onEdit: () => void }) {
  return (
    <article className="ax-uc" aria-label={useCase.title}>
      <div className="ax-uc__head">
        <h4>{useCase.title}</h4>
        <div className="ax-card__meta">
          {useCase.priority && <span className="ax-tag">{useCase.priority}</span>}
          <span className={`ax-tag ax-sheet ax-sheet--${useCase.readiness.replace(/ /g, '-')}`} title="What the sheet says">Sheet: {useCase.readiness}</span>
          <span className={`ax-verdict ax-verdict--${check.verdict}`} title={check.summary}>{VERDICT_WORDS[check.verdict]}</span>
        </div>
      </div>
      <p className="ax-uc__story">{useCase.story}</p>
      {useCase.workflow && <p className="ax-hint">Flow: {useCase.workflow}</p>}
      <p className="ax-uc__summary">{check.summary}{check.verdict === 'gaps' || check.verdict === 'ready' ? ` · judged under the rules for ${check.audienceName}` : ''}.</p>
      {check.disagrees && <p className="ax-draftnote" role="note">The sheet calls this fully ready, but the tools show a gap.</p>}
      {check.playbooks.length > 0 && (
        <p className="ax-hint">Playbook: {check.playbooks.map((pb) => (pb.found ? pb.name : `${pb.id} (not in the assistant)`)).join(', ')}</p>
      )}
      {check.tools.length > 0 && (
        <ul className="ax-toolrows">
          {check.tools.map((tool) => (
            <li key={tool.id}>
              <span className={`ax-outcome ax-outcome--${tool.outcome}`}>{OUTCOME_WORDS[tool.outcome]}</span>
              <span className="ax-toolrows__name">{tool.label} <span className="ax-muted">{tool.system}</span>{tool.changesData && <span className="ax-tag ax-tag--draft" style={{ marginLeft: 6 }}>changes data</span>}</span>
              <span className="ax-toolrows__from">{tool.from === 'you' ? 'added by you' : tool.from === 'both' ? 'playbook + you' : 'from the playbook'}</span>
              {tool.outcome !== 'ok' && <span className="ax-toolrows__note">{tool.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {useCase.missing.length > 0 && <p className="ax-hint ax-hint--warn">Still missing, from the sheet: {useCase.missing.join('; ')}.</p>}
      <div className="ax-card__actions">
        <button type="button" className="ax-btn ax-btn--small" onClick={onEdit}>{yours.length ? `Edit tools (${yours.length} added)` : 'Edit tools'}</button>
      </div>
    </article>
  );
}

