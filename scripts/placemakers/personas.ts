/**
 * The PlaceMakers persona library: the owner's three sheets (personas, use cases, access model) read into one file the rest of the
 * project can lean on, with the decisions that connect them to the pack kept in `mapping.json` where they can be read and changed.
 *
 * Pure and deterministic (no clock, no randomness, no files): the same sheets and mapping always give the same library byte for byte,
 * so running the import twice changes nothing and `--check` can tell whether the committed library is out of date.
 *
 * What it works out:
 *   - for every system a sheet names, whether it is ready (real data), sample (pretend data), pending (an account is awaited) or not connected;
 *   - for every use case, whether we can do it today, from the states of the systems it needs;
 *   - for every persona, the team it belongs to (staff) or the sign-in role and commercetools associate role it uses (customers);
 *   - for every team, what it is still waiting on.
 */
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

export type SystemState = 'ready' | 'sample' | 'pending' | 'not-connected';
export type Readiness = 'fully ready' | 'partly ready' | 'sample or pending only' | 'not possible yet';
export const READINESS_ORDER: Readiness[] = ['fully ready', 'partly ready', 'sample or pending only', 'not possible yet'];
const STATE_WORDS: Record<Exclude<SystemState, 'ready'>, string> = { sample: 'sample data only', pending: 'account pending', 'not-connected': 'not connected' };

export interface TeamMapping { team: string; name: string; status: 'live' | 'planned'; agent: string | null; note: string }
export interface RoleMapping { signIn?: 'guest' | 'buyer'; commercetoolsRole?: string; gap?: string; team?: string; alsoTeams?: string[]; note?: string }
export interface Mapping {
  systemStates: { ready: string[]; sample: string[]; pending: string[] };
  systemNotes: Record<string, string>;
  teams: TeamMapping[];
  personaTeams: Record<string, string>;
  teamLeads: Record<string, string>;
  personaRoles: Record<string, string[]>;
  roles: Record<string, RoleMapping>;
  playbooks: Record<string, string[]>;
}

export interface Sheets { personas: string; useCases: string; accessModel: string; ticketing: string }
export type SheetNames = Record<keyof Sheets, string>;

export interface LibrarySystem { name: string; state: SystemState; note?: string; personas: number; useCases: number }
export interface LibraryUseCase {
  id: string; personaId: string; persona: string; title: string; story: string; workflow: string; feature: string; priority: string; scope: string;
  systems: string[]; readiness: Readiness; missing: string[]; playbooks: string[]; source: string;
}
export interface LibraryPersona {
  id: string; kind: 'customer' | 'staff'; side: string; name: string; group: string; description: string; goal: string; channel: string; systems: string[];
  priority: string; roleBasis: string; source: string;
  /** Staff: the team in the pack (or planned). */
  team?: string; teamLead?: string;
  /** Customers: the access roles they sign in with (named in the access model), how they sign in, and the commercetools associate roles. */
  accessRoles: string[]; signIn?: 'guest' | 'buyer' | 'staff'; commercetoolsRoles: string[];
  useCases: string[]; readiness: Record<Readiness, number>;
  /** The demo sign-in to try this persona with (an e-mail); none when the persona needs no sign-in or has no login yet. Added by `attachScenarioHelp`. */
  demoLogin?: string;
}
export interface LibraryRole {
  role: string; side: 'external' | 'business'; scope: string; restriction: string; validation: string; source: string;
  signIn?: 'guest' | 'buyer'; commercetoolsRole?: string; team?: string; alsoTeams?: string[]; gap?: string; note?: string; personas: string[];
}
export interface LibraryTeam extends TeamMapping {
  personas: string[]; useCases: number; readiness: Record<Readiness, number>; accessRoles: string[];
  /** The systems this team's use cases need that are not ready, most needed first. */
  waitingOn: Array<{ system: string; state: SystemState; useCases: number }>;
}
export interface PersonaLibrary {
  $schema: string;
  tenantId: 'placemakers';
  source: { files: Record<string, string>; note: string };
  counts: { personas: number; customers: number; staff: number; useCases: number; accessRoles: number; teams: number; readiness: Record<Readiness, number>; priorityP0: { personas: number; useCases: number } };
  systems: LibrarySystem[];
  teams: LibraryTeam[];
  accessRoles: LibraryRole[];
  personas: LibraryPersona[];
  useCases: LibraryUseCase[];
  ticketing: { ourDesk: string; tools: Array<{ tool: string; workType: string; users: string; status: string; details: string; evidence: string }> };
  /** The small test set (who signs in, what to type, what should happen), carried with the library so the Customize page can show it. */
  testCases?: Array<TestCase & { loginEmail: string }>;
}

