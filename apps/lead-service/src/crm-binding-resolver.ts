import { Injectable, BadRequestException, Optional, Inject } from '@nestjs/common';
import { BusinessPackLoader } from '@journeyax/business-pack';
import { connectToDatabase } from '@journeyax/database';

export interface CrmBindingResult {
  provider: string;
  crmDomain: string;
  source: 'tenant_connections' | 'business_pack_binding' | 'project_integrations';
}

@Injectable()
export class CrmConnectorBindingResolver {
  private packLoader: BusinessPackLoader;
  private dbProvider?: () => Promise<any> | any;

  constructor(
    @Optional() @Inject('DB_PROVIDER') dbProvider?: () => Promise<any> | any,
    @Optional() @Inject('PACK_LOADER') packLoader?: BusinessPackLoader
  ) {
    this.dbProvider = dbProvider;
    this.packLoader = packLoader || new BusinessPackLoader();
  }

  private async getDb(): Promise<any | null> {
    if (this.dbProvider) {
      return typeof this.dbProvider === 'function' ? await this.dbProvider() : this.dbProvider;
    }
    const uri = process.env.MONGODB_URI || process.env.TEST_MONGODB_URI;
    if (!uri) return null;
    try {
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);
      return db;
    } catch {
      return null;
    }
  }

  /**
   * Resolves the authoritative CRM domain for a tenant by inspecting:
   * 1. Authoritative `tenant_connections` collection in MongoDB.
   * 2. Canonical Business Pack tool bindings (`capabilities.toolBindings`).
   * 3. Published project integrations (`integrations.platforms.crm`).
   *
   * Fails closed if no CRM binding is configured for the tenant.
   * Tenant-isolated: never crosses tenant boundaries or falls back to hardcoded tenant names.
   */
  async resolveCrmBinding(tenantId: string): Promise<CrmBindingResult> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    if (!normTenant) {
      throw new BadRequestException('tenantId is required to resolve CRM connector binding');
    }

    const KNOWN_CRM_PROVIDERS = ['hubspot', 'salesforce', 'dynamics', 'zoho'];

    // 1. Authoritative tenant_connections collection query (strictly tenant-scoped)
    const db = await this.getDb();
    if (db) {
      try {
        const connectionDoc = await db.collection('tenant_connections').findOne({
          tenantId: normTenant,
          status: { $nin: ['revoked', 'inactive'] },
          enabled: { $ne: false },
          $or: [
            { provider: { $in: KNOWN_CRM_PROVIDERS } },
            { pieceName: { $regex: /hubspot|salesforce|dynamics|zoho/i } },
            { pieceId: { $regex: /hubspot|salesforce|dynamics|zoho/i } },
            { connectionRef: { $regex: /hubspot|salesforce|dynamics|zoho/i } },
          ],
        });

        if (connectionDoc) {
          const raw = String(
            connectionDoc.provider ||
            connectionDoc.pieceName ||
            connectionDoc.pieceId ||
            connectionDoc.connectionRef ||
            ''
          ).toLowerCase();

          for (const prov of KNOWN_CRM_PROVIDERS) {
            if (raw.includes(prov)) {
              return {
                provider: prov,
                crmDomain: prov,
                source: 'tenant_connections',
              };
            }
          }
        }
      } catch (err: any) {
        // DB query error; fall through to canonical pack capabilities
      }
    }

    // 2. Canonical Business Pack tool bindings (strictly tenant-scoped)
    try {
      let pack = null;
      if (db) {
        pack = await this.packLoader.loadFromMongo(normTenant, 'production');
      }
      if (!pack) {
        pack = await this.packLoader.loadFromDisk(normTenant, 'production');
      }

      if (pack?.capabilities?.toolBindings) {
        for (const binding of pack.capabilities.toolBindings) {
          // Binding must be for this tenant if tenantId is specified on the binding
          if (binding.tenantId && binding.tenantId.toLowerCase() !== normTenant) {
            continue;
          }
          const text = `${binding.toolId} ${(binding.executor as any)?.connectionRef || ''} ${(binding.executor as any)?.flowId || ''} ${(binding.executor as any)?.nativeHandler || ''}`.toLowerCase();
          for (const prov of KNOWN_CRM_PROVIDERS) {
            if (text.includes(prov)) {
              return {
                provider: prov,
                crmDomain: prov,
                source: 'business_pack_binding',
              };
            }
          }
        }
      }
    } catch {
      // Pack load failed; fall through to project configuration
    }

    // 3. Project configuration (integrations.platforms.crm)
    if (db) {
      try {
        const projectDoc = await db.collection('projects').findOne({
          $or: [{ projectId: normTenant }, { tenantId: normTenant }],
        });
        const crmPlatform =
          projectDoc?.integrations?.platforms?.crm ||
          projectDoc?.integrations?.crm?.platform ||
          projectDoc?.integrations?.crm?.type;

        if (crmPlatform && typeof crmPlatform === 'string' && crmPlatform.toLowerCase() !== 'standalone') {
          const clean = crmPlatform.toLowerCase().replace(/_crm$/, '');
          return {
            provider: clean,
            crmDomain: clean,
            source: 'project_integrations',
          };
        }
      } catch {}
    }

    // Fail closed: No CRM connector or capability binding is configured for this tenant
    throw new BadRequestException(
      `No CRM connector or capability binding configured for tenant '${normTenant}'`
    );
  }
}
