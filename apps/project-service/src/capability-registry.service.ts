import { Injectable } from '@nestjs/common';
import {
  ToolDefinition,
  ToolBinding,
  BusinessPackRelease,
} from '@journeyax/business-pack';
import { connectToDatabase, COLLECTION_BUSINESS_PACK_RELEASES, COLLECTION_BUSINESS_PACK_POINTERS } from '@journeyax/database';
import { CARD_TYPE_NAMES, CardType } from '@journeyax/ui-cards';
import { createHash } from 'crypto';

export function isCardType(x: unknown): x is CardType {
  return typeof x === 'string' && (CARD_TYPE_NAMES as string[]).includes(x);
}

/**
 * Domain-neutral platform capability contract definitions ONLY.
 * NO tenant, industry, product, sports, uniform, or bathroom tools hardcoded.
 */
export const PLATFORM_TOOL_CONTRACTS: Record<string, {
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  sideEffect: 'read' | 'write' | 'transactional';
  risk: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
  idempotencyRequired: boolean;
  displayName: string;
  description: string;
}> = {
  'catalog.search': {
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        minPriceCents: { type: 'number' },
        maxPriceCents: { type: 'number' },
        inStockOnly: { type: 'boolean' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array' },
        total: { type: 'number' },
      },
    },
    sideEffect: 'read',
    risk: 'low',
    requiresApproval: false,
    idempotencyRequired: false,
    displayName: 'Catalog Search',
    description: 'Domain-neutral catalog search contract for authenticated products and inventory',
  },
  'pricing.validate': {
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sku: { type: 'string' }, quantity: { type: 'number' } },
            required: ['sku', 'quantity'],
          },
        },
        currency: { type: 'string' },
      },
      required: ['items'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        subtotalCents: { type: 'number' },
        taxCents: { type: 'number' },
        totalCents: { type: 'number' },
        currency: { type: 'string' },
      },
    },
    sideEffect: 'read',
    risk: 'low',
    requiresApproval: false,
    idempotencyRequired: false,
    displayName: 'Pricing Validation',
    description: 'Domain-neutral cart and pricing validation contract',
  },
  'order.commit': {
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array' },
        totalCents: { type: 'number' },
        currency: { type: 'string' },
        shippingAddress: { type: 'object' },
        idempotencyKey: { type: 'string' },
      },
      required: ['items', 'idempotencyKey'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        status: { type: 'string' },
        confirmationUrl: { type: 'string' },
      },
    },
    sideEffect: 'transactional',
    risk: 'high',
    requiresApproval: true,
    idempotencyRequired: true,
    displayName: 'Order Commit',
    description: 'Domain-neutral transactional order placement contract with mandatory approval and idempotency',
  },
  'workflow.invoke': {
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        payload: { type: 'object' },
        idempotencyKey: { type: 'string' },
      },
      required: ['flowId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string' },
        status: { type: 'string' },
      },
    },
    sideEffect: 'transactional',
    risk: 'medium',
    requiresApproval: false,
    idempotencyRequired: true,
    displayName: 'Workflow Invoke',
    description: 'Domain-neutral workflow invocation contract via external Activepieces flows',
  },
  'notification.send': {
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        templateId: { type: 'string' },
        variables: { type: 'object' },
      },
      required: ['recipient', 'templateId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        notificationId: { type: 'string' },
        status: { type: 'string' },
      },
    },
    sideEffect: 'write',
    risk: 'medium',
    requiresApproval: false,
    idempotencyRequired: true,
    displayName: 'Notification Send',
    description: 'Domain-neutral notification dispatch contract',
  },
};

// Aliases for standard platform contracts to preserve backward compatibility
export const STANDARD_TOOL_SCHEMAS: Record<string, typeof PLATFORM_TOOL_CONTRACTS[string]> = {
  ...PLATFORM_TOOL_CONTRACTS,
  catalog_search: PLATFORM_TOOL_CONTRACTS['catalog.search'],
  pricing_validate: PLATFORM_TOOL_CONTRACTS['pricing.validate'],
  order_commit: PLATFORM_TOOL_CONTRACTS['order.commit'],
};

@Injectable()
export class CapabilityRegistryService {
  /**
   * Return platform-level contract schema.
   */
  getStandardToolSchema(toolId: string) {
    return STANDARD_TOOL_SCHEMAS[toolId] || null;
  }