const rows = (text: string): Array<Record<string, string>> => parse(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: false });
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const splitSystems = (text: string): string[] => text.split(';').map((part) => part.trim()).filter(Boolean);
const count = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

/** One system's state; anything the mapping does not name is not connected. */
export function stateOf(system: string, mapping: Mapping): SystemState {
  const name = system.trim().toLowerCase();
  const has = (list: string[]) => list.some((entry) => entry.toLowerCase() === name);
  if (has(mapping.systemStates.ready)) return 'ready';
  if (has(mapping.systemStates.sample)) return 'sample';
  if (has(mapping.systemStates.pending)) return 'pending';
  return 'not-connected';
}

/** Can we do a use case today, from the systems it needs: all ready is fully ready; some ready is partly ready; none ready is sample-or-pending, or not possible when nothing at all is there. */
export function readinessOf(systems: string[], mapping: Mapping): { readiness: Readiness; missing: string[] } {
  const states = systems.map((system) => ({ system, state: stateOf(system, mapping) }));
  const missing = states.filter((entry) => entry.state !== 'ready').map((entry) => `${entry.system} (${STATE_WORDS[entry.state as Exclude<SystemState, 'ready'>]})`);
  if (missing.length === 0) return { readiness: 'fully ready', missing };
  if (states.some((entry) => entry.state === 'ready')) return { readiness: 'partly ready', missing };
  if (states.every((entry) => entry.state === 'not-connected')) return { readiness: 'not possible yet', missing };
  return { readiness: 'sample or pending only', missing };
}

const zero = () => count(READINESS_ORDER);
const kindOf = (id: string): 'customer' | 'staff' => (id.startsWith('C') ? 'customer' : 'staff');

