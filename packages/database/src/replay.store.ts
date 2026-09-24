import { Db } from 'mongodb';
import { COLLECTION_GATEWAY_ASSERTION_NONCES, GatewayAssertionNonceRecord } from './types';

export interface ReplayStore {
  claim(
    jti: string,
    tenantId: string,
    environmentId: string,
    expiresAt: Date
  ): Promise<'success' | 'already_claimed'>;
}

export class MongoReplayStore implements ReplayStore {
  constructor(private dbProvider: () => Promise<{ db: Db }>) {}

  async claim(
    jti: string,
    tenantId: string,
    environmentId: string,
    expiresAt: Date
  ): Promise<'success' | 'already_claimed'> {
    try {
      const { db } = await this.dbProvider();
      const doc: GatewayAssertionNonceRecord = {
        jti,
        tenantId: tenantId.toLowerCase(),
        environmentId: environmentId.toLowerCase(),
        expiresAt,
        claimedAt: new Date(),
      };
      await db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES).insertOne(doc as any);
      return 'success';
    } catch (err: any) {
      if (err.code === 11000 || /duplicate key/i.test(err.message || '')) {
        return 'already_claimed';
      }
      throw err;
    }
  }
}

export class InMemoryReplayStore implements ReplayStore {
  private nonces = new Map<string, number>();

  async claim(
    jti: string,
    _tenantId: string,
    _environmentId: string,
    expiresAt: Date
  ): Promise<'success' | 'already_claimed'> {
    const now = Date.now();
    // Prune expired nonces
    for (const [k, exp] of this.nonces.entries()) {
      if (now > exp) {
        this.nonces.delete(k);
      }
    }

    if (this.nonces.has(jti)) {
      return 'already_claimed';
    }

    this.nonces.set(jti, expiresAt.getTime());
    return 'success';
  }

  clear(): void {
    this.nonces.clear();
  }
}
