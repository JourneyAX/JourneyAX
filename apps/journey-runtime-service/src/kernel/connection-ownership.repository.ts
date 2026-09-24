import { connectToDatabase } from '@journeyax/database';

export interface IConnectionOwnershipRepository {
  validateOwnership(
    tenantId: string,
    environmentId: string,
    connectionRef: string
  ): Promise<boolean>;
}

/**
 * DurableConnectionOwnershipRepository
 * Validates tenant/environment ownership of connection references strictly against
 * durable records in tenant_connections and tenant_secrets collections.
 *
 * Rules:
 * 1. Fails closed if database is unavailable or inputs are missing/blank.
 * 2. Never infers ownership from connectionRef naming or substrings.
 * 3. Never permits allow-all fallbacks.
 */
export class DurableConnectionOwnershipRepository implements IConnectionOwnershipRepository {
  constructor(
    private dbOrProvider?: any | (() => Promise<any> | any)
  ) {}

  private async getDb(): Promise<any> {
    if (typeof this.dbOrProvider === 'function') {
      return await this.dbOrProvider();
    }
    if (this.dbOrProvider) {
      return this.dbOrProvider;
    }
    const uri = process.env.MONGODB_URI;
    if (!uri || uri.trim() === '') {
      return null;
    }
    try {
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);
      return db;
    } catch {
      return null;
    }
  }

  async validateOwnership(
    tenantId: string,
    environmentId: string,
    connectionRef: string
  ): Promise<boolean> {
    if (!tenantId || !environmentId || !connectionRef) {
      return false;
    }
    const normTenant = tenantId.trim();
    const normEnv = environmentId.trim();
    const normConn = connectionRef.trim();

    if (!normTenant || !normEnv || !normConn) {
      return false;
    }

    try {
      const db = await this.getDb();
      if (!db) {
        return false;
      }

      // 1. Query tenant_connections collection
      const connectionDoc = await db.collection('tenant_connections').findOne({
        tenantId: normTenant,
        environmentId: { $in: [normEnv, 'all'] },
        connectionRef: normConn,
      });

      if (connectionDoc) {
        return true;
      }

      // 2. Query tenant_secrets collection
      const secretDoc = await db.collection('tenant_secrets').findOne({
        tenantId: normTenant,
        environmentId: { $in: [normEnv, 'all'] },
        $or: [
          { secretRef: normConn },
          { connectionRef: normConn },
        ],
      });

      return Boolean(secretDoc);
    } catch {
      return false;
    }
  }
}
