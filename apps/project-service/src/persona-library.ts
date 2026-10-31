/**
 * The persona library of a project: the owner's catalogue of personas, use cases and access roles (built from the sheets by
 * `scripts/placemakers/import-personas.ts`), kept in the project database so the Customize page can read it, and the tools each scenario
 * needs, which people edit on that page.
 *
 * It is reference material for the people who configure the assistant. It is NOT part of the published pack: nothing here changes what the
 * assistant says or may do, so saving it needs no publication. Two things are stored apart so that one cannot undo the other:
 *   `library`        what the sheets said (replaced whole when a newer import is loaded);
 *   `scenarioTools`  what people say each scenario needs: use case id -> tool ids (kept when the library is replaced, minus any use case
 *                    the new library no longer has);
 *   `scenarioPrompts` the question a person types to try each scenario: use case id -> text (kept the same way).
 * A revision number guards every save: a person who saves on top of a change they have not seen is told so (conflict), never overwritten.
 */
import { z } from 'zod';
import * as crypto from 'crypto';

export const PERSONA_LIBRARY_SCHEMA_ID = 'placemakers-personas/1';
export const PERSONA_LIBRARY_COLLECTION = 'persona_libraries';

export const LIMITS = { personas: 300, useCases: 2000, teams: 60, roles: 80, systems: 300, toolsPerScenario: 40, promptLength: 400 } as const;

const text = (max: number) => z.string().max(max);
const many = <T extends z.ZodTypeAny>(max: number, item: T) => z.array(item).max(max);
const strings = (max: number) => many(max, text(120));
const Readiness = z.object({
  'fully ready': z.number().int().min(0), 'partly ready': z.number().int().min(0),
  'sample or pending only': z.number().int().min(0), 'not possible yet': z.number().int().min(0),
});
const ReadinessName = z.enum(['fully ready', 'partly ready', 'sample or pending only', 'not possible yet']);
const SystemState = z.enum(['ready', 'sample', 'pending', 'not-connected']);

const Persona = z.object({
  id: text(40).min(1), kind: z.enum(['customer', 'staff']), side: text(80), name: text(120).min(1), group: text(120), description: text(800), goal: text(500),
  channel: text(300), systems: strings(30), priority: text(8), roleBasis: text(300), source: text(500),
  team: text(64).optional(), teamLead: text(60).optional(),
  accessRoles: strings(10), signIn: z.enum(['guest', 'buyer', 'staff']).optional(), commercetoolsRoles: many(10, text(64)),
  useCases: many(20, text(40)), readiness: Readiness,
}).passthrough();

const UseCase = z.object({
  id: text(40).min(1), personaId: text(40).min(1), persona: text(120), title: text(200).min(1), story: text(1000), workflow: text(400), feature: text(300),
  priority: text(8), scope: text(300), systems: strings(20), readiness: ReadinessName, missing: many(20, text(200)), playbooks: many(10, text(80)), source: text(500),
}).passthrough();

const Team = z.object({
  team: text(64).min(1), name: text(120), status: z.enum(['live', 'planned']), agent: text(80).nullable(), note: text(400),
  personas: many(100, text(40)), useCases: z.number().int().min(0), readiness: Readiness, accessRoles: strings(20),
  waitingOn: many(40, z.object({ system: text(120), state: SystemState, useCases: z.number().int().min(0) }).passthrough()),
}).passthrough();

const Role = z.object({
  role: text(120).min(1), side: z.enum(['external', 'business']), scope: text(600), restriction: text(600), validation: text(300), source: text(500),
  signIn: z.enum(['guest', 'buyer']).optional(), commercetoolsRole: text(64).optional(), team: text(64).optional(), alsoTeams: many(10, text(64)).optional(),
  gap: text(400).optional(), note: text(400).optional(), personas: many(100, text(40)),
}).passthrough();

const System = z.object({ name: text(120).min(1), state: SystemState, note: text(400).optional(), personas: z.number().int().min(0), useCases: z.number().int().min(0) }).passthrough();

