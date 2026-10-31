/**
 * The Personas tab, the way it reads: the persona library as the project database holds it, and the scenario-to-tools check.
 *
 * The check asks, for every use case (a scenario a persona wants done): which tools does it need, and can the people in that persona's
 * team use each one right now? The tools come from two places: the playbooks the use case names (a playbook's text names the connector
 * tools it calls, `salesforce.list_cases`), and the tools a person added for the scenario on this page. Each tool is then judged under the
 * pack's own rules for the persona's team (the same answers the chat will give): allowed, asks first, blocked, its system switched off, its
 * system not connected yet, or no such team in the project.
 *
 * Pure: no page, no network. It only reads the overview an editor is sent (skills with their text, the tool list with each team's state,
 * the connection checks) and the library.
 */
import type { CustomizeOverview, OverviewToolOption, SystemStatus } from './types';

export type ReadinessName = 'fully ready' | 'partly ready' | 'sample or pending only' | 'not possible yet';
export const READINESS_ORDER: readonly ReadinessName[] = ['fully ready', 'partly ready', 'sample or pending only', 'not possible yet'];

export interface LibPersona {
  id: string;
  kind: 'customer' | 'staff';
  side: string;
  name: string;
  group: string;
  description: string;
  goal: string;
  channel: string;
  systems: string[];
  priority: string;
  accessRoles: string[];
  signIn?: string;
  team?: string;
  /** The demo sign-in (an e-mail) to try this persona with; absent when none is needed or none exists yet. */
  demoLogin?: string;
  useCases: string[];
  readiness: Record<ReadinessName, number>;
}

/** One case of the project's test set: who signs in, what to type, what the doors should be and what should and should not be said. */
export interface LibTestCase {
  id: string;
  login: string;
  loginEmail: string;
  useCase: string | null;
  playbook: string | null;
  prompt: string;
  allow: string[];
  ask: string[];
  blocked: string[];
  shouldSay: string[];
  shouldNot: string[];
  note?: string;
}

export interface LibUseCase {
  id: string;
  personaId: string;
  persona: string;
  title: string;
  story: string;
  workflow: string;
  feature: string;
  priority: string;
  systems: string[];
  readiness: ReadinessName;
  missing: string[];
  playbooks: string[];
}

export interface LibTeam {
  team: string;
  name: string;
  status: 'live' | 'planned';
  agent: string | null;
  note: string;
  personas: string[];
  useCases: number;
  readiness: Record<ReadinessName, number>;
  waitingOn: Array<{ system: string; state: string; useCases: number }>;
}

export interface PersonaLibraryView {
  present: true;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  library: { personas: LibPersona[]; useCases: LibUseCase[]; teams: LibTeam[]; testCases: LibTestCase[]; counts?: Record<string, unknown> };
  /** use case id -> the tool ids a person said it needs. */
  scenarioTools: Record<string, string[]>;
  /** use case id -> the question a person set for trying the scenario. */
  scenarioPrompts: Record<string, string>;
}
export type PersonaLibraryAnswer = PersonaLibraryView | { present: false };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((v): v is string => typeof v === 'string');
const readiness = (value: unknown): Record<ReadinessName, number> => {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(READINESS_ORDER.map((name) => [name, typeof source[name] === 'number' ? (source[name] as number) : 0])) as Record<ReadinessName, number>;
};

