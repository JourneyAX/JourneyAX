/**
 * Agent drafts made on the Customize page.
 *
 * A draft is NOT part of the live pack and never reaches the runtime. It lives in this browser, per tenant, until someone
 * publishes an agent from the back office; "Copy JSON" hands over a definition shaped like a pack agent for that purpose.
 * No project-service endpoint stores agent drafts without touching the project's configuration document (the one the back
 * office edits and publishes), so a safe server-side draft store does not exist yet; this file is the only place drafts are kept.
 */
import { readStoredJson, writeStoredJson } from '../shell/storage';

export interface AgentDraft {
  draftId: string;
  name: string;
  purpose: string;
  instructions: string;
  skills: string[];
  tools: string[];
  knowledgeNote: string;
  createdAt: number;
  updatedAt: number;
}

export type AgentDraftInput = Pick<AgentDraft, 'name' | 'purpose' | 'instructions' | 'skills' | 'tools' | 'knowledgeNote'>;

export const draftsKey = (tenantId: string | undefined) => `ax:agent-drafts:${tenantId || 'default'}`;

export function slugify(text: string): string {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug || 'agent';
}

export function newDraftId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const isDraft = (value: unknown): value is AgentDraft => {
  const v = value as AgentDraft | null;
  return !!v && typeof v.draftId === 'string' && typeof v.name === 'string' && Array.isArray(v.skills) && Array.isArray(v.tools);
};

export function loadDrafts(tenantId: string | undefined): AgentDraft[] {
  const raw = readStoredJson<unknown>(draftsKey(tenantId), []);
  return (Array.isArray(raw) ? raw.filter(isDraft) : []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveDrafts(tenantId: string | undefined, drafts: AgentDraft[]): boolean {
  return writeStoredJson(draftsKey(tenantId), drafts);
}

/** Adds a new draft, or replaces the one with `draftId`. Returns the new list (newest first). */
export function upsertDraft(list: AgentDraft[], input: AgentDraftInput, draftId?: string, now: number = Date.now()): { list: AgentDraft[]; draft: AgentDraft } {
  const existing = draftId ? list.find((d) => d.draftId === draftId) : undefined;
  const draft: AgentDraft = {
    draftId: existing?.draftId || newDraftId(),
    name: input.name.trim(),
    purpose: input.purpose.trim(),
    instructions: input.instructions.trim(),
    skills: [...new Set(input.skills)],
    tools: [...new Set(input.tools)],
    knowledgeNote: input.knowledgeNote.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = [draft, ...list.filter((d) => d.draftId !== draft.draftId)];
  return { list: next, draft };
}

export function removeDraft(list: AgentDraft[], draftId: string): AgentDraft[] {
  return list.filter((d) => d.draftId !== draftId);
}

export interface DraftValidation {
  ok: boolean;
  errors: { name?: string; purpose?: string; instructions?: string };
}

export function validateDraft(input: AgentDraftInput): DraftValidation {
  const errors: DraftValidation['errors'] = {};
  if (!input.name.trim()) errors.name = 'Give the agent a name.';
  if (!input.purpose.trim()) errors.purpose = 'Say in a sentence what this agent is for.';
  if (!input.instructions.trim()) errors.instructions = 'Write the instructions the agent should follow.';
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * The draft shaped like a business-pack agent, for pasting into the back office. `modelPolicyRef` is the one the caller names
 * (usually the default agent's), because a model policy is chosen from the pack's own policies, never made up here.
 */
export function draftToPackAgentJson(draft: AgentDraft, opts: { modelPolicyRef?: string; takenIds?: string[] } = {}): string {
  const taken = new Set(opts.takenIds || []);
  const base = slugify(draft.name);
  let agentId = base;
  for (let n = 2; taken.has(agentId); n++) agentId = `${base}_${n}`;
  const definition: Record<string, unknown> = {
    agentId,
    name: draft.name,
    purpose: draft.purpose,
    systemPromptTemplate: draft.instructions,
    allowedTools: draft.tools,
    skills: draft.skills,
    ...(opts.modelPolicyRef ? { modelPolicyRef: opts.modelPolicyRef } : {}),
    handoffConditions: [],
  };
  // Not a pack field (the pack ignores it); kept so the author's note about knowledge travels with the definition.
  if (draft.knowledgeNote) definition.knowledgeNote = draft.knowledgeNote;
  return JSON.stringify(definition, null, 2);
}