export const PersonaLibrarySchema = z.object({
  $schema: z.literal(PERSONA_LIBRARY_SCHEMA_ID),
  tenantId: text(64).min(1),
  source: z.object({ files: z.record(text(200), text(100)), note: text(600) }).passthrough(),
  counts: z.object({ personas: z.number().int(), customers: z.number().int(), staff: z.number().int(), useCases: z.number().int(), accessRoles: z.number().int(), teams: z.number().int(), readiness: Readiness }).passthrough(),
  systems: many(LIMITS.systems, System),
  teams: many(LIMITS.teams, Team),
  accessRoles: many(LIMITS.roles, Role),
  personas: many(LIMITS.personas, Persona),
  useCases: many(LIMITS.useCases, UseCase),
  ticketing: z.object({ ourDesk: text(120) }).passthrough(),
}).passthrough();

export type PersonaLibraryDocument = z.infer<typeof PersonaLibrarySchema>;

/** A tool a scenario needs: a built-in tool (`present_card`) or a tool of a connected system (`salesforce.list_cases`). */
export const ScenarioToolId = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'a tool id uses letters, digits and _ . -');

export interface PersonaLibraryRecord {
  projectId: string;
  revision: number;
  library: PersonaLibraryDocument;
  /** use case id -> tool ids, as people set them on the Customize page. */
  scenarioTools: Record<string, string[]>;
  /** use case id -> the question to type to try the scenario, as people set it on the Customize page. */
  scenarioPrompts: Record<string, string>;
  checksum: string;
  updatedAt: string;
  updatedBy: string;
}

export class PersonaLibraryError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'missing' | 'not_found', message: string) { super(message); this.name = 'PersonaLibraryError'; }
}

interface CollectionLike {
  findOne(filter: any): Promise<any>;
  insertOne(doc: any): Promise<any>;
  updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount?: number; modifiedCount?: number }>;
  createIndex?(spec: any, options?: any): Promise<any>;
}

const checksumOf = (library: unknown): string => crypto.createHash('sha256').update(JSON.stringify(library)).digest('hex');
const plain = <T,>(doc: T): T => JSON.parse(JSON.stringify(doc));