/** What the project service answered, kept only if it is the shape the page reads (anything else is null, never half-shown). */
export function parsePersonaLibraryAnswer(json: unknown): PersonaLibraryAnswer | null {
  if (!isRecord(json)) return null;
  if (json.present === false) return { present: false };
  if (json.present !== true || typeof json.revision !== 'number' || !isRecord(json.library)) return null;
  const library = json.library;
  if (!Array.isArray(library.personas) || !Array.isArray(library.useCases) || !Array.isArray(library.teams)) return null;
  const personas = list(library.personas).filter(isRecord).filter((p) => text(p.id) && text(p.name)).map((p): LibPersona => ({
    id: text(p.id), kind: p.kind === 'customer' ? 'customer' : 'staff', side: text(p.side), name: text(p.name), group: text(p.group), description: text(p.description),
    goal: text(p.goal), channel: text(p.channel), systems: strings(p.systems), priority: text(p.priority), accessRoles: strings(p.accessRoles),
    ...(text(p.signIn) ? { signIn: text(p.signIn) } : {}), ...(text(p.team) ? { team: text(p.team) } : {}), ...(text(p.demoLogin) ? { demoLogin: text(p.demoLogin) } : {}),
    useCases: strings(p.useCases), readiness: readiness(p.readiness),
  }));
  const useCases = list(library.useCases).filter(isRecord).filter((u) => text(u.id) && text(u.personaId)).map((u): LibUseCase => ({
    id: text(u.id), personaId: text(u.personaId), persona: text(u.persona), title: text(u.title), story: text(u.story), workflow: text(u.workflow), feature: text(u.feature),
    priority: text(u.priority), systems: strings(u.systems),
    readiness: READINESS_ORDER.includes(u.readiness as ReadinessName) ? (u.readiness as ReadinessName) : 'partly ready',
    missing: strings(u.missing), playbooks: strings(u.playbooks),
  }));
  const teams = list(library.teams).filter(isRecord).filter((t) => text(t.team)).map((t): LibTeam => ({
    team: text(t.team), name: text(t.name) || text(t.team), status: t.status === 'live' ? 'live' : 'planned', agent: text(t.agent) || null, note: text(t.note),
    personas: strings(t.personas), useCases: typeof t.useCases === 'number' ? t.useCases : 0, readiness: readiness(t.readiness),
    waitingOn: list(t.waitingOn).filter(isRecord).map((w) => ({ system: text(w.system), state: text(w.state), useCases: typeof w.useCases === 'number' ? w.useCases : 0 })),
  }));
  const testCases = list(library.testCases).filter(isRecord).filter((c) => text(c.id) && text(c.prompt)).map((c): LibTestCase => ({
    id: text(c.id), login: text(c.login), loginEmail: text(c.loginEmail), useCase: text(c.useCase) || null, playbook: text(c.playbook) || null, prompt: text(c.prompt),
    allow: strings(c.allow), ask: strings(c.ask), blocked: strings(c.blocked), shouldSay: strings(c.shouldSay), shouldNot: strings(c.shouldNot), ...(text(c.note) ? { note: text(c.note) } : {}),
  }));
  const scenarioTools: Record<string, string[]> = {};
  if (isRecord(json.scenarioTools)) for (const [id, tools] of Object.entries(json.scenarioTools)) if (Array.isArray(tools)) scenarioTools[id] = strings(tools);
  const scenarioPrompts: Record<string, string> = {};
  if (isRecord(json.scenarioPrompts)) for (const [id, value] of Object.entries(json.scenarioPrompts)) if (typeof value === 'string' && value.trim()) scenarioPrompts[id] = value;
  return {
    present: true, revision: json.revision, updatedAt: text(json.updatedAt), updatedBy: text(json.updatedBy),
    library: { personas, useCases, teams, testCases, ...(isRecord(library.counts) ? { counts: library.counts } : {}) }, scenarioTools, scenarioPrompts,
  };
}

/* ── the check ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type Outcome = 'ok' | 'ask' | 'blocked' | 'off' | 'not-connected' | 'no-team' | 'unknown';
export type Verdict = 'ready' | 'gaps' | 'unmapped' | 'unchecked';
export const VERDICTS: readonly Verdict[] = ['ready', 'gaps', 'unmapped', 'unchecked'];

export interface ToolCheck {
  id: string;
  label: string;
  system: string;
  changesData: boolean;
  from: 'playbook' | 'you' | 'both';
  outcome: Outcome;
  note: string;
}

export interface UseCaseCheck {
  useCaseId: string;
  /** The team whose rules were applied, or `shopper` for a customer. */
  audience: string;
  audienceName: string;
  tools: ToolCheck[];
  playbooks: Array<{ id: string; name: string; found: boolean }>;
  /** Plain sentences about what stops the scenario (a blocked tool, a playbook the pack does not have...). */
  issues: string[];
  verdict: Verdict;
  summary: string;
  /** The sheet calls it fully ready but the tools show a gap. */
  disagrees: boolean;
}