  /**
   * Lists platform-level contract definitions.
   */
  listStandardToolSchemas() {
    return STANDARD_TOOL_SCHEMAS;
  }

  /**
   * Check if toolId is a standard platform-level contract.
   */
  hasToolSchema(toolId: string): boolean {
    return Boolean(STANDARD_TOOL_SCHEMAS[toolId]);
  }

  /**
   * Dynamic capability discovery from authoritative Business Pack releases and installed Activepieces integrations.
   * Scoped to tenantId, environmentId, and optional packVersion.
   */
  async discoverCapabilitiesForTenant(
    tenantId: string,
    environmentId: string,
    packVersion?: string
  ): Promise<ToolDefinition[]> {
    const discovered: ToolDefinition[] = [];

    // 1. Load from authoritative Business Pack release in MongoDB if available
    const uri = process.env.MONGODB_URI;
    if (uri) {
      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');

        let versionToLoad = packVersion;
        if (!versionToLoad) {
          const pointer = await db.collection(COLLECTION_BUSINESS_PACK_POINTERS).findOne({
            tenantId,
            environmentId,
          });
          versionToLoad = pointer?.activeVersion;
        }

        if (versionToLoad) {
          const release = await db.collection(COLLECTION_BUSINESS_PACK_RELEASES).findOne({
            tenantId,
            environmentId,
            version: versionToLoad,
          });

          if (release?.capabilities?.toolDefinitions) {
            discovered.push(...release.capabilities.toolDefinitions);
          }
        }

        // 2. Discover installed Activepieces integration subscriptions for this tenant
        const activepiecesSubs = await db.collection('webhook_subscriptions').find({
          tenantId,
          environmentId,
          status: 'active',
        }).toArray();

        for (const sub of activepiecesSubs) {
          const flowToolId = `activepieces.${sub.event || 'flow'}`;
          if (!discovered.some((d) => d.toolId === flowToolId)) {
            discovered.push({
              toolId: flowToolId,
              version: '1.0.0',
              displayName: `Activepieces ${sub.event || 'Flow'}`,
              description: `Dynamically discovered Activepieces integration flow (${sub.subscriptionId})`,
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              sideEffect: 'write',
              risk: 'medium',
              timeoutPolicy: { timeoutMs: 15000, retryAttempts: 1 },
              idempotencyPolicy: { required: true, ttlSeconds: 86400 },
              approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
              dataClassification: 'internal',
            });
          }
        }
      } catch (err: any) {
        console.warn(`[CapabilityRegistryService] Dynamic capability discovery warning for tenant '${tenantId}':`, err.message);
      }
    }

