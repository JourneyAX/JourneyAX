import { connectToDatabase } from '@journeyax/database';
import { Collection } from 'mongodb';
import { WorkspaceState, FactEntry } from '@journeyax/journey-core';

const DB_NAME = 'journeyx';
const WORKSPACES_COLLECTION = 'customer_workspaces';

export class WorkspaceStore {
  private col: Collection<WorkspaceState> | null = null;
  private tried = false;
  private memoryStore = new Map<string, WorkspaceState>();

  private get allowMemoryFallback(): boolean {
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
      const { db } = await connectToDatabase(uri, DB_NAME);
      this.col = db.collection<WorkspaceState>(WORKSPACES_COLLECTION);
      // Strict multi-tenant compound index
      await this.col.createIndex(
        { tenantId: 1, environmentId: 1, workspaceId: 1 },
        { unique: true }
      );
      await this.col.createIndex({ tenantId: 1, environmentId: 1, updatedAt: -1 });
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
    return this.allowMemoryFallback ? this.memoryStore.get(key) || null : null;
  }

  async commit(workspace: WorkspaceState): Promise<void> {
    if (!workspace.tenantId || !workspace.workspaceId) return;
    const key = this.key(workspace.tenantId, workspace.environmentId, workspace.workspaceId);
    const now = new Date();
    workspace.updatedAt = now;

    if (this.allowMemoryFallback) {
      this.memoryStore.set(key, structuredClone(workspace));
    }

    const col = await this.getCol();
    if (!col) return;

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
        { upsert: expectedVersion === 0 }
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