export type Counts = Record<Verdict, number>;
export interface PersonaChecks {
  byUseCase: Record<string, UseCaseCheck>;
  byPersona: Record<string, Counts>;
  byTeam: Record<string, Counts>;
  /** Customers and partners together (they belong to no team). */
  customers: Counts;
  totals: Counts;
}

type OverviewForCheck = Pick<CustomizeOverview, 'skills' | 'toolOptions' | 'teams' | 'connectorRules'>;

const emptyCounts = (): Counts => ({ ready: 0, gaps: 0, unmapped: 0, unchecked: 0 });
const BAD: ReadonlySet<Outcome> = new Set(['blocked', 'off', 'not-connected', 'no-team', 'unknown']);

/** The tool ids (`system.tool`) a piece of text names, found as whole ids. */
export function toolIdsNamedIn(body: string, known: Iterable<string>): string[] {
  const found: string[] = [];
  for (const id of known) {
    let at = body.indexOf(id);
    while (at >= 0) {
      const before = at === 0 ? '' : body[at - 1];
      const after = body[at + id.length] ?? '';
      if (!/[A-Za-z0-9_.-]/.test(before) && !/[A-Za-z0-9_]/.test(after)) { found.push(id); break; }
      at = body.indexOf(id, at + 1);
    }
  }
  return found;
}

const STATE_NOTE: Record<'ok' | 'ask' | 'blocked', string> = { ok: 'Allowed', ask: 'Asks first', blocked: 'Blocked' };

export interface JudgeContext {
  options: Map<string, OverviewToolOption>;
  statusOf: (systemId: string) => SystemStatus | undefined;
}

export function judgeContext(overview: Pick<CustomizeOverview, 'toolOptions' | 'connectorRules'>): JudgeContext {
  return {
    options: new Map(overview.toolOptions.map((option) => [option.id, option])),
    statusOf: (systemId) => overview.connectorRules.find((rule) => rule.connectorId === systemId)?.status,
  };
}

/** One tool under the rules of one audience (a team id, or `shopper`): can they use it right now, and if not, why. */
export function judgeTool(context: JudgeContext, id: string, from: ToolCheck['from'], audience: string, audienceName: string): ToolCheck {
  const option = context.options.get(id);
  if (!option) return { id, label: id, system: id.includes('.') ? id.slice(0, id.indexOf('.')) : 'Built-in tools', changesData: false, from, outcome: 'unknown', note: 'The assistant does not have this tool.' };
  const base = { id, label: option.label, system: option.system, changesData: option.sideEffect === 'write', from };
  if (!option.enabled) return { ...base, outcome: 'off', note: `${option.system} is switched off.` };
  if (option.systemId !== 'platform') {
    const status = context.statusOf(option.systemId);
    if (status && !status.connected) return { ...base, outcome: 'not-connected', note: `${option.system} is not connected yet${status.missing.length ? ` (needs ${status.missing.join(', ')})` : ''}.` };
  }
  if (!option.states) return { ...base, outcome: 'ok', note: 'Built into the platform.' };
  const state = option.states[audience];
  if (state === undefined) return { ...base, outcome: 'no-team', note: audience === 'unassigned' ? 'This persona has no team yet.' : `This project has no team called “${audienceName}”, so no rule can allow it.` };
  return { ...base, outcome: state === 'allow' ? 'ok' : state, note: `${STATE_NOTE[state === 'allow' ? 'ok' : state]} for ${audienceName}.` };
}

