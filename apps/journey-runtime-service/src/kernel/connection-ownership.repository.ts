import { connectToDatabase } from '@journeyax/database';

export interface ValidateOwnershipOptions {
  pieceId?: string;
  flowId?: string;
}

export interface TenantConnectionRecord {
  tenantId: string;
  environmentId: string;
  connectionRef: string;
  provider?: string;
  pieceName?: string;
  pieceId?: string;
  status?: 'active' | 'inactive' | 'revoked' | string;
  enabled?: boolean;
  allowedFlows?: string[];
  createdAt?: string | Date;
}

export interface IConnectionOwnershipRepository {
  validateOwnership(
    tenantId: string,
    environmentId: string,
    connectionRef: string,
    options?: ValidateOwnershipOptions
  ): Promise<boolean>;
}

/**
 * DurableConnectionOwnershipRepository
 * Validates tenant/environment ownership of connection references strictly against
 * authoritative, active records in the tenant_connections collection.
 *
 * Rules:
 * 1. Fails closed if database is unavailable or inputs are missing/blank.
 * 2. Never infers ownership from connectionRef naming or substrings.
 * 3. Never treats arbitrary tenant_secrets as Activepieces connection ownership.
 * 4. Requires active lifecycle (status != 'revoked'/'inactive' and enabled != false).
 * 5. Requires valid piece/provider identification and respects flow bindings if declared.
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
    connectionRef: string,
    options?: ValidateOwnershipOptions
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

      // Query authoritative tenant_connections collection ONLY.
      // Arbitrary tenant_secrets are strictly forbidden from masquerading as connection ownership.
      const connectionDoc = await db.collection('tenant_connections').findOne({
        tenantId: normTenant,
        environmentId: { $in: [normEnv, 'all'] },
        connectionRef: normConn,
      });

      if (!connectionDoc) {
        return false;
      }

      // Enforce active lifecycle state
      if (
        connectionDoc.status === 'revoked' ||
        connectionDoc.status === 'inactive' ||
        connectionDoc.enabled === false
      ) {
        return false;
      }

      // Enforce valid piece or provider declaration
      const piece =
        connectionDoc.pieceId ||
        connectionDoc.pieceName ||
        connectionDoc.provider;
      if (!piece || typeof piece !== 'string' || piece.trim() === '') {
        return false;
      }

      // If a specific pieceId was requested, enforce exact canonical aliases (substring matching is strictly prohibited)
      if (options?.pieceId) {
        const canonicalAliases = this.getCanonicalPieceAliases(options.pieceId);
        const actualPiece = piece.trim().toLowerCase();
        if (!canonicalAliases.has(actualPiece)) {
          return false;
        }
      }

      // If a specific flowId was requested, fail closed when connection has no explicit allowedFlows binding
      if (options?.flowId) {
        if (!Array.isArray(connectionDoc.allowedFlows) || connectionDoc.allowedFlows.length === 0) {
          return false;
        }
        if (!connectionDoc.allowedFlows.includes(options.flowId) && !connectionDoc.allowedFlows.includes('*')) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private getCanonicalPieceAliases(pieceId: string): Set<string> {
    const norm = pieceId.trim().toLowerCase();
    const aliases = new Set<string>([norm]);
    if (
      norm === 'commercetools' ||
      norm === '@activepieces/piece-commercetools' ||
      norm === 'piece-commercetools'
    ) {
      aliases.add('commercetools');
      aliases.add('@activepieces/piece-commercetools');
      aliases.add('piece-commercetools');
    } else if (
      norm === 'shopify' ||
      norm === '@activepieces/piece-shopify' ||
      norm === 'piece-shopify'
    ) {
      aliases.add('shopify');
      aliases.add('@activepieces/piece-shopify');
      aliases.add('piece-shopify');
    } else if (
      norm === 'stripe' ||
      norm === '@activepieces/piece-stripe' ||
      norm === 'piece-stripe'
    ) {
      aliases.add('stripe');
      aliases.add('@activepieces/piece-stripe');
      aliases.add('piece-stripe');
    } else if (
      norm === 'sap' ||
      norm === '@activepieces/piece-sap' ||
      norm === 'piece-sap'
    ) {
      aliases.add('sap');
      aliases.add('@activepieces/piece-sap');
      aliases.add('piece-sap');
    }
    return aliases;
  }
}
