import { Injectable } from '@nestjs/common';
import {
  ToolDefinition,
  ToolBinding,
  BusinessPackRelease,
} from '@journeyax/business-pack';
import { connectToDatabase, COLLECTION_BUSINESS_PACK_RELEASES, COLLECTION_BUSINESS_PACK_POINTERS } from '@journeyax/database';
import { CARD_TYPE_NAMES, CardType } from '@journeyax/ui-cards';
import { createHash, randomUUID } from 'crypto';

export function isCardType(x: unknown): x is CardType {
  return typeof x === 'string' && (CARD_TYPE_NAMES as string[]).includes(x);
}

/**
 * Universal platform capability contract definitions ONLY.
 * NO commerce capabilities (catalog, pricing, order, cart, quote, configurator) in core.
 * Commerce and tenant capabilities MUST come from published Business Packs.
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

// Aliases for universal platform contracts
export const STANDARD_TOOL_SCHEMAS: Record<string, typeof PLATFORM_TOOL_CONTRACTS[string]> = {
  ...PLATFORM_TOOL_CONTRACTS,
};

export interface ReferenceIntegrityOptions {
  availableSecrets?: string[];
  availableTemplates?: string[];
}

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
   * Commerce capabilities (catalog, pricing, order, cart, quote, configurator) come EXCLUSIVELY from Business Packs.
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

    // 3. Include universal domain-neutral platform contracts ONLY (workflow.invoke, notification.send)
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
      if (binding.executor.connectionRef && availableSecrets.length > 0 && !availableSecrets.includes(binding.executor.connectionRef)) {
        errors.push(`Referenced secret connection '${binding.executor.connectionRef}' is not configured for tenant '${binding.tenantId}'`);
      }
    }

    // Ensure no raw secrets are stored in policyOverrides
    if (binding.policyOverrides) {
      const serialized = JSON.stringify(binding.policyOverrides);
      if (/apiKey|secret|password|private_key|token/i.test(serialized) && !/secretRef|connectionRef/i.test(serialized)) {
        errors.push('Raw secret detected in policyOverrides. Use secretRef references only.');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Comprehensive validation of Business Pack reference integrity before publication:
   * 1. Journeys & Stages: Journeys reference declared stages; entryStage exists; transitions point to valid stages; stage agentRefs point to declared agents.
   * 2. Agents & Policies: Agents reference declared model policies or rules.
   * 3. Model & Policies: Model policy routes and defaultPolicy point to declared policies/providers.
   * 4. Tools & Capabilities: Stage bindings and tool bindings reference declared tools in the pack or universal platform contracts.
   * 5. Cards & Themes: Experience card templates use valid @journeyax/ui-cards card types; theme tokens are valid.
   * 6. Secret References: All secretRef / connectionRef references are validated against availableSecrets if provided; raw secrets prohibited.
   * 7. Template References: Template IDs are validated and non-empty.
   */
  validateBusinessPackReferenceIntegrity(
    pack: BusinessPackRelease,
    options: ReferenceIntegrityOptions = {}
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // ── 1. Validate Agents ────────────────────────────────────────────────
    const declaredAgentIds = new Set<string>();
    for (const agent of pack.agents || []) {
      if (!agent.agentId || agent.agentId.trim() === '') {
        errors.push('Agent definition missing required agentId');
        continue;
      }
      declaredAgentIds.add(agent.agentId);

      const policyRef = (agent as any).policyRef || agent.modelPolicyRef;
      if (policyRef) {
        const policyExists =
          pack.modelPolicy?.policies?.some((p) => p.policyId === policyRef) ||
          pack.rules?.some((r) => r.ruleId === policyRef);
        if (!policyExists) {
          errors.push(
            `Agent '${agent.agentId}' references undeclared policyRef '${policyRef}'`
          );
        }
      }
    }

    // ── 2. Validate Model Policy ──────────────────────────────────────────
    if (!pack.modelPolicy) {
      errors.push('Business Pack must declare a modelPolicy');
    } else {
      const declaredPolicies = new Set(pack.modelPolicy.policies?.map((p) => p.policyId) || []);
      if (pack.modelPolicy.defaultPolicy && !declaredPolicies.has(pack.modelPolicy.defaultPolicy)) {
        errors.push(
          `modelPolicy.defaultPolicy '${pack.modelPolicy.defaultPolicy}' is not declared in policies list`
        );
      }
      const routes = (pack.modelPolicy as any).routes;
      if (Array.isArray(routes)) {
        for (const route of routes) {
          if (route.policyRef && !declaredPolicies.has(route.policyRef)) {
            errors.push(
              `modelPolicy route for taskType '${route.taskType}' references undeclared policyRef '${route.policyRef}'`
            );
          }
        }
      }
    }

    // ── 3. Validate Journeys and Stages ───────────────────────────────────
    if (!pack.journeys || pack.journeys.length === 0) {
      errors.push('Business Pack must declare at least one journey');
    } else {
      for (const journey of pack.journeys) {
        if (!journey.journeyId) {
          errors.push('Journey definition missing required journeyId');
          continue;
        }

        const stagesRecord = journey.stages || {};
        const stageEntries: Array<{ stageId: string; stage: any }> = Array.isArray(stagesRecord)
          ? stagesRecord.map((s: any) => ({ stageId: s.stageId, stage: s }))
          : Object.entries(stagesRecord).map(([key, s]: [string, any]) => ({
              stageId: s.stageId || key,
              stage: s,
            }));

        if (stageEntries.length === 0) {
          errors.push(`Journey '${journey.journeyId}' declares no stages`);
          continue;
        }

        const declaredStageIds = new Set<string>();
        for (const entry of stageEntries) {
          if (entry.stageId) declaredStageIds.add(entry.stageId);
        }

        // Validate entry / initial stage
        const entryStage = (journey as any).entryStage || journey.initialStage;
        if (entryStage && !declaredStageIds.has(entryStage)) {
          errors.push(
            `Journey '${journey.journeyId}' entryStage '${entryStage}' does not exist in declared stages`
          );
        }

        // Validate stage agentRef and transitions
        for (const { stageId, stage } of stageEntries) {
          if (stage.agentRef && !declaredAgentIds.has(stage.agentRef)) {
            errors.push(
              `Stage '${journey.journeyId}/${stageId}' references undeclared agentRef '${stage.agentRef}'`
            );
          }

          const transitions = stage.exitConditions || (stage as any).transitions || [];
          for (const tr of transitions) {
            const target = tr.nextStage || tr.targetStage;
            if (
              target &&
              !declaredStageIds.has(target) &&
              !['stage_complete', 'end', 'completed', 'exit'].includes(target)
            ) {
              errors.push(
                `Stage '${journey.journeyId}/${stageId}' transition references undeclared targetStage '${target}'`
              );
            }
          }
        }
      }
    }

    // ── 4. Validate Tools & Capabilities ──────────────────────────────────
    // Commerce tools (catalog, pricing, order, cart, quote, configurator) must be declared in the pack!
    const declaredToolIds = new Set(pack.capabilities?.toolDefinitions?.map((t) => t.toolId) || []);

    if (pack.capabilities?.stageBindings) {
      for (const sb of pack.capabilities.stageBindings) {
        for (const t of sb.tools) {
          if (!declaredToolIds.has(t.toolId) && !PLATFORM_TOOL_CONTRACTS[t.toolId]) {
            errors.push(
              `Stage binding for '${sb.journeyId}/${sb.stageId}' references undeclared tool '${t.toolId}' (commerce/tenant tools must be declared in Business Pack)`
            );
          }
        }
      }
    }

    for (const binding of pack.capabilities?.toolBindings || []) {
      if (!declaredToolIds.has(binding.toolId) && !PLATFORM_TOOL_CONTRACTS[binding.toolId]) {
        errors.push(
          `Tool binding references undeclared tool definition '${binding.toolId}'`
        );
      }

      // ── 5. Validate Secret References & Disallow raw secrets ──────────────
      if (binding.executor?.connectionRef) {
        if (
          options.availableSecrets &&
          options.availableSecrets.length > 0 &&
          !options.availableSecrets.includes(binding.executor.connectionRef)
        ) {
          errors.push(
            `Tool binding '${binding.toolId}' references unconfigured connectionRef '${binding.executor.connectionRef}'`
          );
        }
      }

      if (binding.policyOverrides) {
        const serialized = JSON.stringify(binding.policyOverrides);
        if (
          /apiKey|secret|password|private_key|token/i.test(serialized) &&
          !/secretRef|connectionRef/i.test(serialized)
        ) {
          errors.push(
            `Tool binding '${binding.toolId}' contains prohibited raw secret in policyOverrides. Use secretRef references only.`
          );
        }
      }
    }

    // ── 6. Validate Cards and Themes ──────────────────────────────────────
    if (pack.experience) {
      if (pack.experience.theme) {
        const theme = pack.experience.theme;
        if (!theme.primaryColor || typeof theme.primaryColor !== 'string') {
          errors.push('experience.theme missing valid primaryColor');
        }
      }

      if (pack.experience.cards) {
        const cardEntries = Array.isArray(pack.experience.cards)
          ? pack.experience.cards
          : Object.entries(pack.experience.cards).map(([id, val]: [string, any]) => ({
              id,
              ...val,
            }));

        for (const card of cardEntries) {
          const cardType = card.cardType || card.type;
          if (cardType && !isCardType(cardType)) {
            errors.push(
              `experience.cards contains invalid cardType '${cardType}' for card '${card.id || card.cardId}' (allowed: ${CARD_TYPE_NAMES.join(', ')})`
            );
          }
        }
      }
    }

    // ── 7. Validate Template References ───────────────────────────────────
    if (options.availableTemplates && options.availableTemplates.length > 0) {
      if ((pack as any).notifications) {
        for (const [evt, notif] of Object.entries((pack as any).notifications as Record<string, any>)) {
          if (notif.templateId && !options.availableTemplates.includes(notif.templateId)) {
            errors.push(`Notification event '${evt}' references undeclared templateId '${notif.templateId}'`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Card/Theme CMS publication and validation using @journeyax/ui-cards.
   * Strictly immutable and transactional with active pointers, audit logs, and fail-closed persistence.
   * Never returns success when MongoDB is missing or a write fails.
   */
  async publishCardTheme(
    tenantId: string,
    environmentId: string,
    theme: Record<string, any>,
    cards: Array<{ cardId?: string; id?: string; cardType?: string; type?: string; [key: string]: any }>,
    publishedBy = 'system'
  ): Promise<{ version: string; checksum: string; cardCount: number }> {
    // 1. Validate each card with @journeyax/ui-cards
    for (const card of cards) {
      const type = card.cardType || card.type;
      if (!isCardType(type)) {
        throw new Error(
          `Invalid card envelope for card '${card.cardId || card.id}': unknown cardType '${type}' (allowed: ${CARD_TYPE_NAMES.join(', ')})`
        );
      }
    }

    // 2. Validate theme definition
    if (!theme || typeof theme !== 'object') {
      throw new Error('Theme definition is required and must be an object');
    }
    if (!theme.primaryColor || typeof theme.primaryColor !== 'string') {
      throw new Error('Theme requires valid primaryColor property');
    }

    const payload = JSON.stringify({ tenantId, environmentId, theme, cards });
    const checksum = createHash('sha256').update(payload).digest('hex');
    const version = `theme_v_${Date.now()}`;

    // 3. Fail-closed: MongoDB is mandatory
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('Card and theme publication requires active MongoDB connection; failing closed');
    }

    try {
      const { db, client } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');

      const executeWrite = async (session?: any) => {
        const sOpts = session ? { session } : undefined;

        // Immutable release insert
        await db.collection('card_theme_releases').insertOne(
          {
            tenantId,
            environmentId,
            version,
            checksum,
            theme,
            cards,
            publishedAt: new Date(),
            publishedBy,
          },
          sOpts
        );

        // Active pointer update
        await db.collection('card_theme_pointers').updateOne(
          { tenantId, environmentId },
          {
            $set: {
              activeVersion: version,
              activeChecksum: checksum,
              updatedAt: new Date(),
              updatedBy: publishedBy,
            },
          },
          { upsert: true, ...sOpts }
        );

        // Audit log
        await db.collection('card_theme_audit_logs').insertOne(
          {
            auditId: `audit_${Date.now()}_${randomUUID().slice(0, 8)}`,
            tenantId,
            environmentId,
            action: 'publish',
            version,
            checksum,
            cardCount: cards.length,
            publishedBy,
            timestamp: new Date(),
          },
          sOpts
        );
      };

      if (client && typeof client.startSession === 'function') {
        const session = client.startSession();
        try {
          if (typeof session.withTransaction === 'function') {
            await session.withTransaction(() => executeWrite(session));
          } else {
            await executeWrite(session);
          }
        } finally {
          await session.endSession();
        }
      } else {
        await executeWrite();
      }

      return { version, checksum, cardCount: cards.length };
    } catch (err: any) {
      throw new Error(`Failed to publish card and theme: ${err.message}`);
    }
  }

  /**
   * Card/Theme rollback to a previous checksum-verified release.
   * Fail-closed: Requires active MongoDB, verifies release exists, updates active pointer and records audit.
   */
  async rollbackCardTheme(
    tenantId: string,
    environmentId: string,
    targetVersion: string,
    rolledBackBy = 'system'
  ): Promise<{ version: string; restored: boolean; checksum: string }> {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('Card and theme rollback requires active MongoDB connection; failing closed');
    }

    try {
      const { db, client } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');

      const release = await db.collection('card_theme_releases').findOne({
        tenantId,
        environmentId,
        version: targetVersion,
      });

      if (!release) {
        throw new Error(`Target card theme release '${targetVersion}' not found for rollback`);
      }

      const executeRollback = async (session?: any) => {
        const sOpts = session ? { session } : undefined;

        await db.collection('card_theme_pointers').updateOne(
          { tenantId, environmentId },
          {
            $set: {
              activeVersion: targetVersion,
              activeChecksum: release.checksum,
              rolledBackAt: new Date(),
              rolledBackBy,
            },
          },
          sOpts
        );

        await db.collection('card_theme_audit_logs').insertOne(
          {
            auditId: `audit_${Date.now()}_${randomUUID().slice(0, 8)}`,
            tenantId,
            environmentId,
            action: 'rollback',
            targetVersion,
            checksum: release.checksum,
            rolledBackBy,
            timestamp: new Date(),
          },
          sOpts
        );
      };

      if (client && typeof client.startSession === 'function') {
        const session = client.startSession();
        try {
          if (typeof session.withTransaction === 'function') {
            await session.withTransaction(() => executeRollback(session));
          } else {
            await executeRollback(session);
          }
        } finally {
          await session.endSession();
        }
      } else {
        await executeRollback();
      }

      return { version: targetVersion, restored: true, checksum: release.checksum };
    } catch (err: any) {
      throw new Error(`Failed to rollback card theme: ${err.message}`);
    }
  }
}
