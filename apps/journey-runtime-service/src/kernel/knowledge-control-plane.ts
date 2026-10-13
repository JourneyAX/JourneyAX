import { resolveCatalogMapping, type BusinessPackRelease } from '@journeyax/business-pack';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';
import {
  loadActiveOkfRevocations,
  loadPinnedOkfRelease,
  detectIntents,
  foldText,
  tokenizeText,
  extractSkuCandidate,
  resolveOkfGate,
  resolveOkfPolicy,
  type SkuPolicy,
  resolveOkfBasketCommerce,
  type OkfBasketCommerceDecision,
  type OkfGateDecision,
  type OkfReleaseContent,
} from '@journeyax/knowledge';
import type { TurnCommand, WorkspaceState } from '@journeyax/journey-core';
import { probeCatalogue } from './catalogue-probe';
import type { InterpretationResult } from '../turn/interpret-event';

export interface KnowledgeControlPlanePort {
  evaluate(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    interpretation: InterpretationResult
  ): Promise<OkfGateDecision | null>;
  evaluateBasket(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    items: Array<{ sku: string; quantity?: number }>,
    operation?: { operation: 'cart.update' | 'order.commit'; cartId?: string },
  ): Promise<OkfBasketCommerceDecision | null>;
}

/** Candidate identifier in a message; shape rules come from the resolved policy. */
export function extractExactSku(message: string, sku: SkuPolicy = resolveOkfPolicy().sku): string | undefined {
  return extractSkuCandidate(message, sku);
}

export class OkfKnowledgeControlPlane implements KnowledgeControlPlanePort {
  private readonly releaseCache = new Map<string, OkfReleaseContent>();
  private readonly maxReleaseCacheEntries = 100;

  constructor(
    private readonly dbProvider: () => Promise<any> = async () => {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
      const { db } = await connectToDatabase(
        process.env.MONGODB_URI,
        process.env.MONGODB_DB_NAME || 'journeyx'
      );
      return db;
    }
  ) {}

  async evaluate(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    interpretation: InterpretationResult
  ): Promise<OkfGateDecision | null> {
    const ref = release.knowledgeModel;
    if (!ref || ref.type !== 'okf_release') return null;

    const required = ref.required;
    const failurePolicy = ref.failurePolicy;
    const environmentId = command.environmentId || 'production';
    const message = command.message || String(command.event?.payload?.message || '');
    const facts: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(workspace?.facts || {})) facts[key] = entry?.value;
    for (const [key, entry] of Object.entries(interpretation.candidateFacts || {})) facts[key] = entry?.value;

    const inputBase = {
      tenantId: command.tenantId,
      environmentId,
      releaseId: ref.releaseId,
      message,
      // Request language wins; otherwise the pack's primary locale. Selects the tenant's lexicon and wording.
      locale: (command as any).locale || release.profile?.primaryLocale,
      knownFacts: facts,
      intentCandidates: interpretation.intent ? [interpretation.intent] : [],
      exactSku: undefined as string | undefined,
    } as const;