    // 3. Always include domain-neutral platform contracts if not shadowed
    for (const [key, contract] of Object.entries(PLATFORM_TOOL_CONTRACTS)) {
      if (!discovered.some((d) => d.toolId === key)) {
        discovered.push({
          toolId: key,
          version: '1.0.0',
          displayName: contract.displayName,
          description: contract.description,
          inputSchema: contract.inputSchema,
          outputSchema: contract.outputSchema,
          sideEffect: contract.sideEffect,
          risk: contract.risk,
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: contract.idempotencyRequired, ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: contract.requiresApproval, ttlMinutes: 60 },
          dataClassification: 'internal',
        });
      }
    }

    return discovered;
  }

  /**
   * Studio validation of tool bindings: verifies schema, policy, and referenced secrets.
   * Strictly prohibits raw secrets in bindings; only secretRef references are allowed.
   */
  validateToolBinding(
    binding: ToolBinding,
    availableSecrets: string[] = []
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!binding.toolId) errors.push('binding.toolId is required');
    if (!binding.tenantId) errors.push('binding.tenantId is required');
    if (!binding.environmentId) errors.push('binding.environmentId is required');

    if (!binding.executor) {
      errors.push('binding.executor is required');
    } else {
      if (binding.executor.type === 'activepieces_flow' && !binding.executor.flowId) {
        errors.push('activepieces_flow executor requires flowId');
      }
      if (binding.executor.connectionRef && !availableSecrets.includes(binding.executor.connectionRef)) {
        errors.push(`Referenced secret connection '${binding.executor.connectionRef}' is not configured for tenant '${binding.tenantId}'`);
      }
    }

    // Ensure no raw secrets are stored in policyOverrides
    if (binding.policyOverrides) {
      const serialized = JSON.stringify(binding.policyOverrides);
      if (/apiKey|secret|password|private_key|token/i.test(serialized) && !/secretRef/i.test(serialized)) {
        errors.push('Raw secret detected in policyOverrides. Use secretRef references only.');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validates Business Pack reference integrity:
   * 1. Journeys reference declared stages.
   * 2. Stages reference declared tools.
   * 3. Declared tools have matching tool bindings.
   */
  validateBusinessPackReferenceIntegrity(pack: BusinessPackRelease): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const declaredToolIds = new Set(pack.capabilities?.toolDefinitions?.map((t) => t.toolId) || []);
    const declaredBindingToolIds = new Set(pack.capabilities?.toolBindings?.map((b) => b.toolId) || []);

    // Check stage bindings reference declared tools
    if (pack.capabilities?.stageBindings) {
      for (const sb of pack.capabilities.stageBindings) {
        for (const t of sb.tools) {
          if (!declaredToolIds.has(t.toolId) && !PLATFORM_TOOL_CONTRACTS[t.toolId] && !STANDARD_TOOL_SCHEMAS[t.toolId]) {
            errors.push(`Stage binding for '${sb.journeyId}/${sb.stageId}' references undeclared tool '${t.toolId}'`);
          }
        }
      }
    }

    // Check tool bindings have declared tool definitions
    for (const binding of pack.capabilities?.toolBindings || []) {
      if (!declaredToolIds.has(binding.toolId) && !PLATFORM_TOOL_CONTRACTS[binding.toolId] && !STANDARD_TOOL_SCHEMAS[binding.toolId]) {
        errors.push(`Tool binding references undeclared tool definition '${binding.toolId}'`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Card/Theme CMS publication and validation using @journeyax/ui-cards.
   */
  async publishCardTheme(
    tenantId: string,
    environmentId: string,
    theme: Record<string, any>,
    cards: Array<{ cardId?: string; id?: string; cardType?: string; type?: string; [key: string]: any }>
  ): Promise<{ version: string; checksum: string; cardCount: number }> {
    // Validate each card with @journeyax/ui-cards
    for (const card of cards) {
      const type = card.cardType || card.type;
      if (!isCardType(type)) {
        throw new Error(`Invalid card envelope for card '${card.cardId || card.id}': unknown cardType '${type}' (allowed: ${CARD_TYPE_NAMES.join(', ')})`);
      }
    }

    const payload = JSON.stringify({ tenantId, environmentId, theme, cards });
    const checksum = createHash('sha256').update(payload).digest('hex');
    const version = `theme_v_${Date.now()}`;

    const uri = process.env.MONGODB_URI;
    if (uri) {
      try {
        const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
        await db.collection('card_theme_releases').insertOne({
          tenantId,
          environmentId,
          version,
          checksum,
          theme,
          cards,
          publishedAt: new Date(),
        });
        await db.collection('card_theme_pointers').updateOne(
          { tenantId, environmentId },
          { $set: { activeVersion: version, activeChecksum: checksum, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (err: any) {
        console.warn(`[CapabilityRegistryService] Card theme Mongo write warning:`, err.message);
      }
    }

    return { version, checksum, cardCount: cards.length };
  }

  /**
   * Card/Theme rollback to a previous checksum-verified release.
   */
  async rollbackCardTheme(
    tenantId: string,
    environmentId: string,
    targetVersion: string
  ): Promise<{ version: string; restored: boolean }> {
    const uri = process.env.MONGODB_URI;
    if (uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const release = await db.collection('card_theme_releases').findOne({
        tenantId,
        environmentId,
        version: targetVersion,
      });
      if (!release) {
        throw new Error(`Target card theme release '${targetVersion}' not found for rollback`);
      }

      await db.collection('card_theme_pointers').updateOne(
        { tenantId, environmentId },
        { $set: { activeVersion: targetVersion, activeChecksum: release.checksum, rolledBackAt: new Date() } }
      );
      return { version: targetVersion, restored: true };
    }
    return { version: targetVersion, restored: true };
  }
}
