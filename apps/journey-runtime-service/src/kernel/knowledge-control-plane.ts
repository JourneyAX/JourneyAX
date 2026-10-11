import type { BusinessPackRelease } from '@journeyax/business-pack';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';
import {
  loadActiveOkfRevocations,
  loadPinnedOkfRelease,
  resolveOkfGate,
  resolveOkfBasketCommerce,
  type OkfBasketCommerceDecision,
  type OkfGateDecision,
  type OkfReleaseContent,
} from '@journeyax/knowledge';
import type { TurnCommand, WorkspaceState } from '@journeyax/journey-core';
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

export function extractExactSku(message: string): string | undefined {
  const plausible = (candidate: string): boolean => {
    if (/^\d+(?:x\d+)+(?:mm|cm|m)?$/i.test(candidate)) return false;
    if (/^\d+(?:\.\d+)?(?:mm|cm|m|kg|g|l|ml|m2|m3)$/i.test(candidate)) return false;
    if (/^\d{1,4}[-/]?(?:year|yr|month|mo|week|day)s?$/i.test(candidate)) return false;
    if (/^\d{5,}$/.test(candidate)) return true;
    return candidate.length >= 5 && /[a-z]/i.test(candidate) && /\d/.test(candidate);
  };
  const explicit = /\bsku\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]{1,})\b/i.exec(message)?.[1];
  if (explicit && plausible(explicit)) return explicit;
  // This is only a candidate. The control plane verifies it against the
  // tenant's catalog before enabling exact-SKU routing.
  return message.match(/\b[a-z0-9]+(?:[._/-][a-z0-9]+)*\b/gi)?.find(plausible);
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
      knownFacts: facts,
      intentCandidates: interpretation.intent ? [interpretation.intent] : [],
      exactSku: undefined as string | undefined,
      forceShowResults: /\b(?:just\s+show\s+me|show\s+me\s+(?:the\s+)?(?:items|products|options)|skip\s+the\s+questions)\b/i.test(message),
    } as const;

    try {
      if (workspace?.pins?.okfReleaseId && workspace.pins.okfReleaseId !== ref.releaseId) {
        throw new Error(`workspace OKF release pin '${workspace.pins.okfReleaseId}' does not match Business Pack reference '${ref.releaseId}'`);
      }
      if (workspace?.pins?.okfChecksum && workspace.pins.okfChecksum !== ref.checksum) {
        throw new Error('workspace OKF checksum pin does not match Business Pack reference');
      }

      const db = await this.dbProvider();
      const candidateSku = extractExactSku(message);
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
        if (/^(?:actually|instead|forget that|new topic)\b/i.test(normalizedMessage)) return false;
        const option = definition?.options?.some((entry) =>
          normalizedMessage === entry.value.toLowerCase() || normalizedMessage === entry.label.toLowerCase()) ||
          definition?.allowedValues?.some((value) => normalizedMessage === value.toLowerCase());
        const candidateValue = interpretation.candidateFacts?.[discriminator.factKey]?.value;
        return Boolean(option || (typeof candidateValue === 'string' &&
          normalizedMessage.split(/[^a-z0-9]+/).includes(candidateValue.toLowerCase())));
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
    };
    try {
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
      });
    } catch {
      return blocked;
    }
  }

  clearCache(): void {
    this.releaseCache.clear();
  }
}