export function buildLibrary(sheets: Sheets, names: SheetNames, mapping: Mapping): PersonaLibrary {
  const personaRows = rows(sheets.personas);
  const useCaseRows = rows(sheets.useCases);
  const accessRows = rows(sheets.accessModel);
  const ticketRows = rows(sheets.ticketing);

  // The systems, with how many personas and use cases need each.
  const systemUse = new Map<string, { personas: Set<string>; useCases: Set<string> }>();
  const touch = (system: string, kind: 'personas' | 'useCases', id: string) => {
    const entry = systemUse.get(system) ?? { personas: new Set<string>(), useCases: new Set<string>() };
    entry[kind].add(id);
    systemUse.set(system, entry);
  };
  for (const row of personaRows) for (const system of splitSystems(row.systems)) touch(system, 'personas', row.id);
  for (const row of useCaseRows) for (const system of splitSystems(row.systems)) touch(system, 'useCases', row.id);
  const systems: LibrarySystem[] = [...systemUse.entries()]
    .map(([name, use]) => ({ name, state: stateOf(name, mapping), ...(mapping.systemNotes[name] ? { note: mapping.systemNotes[name] } : {}), personas: use.personas.size, useCases: use.useCases.size }))
    .sort((a, b) => b.useCases - a.useCases || a.name.localeCompare(b.name));

  // Use cases.
  const playbooksFor = (id: string) => Object.entries(mapping.playbooks).filter(([, ids]) => ids.includes(id)).map(([playbook]) => playbook).sort();
  const useCases: LibraryUseCase[] = useCaseRows.map((row) => {
    const list = splitSystems(row.systems);
    const { readiness, missing } = readinessOf(list, mapping);
    return {
      id: row.id, personaId: row.persona_id, persona: row.persona, title: row.title, story: row.story, workflow: row.workflow, feature: row.feature, priority: row.priority,
      scope: row.scope, systems: list, readiness, missing, playbooks: playbooksFor(row.id), source: row.source,
    };
  });
  const useCasesOf = (personaId: string) => useCases.filter((useCase) => useCase.personaId === personaId);

  // Access roles.
  const personasOfRole = (role: string) => Object.entries(mapping.personaRoles).filter(([, roles]) => roles.includes(role)).map(([id]) => id).sort();
  const accessRoles: LibraryRole[] = accessRows.map((row) => {
    const role = row['Access role (proposed)'];
    const decided = mapping.roles[role] ?? {};
    return {
      role, side: row['Actor side'].toLowerCase() === 'external' ? 'external' : 'business', scope: row['Suggested allowed scope'], restriction: row['Key restriction'],
      validation: row['Validation status'], source: row['Source URL'],
      ...(decided.signIn ? { signIn: decided.signIn } : {}), ...(decided.commercetoolsRole ? { commercetoolsRole: decided.commercetoolsRole } : {}),
      ...(decided.team ? { team: decided.team } : {}), ...(decided.alsoTeams ? { alsoTeams: decided.alsoTeams } : {}),
      ...(decided.gap ? { gap: decided.gap } : {}), ...(decided.note ? { note: decided.note } : {}), personas: personasOfRole(role),
    };
  });

  // Personas.
  const roleByName = new Map(accessRoles.map((role) => [role.role, role]));
  const personas: LibraryPersona[] = personaRows.map((row) => {
    const kind = kindOf(row.id);
    const roleNames = mapping.personaRoles[row.id] ?? [];
    const roles = roleNames.map((name) => roleByName.get(name)).filter((role): role is LibraryRole => Boolean(role));
    const mine = useCasesOf(row.id);
    const readiness = zero();
    for (const useCase of mine) readiness[useCase.readiness] += 1;
    const signIn: LibraryPersona['signIn'] = kind === 'staff' ? 'staff' : roles.length === 0 ? undefined : roles.some((role) => role.signIn === 'buyer') ? 'buyer' : 'guest';
    return {
      id: row.id, kind, side: row.side, name: row.name, group: row.group, description: row.description, goal: row.goal, channel: row.channel, systems: splitSystems(row.systems),
      priority: row.priority, roleBasis: row.role_basis, source: row.source,
      ...(kind === 'staff' && mapping.personaTeams[row.id] ? { team: mapping.personaTeams[row.id] } : {}),
      ...(mapping.teamLeads[row.id] ? { teamLead: mapping.teamLeads[row.id] } : {}),
      accessRoles: roleNames, ...(signIn ? { signIn } : {}),
      commercetoolsRoles: [...new Set(roles.map((role) => role.commercetoolsRole).filter((role): role is string => Boolean(role)))],
      useCases: mine.map((useCase) => useCase.id), readiness,
    };
  });

  // Teams.
  const teams: LibraryTeam[] = mapping.teams.map((team) => {
    const members = personas.filter((persona) => persona.team === team.team);
    const mine = members.flatMap((persona) => useCasesOf(persona.id));
    const readiness = zero();
    for (const useCase of mine) readiness[useCase.readiness] += 1;
    const waiting = new Map<string, { state: SystemState; ids: Set<string> }>();
    for (const useCase of mine) {
      for (const system of useCase.systems) {
        const state = stateOf(system, mapping);
        if (state === 'ready') continue;
        const entry = waiting.get(system) ?? { state, ids: new Set<string>() };
        entry.ids.add(useCase.id);
        waiting.set(system, entry);
      }
    }
    return {
      ...team, personas: members.map((persona) => persona.id), useCases: mine.length, readiness,
      accessRoles: [...new Set(members.flatMap((persona) => persona.accessRoles))].sort(),
      waitingOn: [...waiting.entries()].map(([system, entry]) => ({ system, state: entry.state, useCases: entry.ids.size })).sort((a, b) => b.useCases - a.useCases || a.system.localeCompare(b.system)),
    };
  });

  const readiness = zero();
  for (const useCase of useCases) readiness[useCase.readiness] += 1;
  return {
    $schema: 'placemakers-personas/1',
    tenantId: 'placemakers',
    source: {
      files: Object.fromEntries((Object.keys(sheets) as Array<keyof Sheets>).map((key) => [names[key], sha(sheets[key])]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
      note: 'Built from the owner\'s catalogue sheets (October 2026) and mapping.json. The sheets say these are proposed personas and roles, not an export of real PlaceMakers logins.',
    },
    counts: {
      personas: personas.length, customers: personas.filter((persona) => persona.kind === 'customer').length, staff: personas.filter((persona) => persona.kind === 'staff').length,
      useCases: useCases.length, accessRoles: accessRoles.length, teams: teams.length, readiness,
      priorityP0: { personas: personas.filter((persona) => persona.priority === 'P0').length, useCases: useCases.filter((useCase) => useCase.priority === 'P0').length },
    },
    systems, teams, accessRoles, personas, useCases,
    ticketing: {
      ourDesk: 'Salesforce Service Cloud',
      tools: ticketRows.map((row) => ({ tool: row.Tool, workType: row['Ticket / work type'], users: row['Likely users'], status: row['Confidence / status'], details: row.Details, evidence: row['Evidence URL'] })),
    },
  };
}

/** Everything that should hold for a library to be trusted: the sheets and the mapping agree with each other. Returns the problems found (empty is good). */
export function checkLibrary(library: PersonaLibrary, mapping: Mapping): string[] {
  const problems: string[] = [];
  const personaIds = new Set(library.personas.map((persona) => persona.id));
  const useCaseIds = new Set(library.useCases.map((useCase) => useCase.id));
  const roleNames = new Set(library.accessRoles.map((role) => role.role));
  const teamIds = new Set(library.teams.map((team) => team.team));
  if (personaIds.size !== library.personas.length) problems.push('a persona id appears twice');
  if (useCaseIds.size !== library.useCases.length) problems.push('a use case id appears twice');
  for (const persona of library.personas) {
    if (persona.kind === 'staff' && !persona.team) problems.push(`staff persona ${persona.id} has no team in mapping.personaTeams`);
    if (persona.kind === 'customer' && persona.team) problems.push(`customer persona ${persona.id} was given a team`);
    if (persona.useCases.length === 0) problems.push(`persona ${persona.id} has no use cases`);
    if (persona.team && !teamIds.has(persona.team)) problems.push(`persona ${persona.id} names the team "${persona.team}", which mapping.teams does not define`);
    for (const role of persona.accessRoles) if (!roleNames.has(role)) problems.push(`persona ${persona.id} names the access role "${role}", which the access model does not define`);
  }
  for (const useCase of library.useCases) if (!personaIds.has(useCase.personaId)) problems.push(`use case ${useCase.id} belongs to ${useCase.personaId}, who is not in the persona sheet`);
  for (const id of Object.keys(mapping.personaTeams)) if (!personaIds.has(id)) problems.push(`mapping.personaTeams names ${id}, who is not in the persona sheet`);
  for (const id of Object.keys(mapping.personaRoles)) if (!personaIds.has(id)) problems.push(`mapping.personaRoles names ${id}, who is not in the persona sheet`);
  for (const role of Object.keys(mapping.roles)) if (!roleNames.has(role)) problems.push(`mapping.roles names "${role}", which the access model does not define`);
  for (const role of library.accessRoles) {
    if (role.side === 'business' && !role.team) problems.push(`business role "${role.role}" has no team in mapping.roles`);
    if (role.side === 'external' && !role.signIn) problems.push(`external role "${role.role}" has no sign-in kind in mapping.roles`);
    for (const team of [role.team, ...(role.alsoTeams ?? [])]) if (team && !teamIds.has(team)) problems.push(`role "${role.role}" names the team "${team}", which mapping.teams does not define`);
  }
  for (const [playbook, ids] of Object.entries(mapping.playbooks)) for (const id of ids) if (!useCaseIds.has(id)) problems.push(`playbook ${playbook} serves ${id}, which is not a use case`);
  const total = Object.values(library.counts.readiness).reduce((sum, n) => sum + n, 0);
  if (total !== library.useCases.length) problems.push('the readiness counts do not add up to the use cases');
  return problems;
}

/** The table the owner reads: one row per use case with what is ready today and what is missing. */
export function coverageCsv(library: PersonaLibrary): string {
  const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = ['use case', 'persona id', 'persona', 'side', 'title', 'priority', 'can we do it today?', 'what is missing', 'team or customer role', 'playbook', 'evidence'];
  const lines = [header.join(',')];
  const personas = new Map(library.personas.map((persona) => [persona.id, persona]));
  for (const useCase of library.useCases) {
    const persona = personas.get(useCase.personaId)!;
    const who = persona.kind === 'staff' ? `${persona.team ?? ''}${persona.teamLead ? ` (${persona.teamLead})` : ''}` : persona.accessRoles.join(' + ') || 'no role in the sheet yet';
    lines.push([useCase.id, persona.id, persona.name, persona.side, useCase.title, useCase.priority, useCase.readiness, useCase.missing.join('; '), who, useCase.playbooks.join('; '), useCase.scope].map(quote).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export const stableJson = (library: PersonaLibrary): string => `${JSON.stringify(library, null, 2)}\n`;

export interface TestCase {
  id: string; login: string; useCase: string | null; playbook: string | null; prompt: string; opensOn: string;
  allow: string[]; ask: string[]; blocked: string[]; shouldSay: string[]; shouldNot: string[]; note?: string;
}
export interface LoginInfo { key: string; email: string; fullName: string }

export interface DemoLoginInfo { email: string; persona?: string; teams: string[] }

const teamId = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Adds what the Customize page needs to show a test scenario for every persona: the demo login to try each persona with, and the test set.
 * A persona with its own login uses it; a member of staff otherwise uses the login of their team; a customer who signs in uses the retail
 * shopper's login (retail) or the delegated buyer's (trade); a customer who needs no sign-in has none. Pure.
 */
export function attachScenarioHelp(library: PersonaLibrary, logins: DemoLoginInfo[], cases: TestCase[]): PersonaLibrary {
  const loginFor = (persona: LibraryPersona): string | undefined => {
    const own = logins.find((login) => login.persona === persona.id);
    if (own) return own.email;
    if (persona.kind === 'staff') return persona.team ? logins.find((login) => login.teams.some((team) => teamId(team) === persona.team))?.email : undefined;
    if (persona.signIn !== 'buyer') return undefined;
    return logins.find((login) => login.email.startsWith(/^retail/i.test(persona.group) ? 'shopper@' : 'trade.buyer@'))?.email;
  };
  return {
    ...library,
    personas: library.personas.map((persona) => { const demoLogin = loginFor(persona); return demoLogin ? { ...persona, demoLogin } : persona; }),
    ...(cases.length ? { testCases: cases.map((entry) => ({ ...entry, loginEmail: logins.find((login) => login.email.split('@')[0] === entry.login)?.email ?? '' })) } : {}),
  };
}

/** The test set as a page the owner can read and use: for each case, who to sign in as, what to type, and what should and should not happen. */
export function casesMarkdown(library: PersonaLibrary, cases: TestCase[], logins: LoginInfo[], agentNames: Record<string, string>): string {
  const byLogin = new Map(logins.map((login) => [login.key, login]));
  const useCases = new Map(library.useCases.map((useCase) => [useCase.id, useCase]));
  const list = (items: string[]) => items.map((item) => `\`${item}\``).join(', ');
  const lines: string[] = [
    '# PlaceMakers test set: who to sign in as, what to type, what should happen',
    '',
    `${cases.length} cases. Sign in as the login named in each case (the demo logins and passwords are in \`scripts/placemakers/demo-staff.ts\`), type the question, and read the answer against the lists below.`,
    'The "doors" (what is allowed, asked first or blocked for that person) are checked by `apps/project-service/test/personas-cases.spec.ts` with no model call. What the assistant says is for reading by eye: **no case has been run against a model yet.**',
    '',
  ];
  for (const c of cases) {
    const login = byLogin.get(c.login);
    const useCase = c.useCase ? useCases.get(c.useCase) : undefined;
    lines.push(`## ${c.id}${useCase ? ` · ${useCase.title} (${useCase.id}, ${useCase.readiness})` : ''}`);
    lines.push(`- **Sign in as:** ${login ? `${login.email} (${login.fullName})` : c.login}; opens on ${agentNames[c.opensOn] ?? c.opensOn}`);
    lines.push(`- **Type:** ${c.prompt}`);
    if (c.playbook) lines.push(`- **Playbook it should open:** \`${c.playbook}\``);
    if (c.allow.length) lines.push(`- **Allowed:** ${list(c.allow)}`);
    if (c.ask.length) lines.push(`- **Asks first (Yes/No card):** ${list(c.ask)}`);
    if (c.blocked.length) lines.push(`- **Blocked:** ${list(c.blocked)}`);
    if (useCase && useCase.missing.length) lines.push(`- **Not in the systems yet:** ${useCase.missing.join('; ')}`);
    if (c.shouldSay.length) lines.push(`- **Should say:** ${c.shouldSay.join('; ')}`);
    if (c.shouldNot.length) lines.push(`- **Should not:** ${c.shouldNot.join('; ')}`);
    if (c.note) lines.push(`- **Note:** ${c.note}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}