export function checkScenarios(view: PersonaLibraryView, overview: OverviewForCheck): PersonaChecks {
  const judge = judgeContext(overview);
  const options = judge.options;
  const connectorIds = [...options.values()].filter((option) => option.systemId !== 'platform').map((option) => option.id);
  const skills = new Map(overview.skills.map((skill) => [skill.skillId, skill]));
  const teamNames = new Map<string, string>([...view.library.teams.map((t): [string, string] => [t.team, t.name]), ...overview.teams.map((t): [string, string] => [t.id, t.name])]);
  const personas = new Map(view.library.personas.map((p) => [p.id, p]));

  const byUseCase: Record<string, UseCaseCheck> = {};
  const byPersona: Record<string, Counts> = {};
  const byTeam: Record<string, Counts> = {};
  const customers = emptyCounts();
  const totals = emptyCounts();

  for (const useCase of view.library.useCases) {
    const persona = personas.get(useCase.personaId);
    const audience = !persona || persona.kind === 'customer' ? 'shopper' : persona.team || 'unassigned';
    const audienceName = audience === 'shopper' ? 'shoppers' : teamNames.get(audience) ?? audience;
    const issues: string[] = [];
    const from = new Map<string, 'playbook' | 'you'>();
    const playbooks = useCase.playbooks.map((id) => {
      const skill = skills.get(id);
      if (!skill) { issues.push(`The playbook “${id}” is not in the assistant, so it cannot be used.`); return { id, name: id, found: false }; }
      const named = new Set([...toolIdsNamedIn(skill.instructions ?? '', connectorIds), ...skill.tools.filter((tool) => options.has(tool) && tool.includes('.'))]);
      for (const tool of named) from.set(tool, 'playbook');
      return { id, name: skill.name, found: true };
    });
    const yours = view.scenarioTools[useCase.id] ?? [];
    const both = new Set<string>();
    for (const tool of yours) { if (from.get(tool) === 'playbook') both.add(tool); else from.set(tool, 'you'); }

    const tools: ToolCheck[] = [...from.entries()].map(([id, origin]) => judgeTool(judge, id, both.has(id) ? 'both' : origin, audience, audienceName));

    for (const tool of tools) if (BAD.has(tool.outcome)) issues.push(`${tool.label}: ${tool.note}`);

    const unmapped = tools.length === 0;
    const verdict: Verdict = issues.length > 0 ? 'gaps' : unmapped ? (audience === 'shopper' ? 'unchecked' : 'unmapped') : 'ready';
    const asks = tools.filter((tool) => tool.outcome === 'ask').length;
    const summary = verdict === 'gaps' ? `${issues.length} thing${issues.length === 1 ? '' : 's'} in the way`
      : verdict === 'ready' ? `Every tool works for ${audienceName}${asks ? ` (${asks} asks first)` : ''}`
      : verdict === 'unchecked' ? 'Uses the shop’s own tools. Name the tools to check it.'
      : 'No tools named yet';
    byUseCase[useCase.id] = {
      useCaseId: useCase.id, audience, audienceName, tools, playbooks, issues, verdict, summary,
      disagrees: useCase.readiness === 'fully ready' && verdict === 'gaps',
    };

    const personaCounts = (byPersona[useCase.personaId] ??= emptyCounts());
    personaCounts[verdict] += 1;
    totals[verdict] += 1;
    if (audience === 'shopper') customers[verdict] += 1;
    else (byTeam[audience] ??= emptyCounts())[verdict] += 1;
  }
  return { byUseCase, byPersona, byTeam, customers, totals };
}

/** The words for a tool's outcome on the page. */
export const OUTCOME_WORDS: Record<Outcome, string> = {
  ok: 'Works', ask: 'Asks first', blocked: 'Blocked', off: 'System off', 'not-connected': 'Not connected', 'no-team': 'No such team', unknown: 'Not a tool here',
};
export const VERDICT_WORDS: Record<Verdict, string> = { ready: 'Tools work', gaps: 'Gaps', unmapped: 'No tools named', unchecked: 'Not checked' };
