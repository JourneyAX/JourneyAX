import type { BusinessPackRelease } from '@journeyax/business-pack';
import { connectToDatabase } from '@journeyax/database';
import {
  loadActiveOkfRevocations,
  loadPinnedOkfRelease,
  resolveOkfGate,
  type OkfGateDecision,
  type OkfReleaseContent,
} from '@journeyax/knowledge';
import type { TurnCommand, WorkspaceState } from '@journeyax/journey-core';
import type { InterpretationResult } from '../turn/interpret-event';

export interface KnowledgeControlPlanePort {
  evaluate(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    interpretation: InterpretationResult
  ): Promise<OkfGateDecision | null>;
}

export class OkfKnowledgeControlPlane implements KnowledgeControlPlanePort {
  private readonly releaseCache = new Map<string, OkfReleaseContent>();

  constructor(
    private readonly dbProvider: () => Promise<any> = async () => {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
      const { db } = await connectToDatabase(
        process.env.MONGODB_URI,
        process.env.MONGODB_DB_NAME || 'journeyx'
      );
      return db;
    }
  ) {}

  async evaluate(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    interpretation: InterpretationResult
  ): Promise<OkfGateDecision | null> {
    const ref = release.knowledgeModel;
    if (!ref || ref.type !== 'okf_release') return null;

    const required = ref.required;
    const failurePolicy = ref.failurePolicy;
    const environmentId = command.environmentId || 'production';
    const message = command.message || String(command.event?.payload?.message || '');
    const facts: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(workspace?.facts || {})) facts[key] = entry?.value;
    for (const [key, entry] of Object.entries(interpretation.candidateFacts || {})) facts[key] = entry?.value;

    const inputBase = {
      tenantId: command.tenantId,
      environmentId,
      releaseId: ref.releaseId,
      message,
      knownFacts: facts,
      intentCandidates: interpretation.intent ? [interpretation.intent] : [],
      exactSku: /\b(?:sku\s*[:#-]?\s*)?[a-z0-9]+(?:-[a-z0-9]+){1,}\b/i.exec(message)?.[0],
      forceShowResults: /\b(?:just\s+show\s+me|show\s+me\s+(?:the\s+)?(?:items|products|options)|skip\s+the\s+questions)\b/i.test(message),
    } as const;

    try {
      if (workspace?.pins?.okfReleaseId && workspace.pins.okfReleaseId !== ref.releaseId) {
        throw new Error(`workspace OKF release pin '${workspace.pins.okfReleaseId}' does not match Business Pack reference '${ref.releaseId}'`);
      }
      if (workspace?.pins?.okfChecksum && workspace.pins.okfChecksum !== ref.checksum) {
        throw new Error('workspace OKF checksum pin does not match Business Pack reference');
      }

      const db = await this.dbProvider();
      const cacheKey = `${command.tenantId}:${environmentId}:${ref.releaseId}:${ref.checksum}`;
      let content = this.releaseCache.get(cacheKey);
      if (!content) {
        const loaded = await loadPinnedOkfRelease(db, {
          tenantId: command.tenantId,
          environmentId,
          releaseId: ref.releaseId,
          version: ref.version,
          checksum: ref.checksum,
        });
        content = loaded.release.content;
        this.releaseCache.set(cacheKey, content);
      }

      // Revocations intentionally bypass the immutable release cache. A pinned
      // conversation may keep its release, but never bypass a safety revocation.
      const activeRevocations = await loadActiveOkfRevocations(
        db,
        command.tenantId,
        environmentId,
        ref.releaseId
      );
      let decision = resolveOkfGate(content, {
        ...inputBase,
        activeRevocations,
        knowledgeAvailability: { available: true, required, failurePolicy },
      });

      // Short clarification answers frequently do not repeat the product,
      // room, or problem phrase that selected the concept. Reuse only the
      // context pinned to this exact immutable OKF release; a fresh explicit
      // concept match above always wins and can replace it on the next commit.
      const retained = workspace?.knowledgeContext;
      if (
        decision.mode === 'no_match' &&
        retained?.releaseId === ref.releaseId &&
        retained.checksum === ref.checksum
      ) {
        decision = resolveOkfGate(content, {
          ...inputBase,
          matchedConcepts: [{
            id: retained.conceptId,
            score: 1,
            matchedBy: 'workspace_context',
          }],
          activeRevocations,
          knowledgeAvailability: { available: true, required, failurePolicy },
        });
        decision.trace.reasonCodes.push('workspace_concept_continuity');
      }

      return decision;
    } catch (error: any) {
      const unavailable = resolveOkfGate({} as OkfReleaseContent, {
        ...inputBase,
        knowledgeAvailability: { available: false, required, failurePolicy },
      });
      unavailable.trace.reasonCodes.push(`knowledge_load_error:${error.message}`);
      return unavailable;
    }
  }

  clearCache(): void {
    this.releaseCache.clear();
  }
}
