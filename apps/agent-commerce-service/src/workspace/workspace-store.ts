import { connectToDatabase } from '@journeyax/database';
import { Collection } from 'mongodb';
import { WorkspaceState, FactEntry } from '@journeyax/journey-core';

const DB_NAME = 'journeyx';
const WORKSPACES_COLLECTION = 'customer_workspaces';

export class WorkspaceStore {
  private col: Collection<WorkspaceState> | null = null;
  private tried = false;

  private async getCol(): Promise<Collection<WorkspaceState> | null> {
    if (this.col) return this.col;
    if (this.tried) return null;
    this.tried = true;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn('[WorkspaceStore] MONGODB_URI not set — customer_workspaces will use in-memory fallback.');
      return null;
    }

    try {
      const { db } = await connectToDatabase(uri, DB_NAME);
      this.col = db.collection<WorkspaceState>(WORKSPACES_COLLECTION);
      // Strict multi-tenant compound index
      await this.col.createIndex({ tenantId: 1, workspaceId: 1 }, { unique: true }).catch(() => {});
      await this.col.createIndex({ tenantId: 1, updatedAt: -1 }).catch(() => {});
      return this.col;
    } catch (e: any) {
      console.warn('[WorkspaceStore] Mongo unavailable — falling back to memory:', e.message);
      return null;
    }
  }

  async load(tenantId: string, workspaceId: string): Promise<WorkspaceState | null> {
    if (!tenantId || !workspaceId) return null;
    const col = await this.getCol();
    if (!col) return null;

    try {
      return await col.findOne({ tenantId, workspaceId }, { projection: { _id: 0 } });
    } catch {
      return null;
    }
  }

  async commit(workspace: WorkspaceState): Promise<void> {
    if (!workspace.tenantId || !workspace.workspaceId) return;
    const col = await this.getCol();
    if (!col) return;

    const now = new Date();
    workspace.updatedAt = now;

    try {
      await col.updateOne(
        { tenantId: workspace.tenantId, workspaceId: workspace.workspaceId },
        {
          $set: {
            currentStage: workspace.currentStage,
            goal: workspace.goal,
            packVersionId: workspace.packVersionId,
            journeyId: workspace.journeyId,
            facts: workspace.facts,
            decisions: workspace.decisions,
            selectedObjects: workspace.selectedObjects,
            openQuestions: workspace.openQuestions,
            status: workspace.status,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );
    } catch (e: any) {
      console.warn('[WorkspaceStore] Failed to commit workspace:', e.message);
    }
  }

  createInitial(params: {
    tenantId: string;
    workspaceId: string;
    packVersionId: string;
    journeyId: string;
    initialStage: string;
    goal: string;
  }): WorkspaceState {
    const now = new Date();
    return {
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      packVersionId: params.packVersionId,
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
