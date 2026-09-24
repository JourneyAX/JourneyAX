import { WorkspaceState, EnvironmentId, FactsMap, FactSource } from '@journeyax/journey-core';
import { ClientSession } from 'mongodb';
import { WorkspaceStore } from '../workspace/workspace.store';

export class WorkspaceRepository {
  private store: WorkspaceStore;

  constructor(store?: WorkspaceStore) {
    this.store = store || new WorkspaceStore();
  }

  async load(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string
  ): Promise<WorkspaceState | null> {
    return this.store.load(tenantId, environmentId, workspaceId);
  }

  async save(workspace: WorkspaceState, session?: ClientSession): Promise<WorkspaceState> {
    await this.store.commit(workspace, session);
    return workspace;
  }

  async getOrCreate(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    defaultJourneyId: string,
    initialStageId: string,
    initialFacts?: FactsMap,
    packVersionId = 'latest'
  ): Promise<WorkspaceState> {
    const existing = await this.load(tenantId, environmentId, workspaceId);
    if (existing) {
      return existing;
    }

    const created = this.store.createInitial({
      tenantId,
      environmentId,
      workspaceId,
      packVersionId,
      journeyId: defaultJourneyId,
      initialStage: initialStageId,
      goal: 'Complete journey',
    });

    if (initialFacts) {
      created.facts = structuredClone(initialFacts);
    }

    await this.store.commit(created);
    return created;
  }

  async appendFact(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    key: string,
    value: unknown,
    source: FactSource = 'external'
  ): Promise<WorkspaceState> {
    const ws = await this.load(tenantId, environmentId, workspaceId);
    if (!ws) {
      throw new Error(`Workspace not found: ${tenantId}:${environmentId}:${workspaceId}`);
    }
    ws.facts[key] = {
      value,
      source,
      confidence: 1.0,
      extractedAt: new Date().toISOString(),
    };
    await this.store.commit(ws);
    return ws;
  }
}