/** What is wrong with a library, in plain words (empty when it is fine). Also checks that it hangs together. */
export function checkPersonaLibrary(projectId: string, value: unknown): { ok: true; library: PersonaLibraryDocument } | { ok: false; errors: string[] } {
  const parsed = PersonaLibrarySchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'library'}: ${issue.message}`) };
  const library = parsed.data;
  const errors: string[] = [];
  if (library.tenantId.toLowerCase() !== projectId.toLowerCase()) errors.push(`The library is for "${library.tenantId}", not for "${projectId}".`);
  const personaIds = new Set(library.personas.map((persona) => persona.id));
  if (personaIds.size !== library.personas.length) errors.push('Two personas have the same id.');
  const useCaseIds = new Set(library.useCases.map((useCase) => useCase.id));
  if (useCaseIds.size !== library.useCases.length) errors.push('Two use cases have the same id.');
  for (const useCase of library.useCases) if (!personaIds.has(useCase.personaId)) { errors.push(`Use case ${useCase.id} belongs to ${useCase.personaId}, who is not in the library.`); break; }
  return errors.length ? { ok: false, errors } : { ok: true, library };
}

export class PersonaLibraryStore {
  private indexed = false;
  constructor(private readonly collection: CollectionLike, private readonly now: () => Date = () => new Date()) {}

  private async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    this.indexed = true;
    try { await this.collection.createIndex?.({ projectId: 1 }, { unique: true }); } catch { /* the index is a guard, not a requirement */ }
  }

  async get(projectId: string): Promise<PersonaLibraryRecord | null> {
    const doc = await this.collection.findOne({ projectId });
    if (!doc) return null;
    const { _id: _ignored, ...record } = doc;
    // A record saved before test questions existed has none.
    return plain({ scenarioPrompts: {}, ...record }) as PersonaLibraryRecord;
  }

  /** Stores a library (a newer import replaces it whole). The scenario tools people set are kept for every use case the new library still has. */
  async put(projectId: string, value: unknown, by: string, expectedRevision?: number): Promise<PersonaLibraryRecord> {
    const checked = checkPersonaLibrary(projectId, value);
    if (checked.ok === false) throw new PersonaLibraryError('invalid', checked.errors.join(' '));
    await this.ensureIndex();
    const existing = await this.get(projectId);
    if (existing && expectedRevision !== undefined && existing.revision !== expectedRevision) throw new PersonaLibraryError('conflict', 'The persona library was changed since you loaded it. Reload and try again.');
    const useCaseIds = new Set(checked.library.useCases.map((useCase) => useCase.id));
    const scenarioTools = Object.fromEntries(Object.entries(existing?.scenarioTools ?? {}).filter(([id]) => useCaseIds.has(id)));
    const scenarioPrompts = Object.fromEntries(Object.entries(existing?.scenarioPrompts ?? {}).filter(([id]) => useCaseIds.has(id)));
    const record: PersonaLibraryRecord = {
      projectId, revision: (existing?.revision ?? 0) + 1, library: checked.library, scenarioTools, scenarioPrompts,
      checksum: checksumOf(checked.library), updatedAt: this.now().toISOString(), updatedBy: by || 'unknown',
    };
    if (!existing) { await this.collection.insertOne(plain(record)); return record; }
    const done = await this.collection.updateOne({ projectId, revision: existing.revision }, { $set: plain(record) });
    if (!done.matchedCount) throw new PersonaLibraryError('conflict', 'The persona library was changed at the same moment. Reload and try again.');
    return record;
  }

  /** Sets the tools one scenario (use case) needs. An empty list removes the mapping. */
  async setScenarioTools(projectId: string, useCaseId: string, tools: unknown, by: string, expectedRevision: number): Promise<PersonaLibraryRecord> {
    const existing = await this.get(projectId);
    if (!existing) throw new PersonaLibraryError('missing', 'No persona library is loaded for this project.');
    if (existing.revision !== expectedRevision) throw new PersonaLibraryError('conflict', 'The persona library was changed since you loaded it. Reload and try again.');
    if (!existing.library.useCases.some((useCase) => useCase.id === useCaseId)) throw new PersonaLibraryError('not_found', `The library has no use case "${useCaseId}".`);
    const parsed = z.array(ScenarioToolId).max(LIMITS.toolsPerScenario).safeParse(tools);
    if (!parsed.success) throw new PersonaLibraryError('invalid', `The tools were not valid: ${parsed.error.issues[0]?.message ?? 'check the list'}.`);
    const unique = [...new Set(parsed.data)];
    const scenarioTools = { ...existing.scenarioTools };
    if (unique.length) scenarioTools[useCaseId] = unique; else delete scenarioTools[useCaseId];
    const record: PersonaLibraryRecord = { ...existing, revision: existing.revision + 1, scenarioTools, updatedAt: this.now().toISOString(), updatedBy: by || 'unknown' };
    const done = await this.collection.updateOne({ projectId, revision: existing.revision }, { $set: plain({ revision: record.revision, scenarioTools, updatedAt: record.updatedAt, updatedBy: record.updatedBy }) });
    if (!done.matchedCount) throw new PersonaLibraryError('conflict', 'The persona library was changed at the same moment. Reload and try again.');
    return record;
  }

  /** Sets the question a person types to try one scenario. Empty text removes it (the page then words one from the use case itself). */
  async setScenarioPrompt(projectId: string, useCaseId: string, prompt: unknown, by: string, expectedRevision: number): Promise<PersonaLibraryRecord> {
    const existing = await this.get(projectId);
    if (!existing) throw new PersonaLibraryError('missing', 'No persona library is loaded for this project.');
    if (existing.revision !== expectedRevision) throw new PersonaLibraryError('conflict', 'The persona library was changed since you loaded it. Reload and try again.');
    if (!existing.library.useCases.some((useCase) => useCase.id === useCaseId)) throw new PersonaLibraryError('not_found', `The library has no use case "${useCaseId}".`);
    const parsed = z.string().max(LIMITS.promptLength).safeParse(prompt);
    if (!parsed.success) throw new PersonaLibraryError('invalid', `The question was not valid: it must be text of at most ${LIMITS.promptLength} characters.`);
    const text = parsed.data.replace(/\s+/g, ' ').trim();
    const scenarioPrompts = { ...existing.scenarioPrompts };
    if (text) scenarioPrompts[useCaseId] = text; else delete scenarioPrompts[useCaseId];
    const record: PersonaLibraryRecord = { ...existing, revision: existing.revision + 1, scenarioPrompts, updatedAt: this.now().toISOString(), updatedBy: by || 'unknown' };
    const done = await this.collection.updateOne({ projectId, revision: existing.revision }, { $set: plain({ revision: record.revision, scenarioPrompts, updatedAt: record.updatedAt, updatedBy: record.updatedBy }) });
    if (!done.matchedCount) throw new PersonaLibraryError('conflict', 'The persona library was changed at the same moment. Reload and try again.');
    return record;
  }
}
