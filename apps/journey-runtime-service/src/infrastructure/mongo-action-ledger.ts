import type { ActionClaim, ActionIdentity, ActionLedger } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';

/** Intrinsic _id uniqueness reserves an action before a vendor call, across processes and concurrent approvals. */
export class MongoActionLedger implements ActionLedger {
  constructor(private readonly dbProvider?: () => Promise<any>) {}
  private async collection() {
    if (this.dbProvider) return (await this.dbProvider()).collection('action_receipts');
    if (!process.env.MONGODB_URI) throw new Error('Durable action storage is unavailable.');
    return (await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx')).db.collection('action_receipts');
  }
  async claim(identity: ActionIdentity): Promise<ActionClaim> {
    const col = await this.collection();
    try { await col.insertOne({ _id: identity.id, ...identity, status: 'running', createdAt: new Date() }); return { status: 'claimed' }; }
    catch (error: any) {
      if (error?.code !== 11000) throw error;
      const row = await col.findOne({ _id: identity.id, tenantId: identity.tenantId, environmentId: identity.environmentId, principalId: identity.principalId, inputHash: identity.inputHash });
      if (!row) return { status: 'conflict' };
      if (row.status === 'retryable') {
        const retried = await col.updateOne({ _id: identity.id, tenantId: identity.tenantId, environmentId: identity.environmentId, principalId: identity.principalId, inputHash: identity.inputHash, status: 'retryable' },
          { $set: { status: 'running', updatedAt: new Date() }, $inc: { reconciledRetries: 1 } });
        if (retried.modifiedCount === 1) return { status: 'claimed' };
        return { status: 'running' };
      }
      return row.status === 'succeeded' ? { status: 'succeeded', output: row.output } : { status: row.status === 'running' ? 'running' : 'uncertain' };
    }
  }
  async succeed(identity: ActionIdentity, output: unknown): Promise<void> {
    const col = await this.collection();
    const result = await col.updateOne({ _id: identity.id, tenantId: identity.tenantId, environmentId: identity.environmentId, inputHash: identity.inputHash, status: 'running' }, { $set: { status: 'succeeded', output, completedAt: new Date() } });
    if (result.matchedCount !== 1) throw new Error('Action receipt claim was lost.');
  }
  async uncertain(identity: ActionIdentity): Promise<void> {
    await (await this.collection()).updateOne({ _id: identity.id, tenantId: identity.tenantId, environmentId: identity.environmentId, status: 'running' }, { $set: { status: 'uncertain', updatedAt: new Date() } });
  }
}
