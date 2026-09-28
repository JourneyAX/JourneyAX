import { connectToDatabase, COLLECTION_CUSTOMER_WORKSPACES } from '@journeyax/database';
import { Collection, ClientSession } from 'mongodb';
import { WorkspaceState } from '@journeyax/journey-core';

export class WorkspaceStore {
  private col: Collection<WorkspaceState> | null = null;
  private tried = false;
  private memoryStore = new Map<string, WorkspaceState>();

  private readonly explicitMemory: boolean = false;

  constructor(customDbOrOptions?: any) {
    if (customDbOrOptions && typeof customDbOrOptions.collection === 'function') {
      this.col = customDbOrOptions.collection(COLLECTION_CUSTOMER_WORKSPACES);
      this.tried = true;
    } else if (customDbOrOptions?.forceInMemory || customDbOrOptions?.explicitMemory) {
      this.col = null;
      this.tried = true;
      this.explicitMemory = true;
    }
  }

  private get allowMemoryFallback(): boolean {
    if (this.explicitMemory) return true;
    return process.env.NODE_ENV !== 'production' && process.env.ALLOW_IN_MEMORY_WORKSPACES !== 'false';
  }

  private key(tenantId: string, environmentId: string, workspaceId: string): string {
    return `${tenantId}:${environmentId}:${workspaceId}`;
  }

  private async getCol(): Promise<Collection<WorkspaceState> | null> {
    if (this.col) return this.col;
    if (this.tried) return null;
    this.tried = true;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      if (this.allowMemoryFallback) {
        console.warn('[WorkspaceStore] MONGODB_URI not set — using development-only in-memory workspaces.');
        return null;
      }
      throw new Error('[WorkspaceStore] MONGODB_URI is required in production.');
    }

    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<WorkspaceState>(COLLECTION_CUSTOMER_WORKSPACES);
      return this.col;
    } catch (e: any) {
      if (this.allowMemoryFallback) {
        console.warn('[WorkspaceStore] Mongo unavailable — using development-only memory:', e.message);
        return null;
      }
      throw new Error(`[WorkspaceStore] Mongo unavailable in production: ${e.message}`);
    }
  }

  async load(
    tenantId: string,
    environmentId: WorkspaceState['environmentId'],
    workspaceId: string
  ): Promise<WorkspaceState | null> {
    if (!tenantId || !environmentId || !workspaceId) return null;
    const key = this.key(tenantId, environmentId, workspaceId);
    const col = await this.getCol();
    if (col) {
      try {
        const found = await col.findOne(
          { tenantId, environmentId, workspaceId },
          { projection: { _id: 0 } }
        );
        if (found) {
          this.memoryStore.set(key, found);
          return found;
        }
      } catch (e: any) {
        if (!this.allowMemoryFallback) {
          throw new Error(`[WorkspaceStore] Failed to load workspace: ${e.message}`);
        }
      }
    }
    if (this.allowMemoryFallback) {
      const mem = this.memoryStore.get(key);
      return mem ? structuredClone(mem) : null;
    }
    return null;
  }

  async commit(workspace: WorkspaceState, session?: ClientSession): Promise<void> {
    if (!workspace.tenantId || !workspace.workspaceId) return;
    const key = this.key(workspace.tenantId, workspace.environmentId, workspace.workspaceId);
    const now = new Date();
    workspace.updatedAt = now;

    const col = await this.getCol();
    if (!col) {
      if (this.allowMemoryFallback) {
        const existing = this.memoryStore.get(key);
        if (existing && existing.stateVersion !== workspace.stateVersion) {
          throw new Error('Workspace state changed concurrently; retry the turn with fresh state.');
        }
        workspace.stateVersion = (workspace.stateVersion || 0) + 1;
        this.memoryStore.set(key, structuredClone(workspace));
      }
      return;
    }

    try {
      const expectedVersion = workspace.stateVersion;
      const result = await col.updateOne(
        {
          tenantId: workspace.tenantId,
          environmentId: workspace.environmentId,
          workspaceId: workspace.workspaceId,
          stateVersion: expectedVersion,
        },
        {
          $set: {
            currentStage: workspace.currentStage,
            goal: workspace.goal,
            packVersionId: workspace.packVersionId,
            journeyId: workspace.journeyId,
            journeyVersion: workspace.journeyVersion,
            lastProcessedTurnId: workspace.lastProcessedTurnId,
            facts: workspace.facts,
            decisions: workspace.decisions,
            selectedObjects: workspace.selectedObjects,
            openQuestions: workspace.openQuestions,
            status: workspace.status,
            updatedAt: now,
          },
          $inc: { stateVersion: 1 },
          $setOnInsert: {
            tenantId: workspace.tenantId,
            environmentId: workspace.environmentId,
            workspaceId: workspace.workspaceId,
            createdAt: now,
          },
        },
        { session, upsert: expectedVersion === 0 }
      );
      if (result.matchedCount === 0 && result.upsertedCount === 0) {
        throw new Error('Workspace state changed concurrently; retry the turn with fresh state.');
      }
      workspace.stateVersion = expectedVersion + 1;
      if (this.allowMemoryFallback) this.memoryStore.set(key, structuredClone(workspace));
    } catch (e: any) {
      if (!this.allowMemoryFallback) {
        throw new Error(`[WorkspaceStore] Failed to commit workspace: ${e.message}`);
      }
      console.warn('[WorkspaceStore] Mongo commit failed; development memory copy retained:', e.message);
    }
  }

  createInitial(params: {
    tenantId: string;
    environmentId: WorkspaceState['environmentId'];
    workspaceId: string;
    packVersionId: string;
    journeyId: string;
    initialStage: string;
    goal: string;
  }): WorkspaceState {
    const now = new Date();
    return {
      tenantId: params.tenantId,
      environmentId: params.environmentId,
      workspaceId: params.workspaceId,
      packVersionId: params.packVersionId,
      stateVersion: 0,
      journeyId: params.journeyId,
      currentStage: params.initialStage,
      goal: params.goal,
      facts: {},
      decisions: [],
      selectedObjects: [],
      openQuestions: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }
}