    try {
      if (workspace?.pins?.okfReleaseId && workspace.pins.okfReleaseId !== ref.releaseId) {
        throw new Error(`workspace OKF release pin '${workspace.pins.okfReleaseId}' does not match Business Pack reference '${ref.releaseId}'`);
      }
      if (workspace?.pins?.okfChecksum && workspace.pins.okfChecksum !== ref.checksum) {
        throw new Error('workspace OKF checksum pin does not match Business Pack reference');
      }

      const db = await this.dbProvider();
      const cacheKey = `${command.tenantId}:${environmentId}:${ref.releaseId}:${ref.checksum}`;
      let content = this.releaseCache.get(cacheKey);
      if (!content) {
        const loaded = await loadPinnedOkfRelease(db, {
          tenantId: command.tenantId,
          environmentId,
          releaseId: ref.releaseId,
          version: ref.version,
          checksum: ref.checksum,
        });
        content = loaded.release.content;
        if (this.releaseCache.size >= this.maxReleaseCacheEntries) {
          const oldest = this.releaseCache.keys().next().value;
          if (oldest) this.releaseCache.delete(oldest);
        }
        this.releaseCache.set(cacheKey, content);
      } else {
        // Refresh insertion order for a small bounded LRU cache.
        this.releaseCache.delete(cacheKey);
        this.releaseCache.set(cacheKey, content);
      }

      const policy = resolveOkfPolicy(content.policy, inputBase.locale);
      const candidateSku = extractExactSku(message, policy.sku);
      let exactSku: string | undefined;
      if (candidateSku) {
        const candidates = [candidateSku, candidateSku.toUpperCase(), candidateSku.toLowerCase()];
        const identifiers = [...new Set(candidates)];
        for (const scope of [{ projectId: command.tenantId }, { tenantId: command.tenantId }]) {
          const product = await db.collection(COLLECTION_PRODUCTS).findOne({
            ...scope,
            $or: identifiers.flatMap((value) => [{ sku: value }, { parentSku: value }, { partCode: value }]),
          });
          if (product) { exactSku = candidateSku; break; }
        }
      }

      // Revocations intentionally bypass the immutable release cache. A pinned
      // conversation may keep its release, but never bypass a safety revocation.
      const activeRevocations = await loadActiveOkfRevocations(
        db,
        command.tenantId,
        environmentId,
        ref.releaseId
      );
      const retained = workspace?.knowledgeContext;
      const retainedConcept = retained?.releaseId === ref.releaseId && retained.checksum === ref.checksum
        ? content.concepts.find((concept) => concept.conceptId === retained.conceptId)
        : undefined;
      const pendingAnswer = retainedConcept?.discriminators.some((discriminator) => {
        if (!workspace?.openQuestions?.includes(discriminator.factKey)) return false;
        const definition = content.factRegistry.find((fact) => fact.factKey === discriminator.factKey);
        const normalizedMessage = message.trim().toLowerCase();
        if (detectIntents(message, policy).intents.includes('topic_switch')) return false;
        const option = definition?.options?.some((entry) =>
          normalizedMessage === entry.value.toLowerCase() || normalizedMessage === entry.label.toLowerCase()) ||
          definition?.allowedValues?.some((value) => normalizedMessage === value.toLowerCase());
        const candidateValue = interpretation.candidateFacts?.[discriminator.factKey]?.value;
        return Boolean(option || (typeof candidateValue === 'string' &&
          tokenizeText(normalizedMessage).includes(foldText(candidateValue))));
      });
      if (retainedConcept && pendingAnswer) {
        const continued = resolveOkfGate(content, {
          ...inputBase, exactSku,
          matchedConcepts: [{ id: retainedConcept.conceptId, score: 1, matchedBy: 'pending_clarification' }],
          activeRevocations,
          knowledgeAvailability: { available: true, required, failurePolicy },
        });
        continued.trace.reasonCodes.push('clarification_answer_continuity');
        return continued;
      }

      let decision = resolveOkfGate(content, {
        ...inputBase,
        exactSku,
        activeRevocations,
        knowledgeAvailability: { available: true, required, failurePolicy },
      });

      // Short clarification answers frequently do not repeat the product,
      // room, or problem phrase that selected the concept. Reuse only the
      // context pinned to this exact immutable OKF release; a fresh explicit
      // concept match above always wins and can replace it on the next commit.
      if (
        decision.mode === 'no_match' &&
        retained?.releaseId === ref.releaseId &&
        retained.checksum === ref.checksum
      ) {
        decision = resolveOkfGate(content, {
          ...inputBase,
          exactSku,
          matchedConcepts: [{
            id: retained.conceptId,
            score: 1,
            matchedBy: 'workspace_context',
          }],
          activeRevocations,
          knowledgeAvailability: { available: true, required, failurePolicy },
        });
        decision.trace.reasonCodes.push('workspace_concept_continuity');
      }

      // Only after conversation continuity had its chance: a request that matched no concept and carries no other class may still be a plain shopping request for
      // something the live catalogue lists. Only a release that opted in to catalogue-only shopping pays for the probe.
      if (
        decision.trace.reasonCodes.includes('uncovered_unknown') &&
        policy.coverage.uncoveredShopping.mode === 'catalogue_only' &&
        await probeCatalogue(this.dbProvider, { tenantId: command.tenantId, message, catalogMapping: (release as any).catalogMapping })
      ) {
        decision = resolveOkfGate(content, {
          ...inputBase,
          exactSku,
          catalogueMatch: true,
          activeRevocations,
          knowledgeAvailability: { available: true, required, failurePolicy },
        });
        decision.trace.reasonCodes.push('catalogue_probe_matched');
      }

      return decision;
    } catch {
      const unavailable = resolveOkfGate({} as OkfReleaseContent, {
        ...inputBase,
        knowledgeAvailability: { available: false, required, failurePolicy },
      });
      // Customer-visible traces must not include connection strings or storage errors.
      unavailable.trace.reasonCodes.push('knowledge_load_error');
      return unavailable;
    }
  }

  async evaluateBasket(
    release: BusinessPackRelease,
    command: TurnCommand,
    workspace: WorkspaceState | null,
    items: Array<{ sku: string; quantity?: number }>,
    operation?: { operation: 'cart.update' | 'order.commit'; cartId?: string },
  ): Promise<OkfBasketCommerceDecision | null> {
    const ref = release.knowledgeModel;
    if (!ref || ref.type !== 'okf_release') return null;
    const environmentId = command.environmentId || 'production';
    const blocked: OkfBasketCommerceDecision = {
      commerce: { addToCart: 'blocked', checkout: 'blocked' }, warnings: [], reasonCodes: ['basket_policy_unavailable'],
      messages: resolveOkfPolicy().messages,
    };
    try {
      const mapping = resolveCatalogMapping((release as any).catalogMapping);
      if (workspace?.pins?.okfReleaseId && workspace.pins.okfReleaseId !== ref.releaseId) return blocked;
      if (workspace?.pins?.okfChecksum && workspace.pins.okfChecksum !== ref.checksum) return blocked;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100 ||
        items.some((item) => typeof item?.sku !== 'string' || !item.sku.trim() ||
          (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity <= 0)))) return blocked;
      const db = await this.dbProvider();
      let basketItems = items;
      if (operation?.operation === 'order.commit') {
        const cartId = operation.cartId || `cart-${command.workspaceId}`;
        const cart = await db.collection('customer_carts').findOne({
          projectId: command.tenantId, workspaceId: command.workspaceId,
          cartId, status: 'active',
        });
        if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
          return { ...blocked, reasonCodes: ['authoritative_cart_unavailable'] };
        }
        basketItems = cart.items;
        const identity = (values: Array<{ sku: string; quantity?: number }>) =>
          values.map((item) => `${item.sku.trim()}\u0000${item.quantity ?? 1}`).sort().join('\u0001');
        if (identity(items) !== identity(basketItems)) {
          return { ...blocked, reasonCodes: ['basket_payload_mismatch'] };
        }
      }
      const { release: pinned, activeRevocations } = await loadPinnedOkfRelease(db, {
        tenantId: command.tenantId, environmentId, releaseId: ref.releaseId,
        version: ref.version, checksum: ref.checksum,
      });
      const skus = [...new Set(basketItems.map((item) => item.sku.trim()))];
      const products = await db.collection(COLLECTION_PRODUCTS).find({
        $and: [
          { $or: [{ projectId: command.tenantId }, { tenantId: command.tenantId }] },
          { $or: [{ sku: { $in: skus } }, { parentSku: { $in: skus } }, { partCode: { $in: skus } }] },
        ],
      }).toArray();
      return resolveOkfBasketCommerce(pinned.content, {
        tenantId: command.tenantId, environmentId, releaseId: ref.releaseId,
        items: basketItems, products, activeRevocations,
        availability: {
          excludeFlagPaths: mapping.availability.excludeFlagPaths,
          statusPaths: mapping.availability.statusPaths,
          unavailableStatuses: [...mapping.availability.excludedStatuses, ...mapping.availability.unpricedStatuses],
        },
      });
    } catch {
      return blocked;
    }
  }

  clearCache(): void {
    this.releaseCache.clear();
  }
}
