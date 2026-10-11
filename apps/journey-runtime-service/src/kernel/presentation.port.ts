import { renderOkfMessage } from '@journeyax/knowledge';
import { TurnResult, UIInstruction, WorkspaceState, Decision } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { CARD_TYPES } from '@journeyax/ui-cards';
import { ModelGateway } from './model.gateway';

export interface ValidatedTurnOutcome {
  valid: boolean;
  status?: string;
  outcome?: any;
  error?: string;
  violations?: string[];
  appliedRules?: string[];
  notes?: string;
}

export class PresentationPort {
  constructor(private readonly modelGateway?: ModelGateway) {}

  private cardAllowed(release: BusinessPackRelease, cardType: string): boolean {
    const allowed = release.experience?.cards?.allowedCardTypes;
    return !Array.isArray(allowed) || allowed.includes(cardType);
  }

  /**
   * Builds the standard clarification card from a deterministic knowledge-gate
   * question. The gate supplies business content; this method supplies only the
   * platform card envelope and never invents tenant questions or options.
   */
  createKnowledgeClarificationInstruction(clarification: {
    factKey: string;
    question: string;
    uiInputType: string;
    options: Array<{ value: string; label: string }>;
  }, release?: BusinessPackRelease): UIInstruction | null {
    if (release && !this.cardAllowed(release, 'clarify')) return null;
    const inputTypeMap: Record<string, 'single_select' | 'multi_select' | 'number' | 'text'> = {
      select: 'single_select',
      card_choice: 'single_select',
      multi_select: 'multi_select',
      number: 'number',
      slider: 'number',
      text: 'text',
      boolean_toggle: 'single_select',
    };
    const state = {
      questions: [{
        id: clarification.factKey,
        text: clarification.question,
        options: clarification.options.map((option) => option.label || option.value),
        multi: clarification.uiInputType === 'multi_select',
        inputType: inputTypeMap[clarification.uiInputType] || 'text',
      }],
      progress: '1 detail needed',
    };
    const parsed = CARD_TYPES.clarify.state.safeParse(state);
    if (!parsed.success) return null;
    const cardId = `card_okf_clarify_${Date.now()}`;
    return {
      actionId: cardId,
      component: 'clarify',
      placement: 'inline',
      props: parsed.data,
      envelope: {
        name: 'presentCard',
        arguments: {
          card: {
            id: cardId,
            cardType: 'clarify',
            state: parsed.data,
          },
        },
      },
    };
  }

  /**
   * LLM phrasing step through Model Gateway over verified results without
   * hallucinating prices/SKUs; falls back safely to pack templates or deterministic stage copy.
   */
  async phraseMessage(
    release: BusinessPackRelease,
    verifiedResult: any,
    fallbackMessage: string
  ): Promise<string> {
    if (!this.modelGateway || !release.modelPolicy) {
      return fallbackMessage;
    }

    try {
      const prompt =
        `You are the customer assistant for ${release.profile?.companyName || release.manifest.name}.\n` +
        `Verified result facts: ${JSON.stringify(verifiedResult)}\n` +
        `Draft response: "${fallbackMessage}"\n\n` +
        `Rewrite the response into a helpful, conversational, professional reply for the customer.\n` +
        `CRITICAL RULES:\n` +
        `1. Do NOT invent or alter any prices, totals, currencies, or SKUs.\n` +
        `2. Do NOT mention internal runtime concepts like "Stage", "Capability", "facts", or internal IDs.\n` +
        `3. Keep the reply grounded exclusively in the verified facts above.`;

      const res = await this.modelGateway.execute(release, {
        taskType: 'fast_intent',
        prompt,
        systemPrompt: 'You phrase verified system outcomes for customers. You never hallucinate numbers, prices, or product codes.',
      });

      if (res?.content && typeof res.content === 'string') {
        const cleaned = res.content.trim().replace(/^["']|["']$/g, '');
        if (
          cleaned &&
          !cleaned.includes("Stage '") &&
          !cleaned.includes("Capability '") &&
          !cleaned.includes("requires input")
        ) {
          return cleaned;
        }
      }
    } catch {
      // Deterministic fallback on any provider/model error
    }

    return fallbackMessage;
  }

  /**
   * Composes truthful UI instructions and assistant messages using ONLY
   * registered @journeyax/ui-cards and pack-derived content.
   * Zero fabricated defaults (no default USD, ITEM-1, or fake success messages).
   */
  compose(
    validated: ValidatedTurnOutcome,
    decision: Decision,
    workspace: WorkspaceState,
    release: BusinessPackRelease,
    options?: {
      assistantMessage?: string;
      customerQuery?: string;
      /**
       * The capability whose authoritative output is being presented. The
       * journey may already have advanced to the next stage, so the final
       * state-machine decision is not a reliable source for tool identity or
       * its scoped input payload.
       */
      capability?: { toolId: string; payload?: Record<string, unknown> };
    }
  ): TurnResult {
    const uiInstructions: UIInstruction[] = [];
    let assistantMessage = (options?.assistantMessage || '').trim();

    // ── 0. VERIFIED OKF SAFETY GUIDE ─────────────────────────────────────
    // Safety prose reaches this boundary only after the OKF gate verifies the
    // relationship, source and freshness. Render it without model rewriting.
    const safetyGuidance = decision.payload?.safetyGuidance;
    if (safetyGuidance && Array.isArray(safetyGuidance.steps) && safetyGuidance.steps.length > 0) {
      const sections = safetyGuidance.steps.map((step: any) => ({
        title: String(step.title || '').trim(),
        body: String(step.instruction || '').trim(),
        steps: Array.isArray(step.sources) && step.sources.length > 0
          ? [renderOkfMessage({ verified_source_label: safetyGuidance.sourceLabelTemplate || '' }, 'verified_source_label',
              { sources: step.sources.map((source: any) => source.title).filter(Boolean).join(', ') })]
          : undefined,
      }));
      const state = {
        heading: String(safetyGuidance.heading || renderOkfMessage({}, 'safety_heading')),
        sections,
        safety: safetyGuidance.blocksProducts
          ? String(safetyGuidance.blockedNotice || renderOkfMessage({}, 'safety_products_paused'))
          : undefined,
      };
      const parsed = CARD_TYPES.guide.state.safeParse(state);
      if (parsed.success && sections.every((section: any) => section.title && section.body)) {
        const cardId = `card_okf_safety_${Date.now()}`;
        if (this.cardAllowed(release, 'guide')) {
          uiInstructions.push({
            actionId: cardId,
            component: 'guide',
            placement: 'inline',
            props: parsed.data,
            envelope: {
              name: 'presentCard',
              arguments: {
                card: { id: cardId, cardType: 'guide', state: parsed.data },
              },
            },
          });
        }
        assistantMessage = [
          state.heading,
          ...sections.map((section: any) =>
            `${section.title}: ${section.body}${section.steps?.[0] ? ` (${section.steps[0]})` : ''}`
          ),
          state.safety,
        ].filter(Boolean).join('\n\n');
        return {
          workspace,
          decision,
          assistantMessage,
          uiInstructions,
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }

      return {
        workspace,
        decision: {
          ...decision,
          type: 'fail',
          payload: { error: String(safetyGuidance?.renderFailedMessage || renderOkfMessage({}, 'safety_render_failed')) },
          reason: String(safetyGuidance?.renderFailedMessage || renderOkfMessage({}, 'safety_render_failed')),
        },
        assistantMessage: String(safetyGuidance?.unavailableMessage || renderOkfMessage({}, 'safety_unavailable_customer')),
        uiInstructions: [],
        executedCapabilities: [],
        trace: {
          stage: workspace.currentStage,
          transitions: [],
          decisionsMade: [decision],
        },
      };
    }

    // ── 1. ASK FACT / CLARIFICATION CARD ──────────────────────────────────
    if (decision.type === 'ask_fact') {
      const targetFact = decision.payload.targetFact || decision.payload.missingFacts?.[0] || 'fact';
      const questionText =
        decision.payload.question ||
        `To assist you with your request, could you please specify: ${targetFact.replace(/_/g, ' ')}?`;
      const targetOptions: string[] = Array.isArray(decision.payload.options) ? decision.payload.options : [];
      const multi = Boolean(decision.payload.multi);

      const rawQuestions =
        Array.isArray(decision.payload.questions) && decision.payload.questions.length > 0
          ? decision.payload.questions.slice(0, 3)
          : [
              {
                id: targetFact,
                text: questionText,
                options: targetOptions,
                multi,
                inputType: decision.payload.inputType || 'single_select',
                unit: decision.payload.unit,
                placeholder: decision.payload.placeholder,
              },
            ];

      const questionsList = rawQuestions.map((q: any) => ({
        id: q.id || q.key || targetFact,
        text: q.text || q.question || `Could you please specify your ${(q.id || targetFact).replace(/_/g, ' ')}?`,
        options: Array.isArray(q.options) ? q.options : [],
        multi: Boolean(q.multi),
        inputType: q.inputType || 'single_select',
        ...(q.unit ? { unit: q.unit } : {}),
        ...(q.placeholder ? { placeholder: q.placeholder } : {}),
      }));

      const cleanMsg = (options?.assistantMessage || '').trim();
      const isJsonMsg = cleanMsg.startsWith('{') && cleanMsg.endsWith('}');
      if (cleanMsg.length > 0 && !isJsonMsg) {
        assistantMessage = cleanMsg;
      } else {
        assistantMessage = questionsList.map((q) => q.text).join(' ');
      }

      const cardId = `card_clarify_${Date.now()}`;
      const totalMissing = decision.payload.allMissingFacts?.length || decision.payload.missingFacts?.length || questionsList.length;
      const clarifyState = {
        questions: questionsList,
        progress: `${totalMissing} detail${totalMissing > 1 ? 's' : ''} needed`,
      };

      const parsed = CARD_TYPES.clarify.state.safeParse(clarifyState);
      if (parsed.success && this.cardAllowed(release, 'clarify')) {
        uiInstructions.push({
          actionId: cardId,
          component: 'clarify',
          placement: 'inline',
          props: parsed.data,
          envelope: {
            name: 'presentCard',
            arguments: {
              card: {
                id: cardId,
                cardType: 'clarify',
                state: parsed.data,
              },
            },
          },
        });
      }

      const hasGroundedProducts =
        Boolean(validated.outcome?.products && validated.outcome.products.length > 0) ||
        Boolean(validated.outcome?.bundle && validated.outcome.bundle.items && validated.outcome.bundle.items.length > 0) ||
        Boolean(Array.isArray(workspace.facts?.['catalog_results']?.value) && workspace.facts['catalog_results'].value.length > 0);

      if (!hasGroundedProducts) {
        return {
          workspace,
          decision,
          assistantMessage,
          uiInstructions,
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }
    }

    // ── 2. FAILURE / DENIAL / INVALID OUTCOME COMPOSITION ──────────────────
    if (decision.type === 'fail' || !validated.valid) {
      let failReason =
        decision.reason ||
        decision.payload?.error ||
        validated.notes ||
        'The requested action could not be completed safely.';
      if (failReason.includes("Stage '") || failReason.includes("Capability '") || failReason.includes("requires input")) {
        failReason = 'Please clarify your project details or speak with a specialist.';
      }
      if (failReason.includes('No matching journey found') || failReason.includes('No active journey matched')) {
        const companyName = release.profile?.companyName || release.manifest?.name || 'our';
        const industry = release.profile?.industry || 'building supplies, trade materials, and home renovations';
        const customerQuery = (options as any)?.customerQuery?.trim();
        if (assistantMessage) {
          // Keep LLM generated out-of-scope response if provided!
        } else if (customerQuery) {
          const configuredJourneys = release.journeys
            .map((journey) => journey.displayName)
            .filter(Boolean)
            .join(', ');
          assistantMessage = `I'm your ${companyName} consultant. That request is outside our configured ${industry} offering. ${
            configuredJourneys ? `I can help with: ${configuredJourneys}.` : 'How can I help with one of our configured products or services?'
          }`;
        } else {
          const defaultGreeting =
            (release as any).persona?.greeting ||
            (release.agents && (release.agents[0] as any)?.greeting) ||
            `Hello! I'm your ${companyName} consultant. How can I help you with your project today?`;
          assistantMessage = defaultGreeting;
        }
      } else {
        assistantMessage = `I was unable to complete that action safely. ${failReason}`;
      }

      return {
        workspace,
        decision,
        assistantMessage,
        uiInstructions: [], // Suppress all success cards on failure/denial
        executedCapabilities: [],
        trace: {
          stage: workspace.currentStage,
          transitions: [],
          decisionsMade: [decision],
        },
      };
    }

    // ── 3. REQUIRES APPROVAL (ACTION BUTTON GROUP) ─────────────────────────
    if (decision.type === 'requires_approval') {
      const toolName = decision.payload.displayName || decision.payload.toolId || 'the requested capability';
      assistantMessage = `⚠️ **Approval Required**: Please confirm if you would like to execute **${toolName}**.`;

      const cardId = `card_approval_${Date.now()}`;
      const btnProps = {
        heading: 'Approval Required',
        description: `Please confirm if you would like to execute ${toolName}.`,
        actions: [
          { id: 'confirm_execution', label: 'Approve & Proceed', primary: true, variant: 'primary' as const },
          { id: 'cancel_execution', label: 'Cancel', primary: false, variant: 'secondary' as const },
        ],
        buttons: [
          { id: 'confirm_execution', label: 'Approve & Proceed', primary: true, variant: 'primary' as const },
          { id: 'cancel_execution', label: 'Cancel', primary: false, variant: 'secondary' as const },
        ],
      };

      const parsed = CARD_TYPES.action_button_group.state.safeParse(btnProps);
      const stateToUse = parsed.success ? parsed.data : btnProps;

      if (this.cardAllowed(release, 'action_button_group')) {
        uiInstructions.push({
          actionId: cardId,
          component: 'action_button_group',
          placement: 'inline',
          props: stateToUse,
          envelope: {
            name: 'presentCard',
            arguments: {
              card: {
                id: cardId,
                cardType: 'action_button_group',
                state: stateToUse,
              },
            },
          },
        });
      }
    }

    // ── 4. GROUNDED RECOMMENDATION BUNDLE ─────────────────────────────────
    if (validated.outcome && validated.outcome.bundle) {
      const bundle = validated.outcome.bundle;

      // Grounded Currency Check — No fabricated USD default
      const currency = bundle.currency || release.profile?.primaryCurrency;
      if (!currency || typeof currency !== 'string' || currency.trim() === '') {
        return {
          workspace,
          decision,
          assistantMessage: 'Unable to present recommendation: grounded currency is not specified in bundle or release profile.',
          uiInstructions: [],
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }

      const rawItems = Array.isArray(bundle.items) ? bundle.items : [];
      let ungroundedItem = false;

      const items = rawItems.map((item: any) => {
        const sku = item.sku;
        const title = item.name || item.title;

        // Grounded Identifiers Check — No fabricated ITEM-1 or Item
        if (!sku || typeof sku !== 'string' || sku.trim() === '' || !title || typeof title !== 'string' || title.trim() === '') {
          ungroundedItem = true;
        }

        return {
          sku: String(sku),
          title: String(title),
          description: item.description,
          imageUrl: item.imageUrl || null,
          price: Number(item.priceCents || item.price || 0) / (item.priceCents !== undefined ? 100 : 1),
          currency,
          brand: item.brand,
          category: item.category,
          attributes: item.attributes,
          badges: Array.isArray(item.certifications) ? item.certifications : undefined,
        };
      });

      if (ungroundedItem || items.length === 0) {
        return {
          workspace,
          decision,
          assistantMessage: 'Unable to present recommendation: bundle contains ungrounded or missing item identifiers.',
          uiInstructions: [],
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }

      // Derive Presentation from Pack Policy
      const heading =
        bundle.heading ||
        release.experience?.theme?.customCssVars?.['bundle_heading'] ||
        (release.experience as any)?.cards?.heading ||
        release.manifest.name;

      const why =
        bundle.why ||
        release.experience?.theme?.customCssVars?.['bundle_why'] ||
        (release.experience as any)?.cards?.why ||
        release.manifest.description;

      const closing =
        bundle.closing ||
        (release.experience as any)?.cards?.closing ||
        (release.profile as any)?.closingSurface;

      const formattedTotal = `${((bundle.totalPriceCents || 0) / 100).toFixed(2)} ${currency}`;

      const state: any = {
        heading,
        items,
        totals: {
          subtotal: (bundle.totalPriceCents || 0) / 100,
          total: (bundle.totalPriceCents || 0) / 100,
          currency,
        },
      };

      if (why) state.why = why;
      if (closing) state.closing = closing;

      const parsed = CARD_TYPES.bundle.state.safeParse(state);
      if (parsed.success && this.cardAllowed(release, 'bundle')) {
        const cardId = `card_bundle_${Date.now()}`;
        assistantMessage = `Verified options: ${items.length} item(s) matching criteria. Total: **${formattedTotal}**.`;
        uiInstructions.push({
          actionId: cardId,
          component: 'bundle',
          placement: 'inline',
          props: parsed.data,
          envelope: {
            name: 'presentCard',
            arguments: {
              card: {
                id: cardId,
                cardType: 'bundle',
                state: parsed.data,
              },
            },
          },
        });
      }
    }

    // ── 4b. GROUNDED PRODUCTS CARD (SEARCH RESULTS) ───────────────────────
    const capabilityId = String(
      options?.capability?.toolId || decision.targetCapability || decision.payload?.toolId || ''
    );
    const capabilityPayload = options?.capability?.payload || decision.payload || {};
    const isCatalogCapability = ['catalog.search', 'catalog-search', 'products'].includes(capabilityId);
    const catalogFact = workspace.facts?.['catalog_results']?.value;
    const searchItems =
      validated.outcome?.products ||
      (isCatalogCapability && !validated.outcome?.bundle && validated.outcome?.items) ||
      (isCatalogCapability && !validated.outcome?.bundle && decision.payload?.products) ||
      (isCatalogCapability && !validated.outcome?.bundle && decision.payload?.items) ||
      (isCatalogCapability && !validated.outcome?.bundle && Array.isArray(catalogFact) ? catalogFact : (catalogFact?.items || catalogFact?.products));

    if (Array.isArray(searchItems) && searchItems.length > 0 && !validated.outcome?.bundle) {
      const itemCurrencies = new Set(
        searchItems
          .map((item: any) => item?.currency || item?.price?.currency)
          .map((value: unknown) => String(value || '').trim().toUpperCase())
          .filter(Boolean)
      );
      if (itemCurrencies.size > 1) {
        return {
          workspace,
          decision,
          assistantMessage: 'Unable to present catalog items because the verified results contain mixed currencies.',
          uiInstructions: [],
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }
      const itemCurrency = itemCurrencies.values().next().value as string | undefined;
      const currency = validated.outcome?.currency || release.profile?.primaryCurrency || itemCurrency;
      if (!currency) {
        return {
          workspace,
          decision,
          assistantMessage: 'Unable to present catalog items because the published configuration has no currency.',
          uiInstructions: [],
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage,
            transitions: [],
            decisionsMade: [decision],
          },
        };
      }
      const validProducts: any[] = [];
      const seenSkus = new Set<string>();

      for (let i = 0; i < searchItems.length; i++) {
        const item = searchItems[i];
        if (!item) continue;
        const sku = String(item.sku || item.id || '').trim();
        const title = String(item.title || item.name || '').trim();

        // Grounded check: must have SKU and title
        if (!sku || !title) {
          continue;
        }

        // Deduplicate SKUs
        if (seenSkus.has(sku)) {
          continue;
        }
        seenSkus.add(sku);

        let price: number | null = null;
        if (item.priceCents !== undefined && item.priceCents !== null) {
          price = Number(item.priceCents) / 100;
        } else if (item.price && typeof item.price === 'object') {
          if (item.price.amountCents !== undefined && item.price.amountCents !== null) {
            price = Number(item.price.amountCents) / 100;
          } else if (item.price.amount !== undefined && item.price.amount !== null) {
            price = Number(item.price.amount);
          }
        } else if (typeof item.price === 'number') {
          price = item.price;
        } else if (typeof item.price === 'string' && !isNaN(Number(item.price))) {
          price = Number(item.price);
        }

        const imageUrl = item.imageUrl || item.image || null;

        validProducts.push({
          sku,
          title,
          price,
          currency,
          imageUrl,
          recommended: validProducts.length === 0,
          reason: item.reason || item.description || (item.category ? `Category: ${item.category}` : undefined),
        });
      }

      if (validProducts.length > 0) {
        const cardId = `card_products_${Date.now()}`;
        const heading =
          validated.outcome?.heading ||
          capabilityPayload.heading ||
          (release.experience as any)?.cards?.heading ||
          'Matching Products';

        const productsState = {
          heading,
          products: validProducts,
        };

        const parsed = CARD_TYPES.products.state.safeParse(productsState);
        if (parsed.success && this.cardAllowed(release, 'products')) {
          if (!assistantMessage || assistantMessage.includes('Could you please specify')) {
            const companyName = release.profile?.companyName || release.manifest?.name || '';
            const companySuffix = companyName ? ` from the ${companyName} catalog` : '';
            assistantMessage = `Here are our recommended options${companySuffix}. To help plan your project and ensure everything fits seamlessly, could you please confirm a few details below?`;
          }
          const productInst: UIInstruction = {
            actionId: cardId,
            component: 'products',
            placement: 'inline',
            props: parsed.data,
            envelope: {
              name: 'presentCard',
              arguments: {
                card: {
                  id: cardId,
                  cardType: 'products',
                  state: parsed.data,
                },
              },
            },
          };

          const clarifyIndex = uiInstructions.findIndex((inst) => inst.component === 'clarify');
          if (clarifyIndex !== -1) {
            uiInstructions.splice(clarifyIndex, 0, productInst);
          } else {
            uiInstructions.push(productInst);
          }
        }
      }
    }

    // ── 5. PINNED EVIDENCE CARDS ──────────────────────────────────────────
    const knowledgeScope = capabilityPayload.knowledgeScope;
    const evidenceItems = validated.outcome?.verified === true
      ? (Array.isArray(validated.outcome?.results)
        ? validated.outcome.results
        : Array.isArray(validated.outcome?.documents)
        ? validated.outcome.documents
        : [])
      : [];
    if (knowledgeScope && evidenceItems.length > 0) {
      const uniqueEvidence = evidenceItems.filter((item: any, index: number, list: any[]) => {
        const key = `${item.sourceId || ''}:${item.title || item.id || ''}`;
        return item.sourceId && item.releaseId === knowledgeScope.releaseId &&
          list.findIndex((candidate: any) => `${candidate.sourceId || ''}:${candidate.title || candidate.id || ''}` === key) === index;
      });
      if (uniqueEvidence.length > 0 && knowledgeScope.requestedClaimClass === 'warranty') {
        const state = {
          items: uniqueEvidence.map((item: any) => ({
            title: String(item.title || item.id).trim(),
            text: String(item.content || item.summary || '').trim(),
            ...(item.url || item.sourceUrl ? { url: item.url || item.sourceUrl } : {}),
          })),
        };
        const parsed = CARD_TYPES.warranty.state.safeParse(state);
        if (parsed.success && parsed.data.items.every((item) => item.title && item.text) && this.cardAllowed(release, 'warranty')) {
          const cardId = `card_warranty_${Date.now()}`;
          uiInstructions.push({
            actionId: cardId,
            component: 'warranty',
            placement: 'inline',
            props: parsed.data,
            envelope: { name: 'presentCard', arguments: { card: { id: cardId, cardType: 'warranty', state: parsed.data } } },
          });
        }
      } else if (uniqueEvidence.length > 0) {
        const state = {
          heading: String(validated.outcome?.heading || uniqueEvidence[0].title || 'Verified guidance'),
          sections: uniqueEvidence.map((item: any) => ({
            title: String(item.title || item.id).trim(),
            body: String(item.content || item.summary || '').trim(),
          })),
        };
        const parsed = CARD_TYPES.guide.state.safeParse(state);
        if (parsed.success && parsed.data.sections.every((section) => section.title && section.body) && this.cardAllowed(release, 'guide')) {
          const cardId = `card_evidence_${Date.now()}`;
          uiInstructions.push({
            actionId: cardId,
            component: 'guide',
            placement: 'inline',
            props: parsed.data,
            envelope: { name: 'presentCard', arguments: { card: { id: cardId, cardType: 'guide', state: parsed.data } } },
          });
        }
      }
    }

    const money = (value: unknown, centsValue?: unknown): number | undefined => {
      if (centsValue !== undefined && centsValue !== null && Number.isFinite(Number(centsValue))) {
        return Number(centsValue) / 100;
      }
      return value !== undefined && value !== null && Number.isFinite(Number(value))
        ? Number(value)
        : undefined;
    };
    const quoteLines = (items: any[], currency: string): any[] | null => {
      const normalized = items.map((item: any) => {
        const sku = String(item?.sku || '').trim();
        const title = String(item?.title || item?.name || '').trim();
        const qty = Number(item?.quantity ?? item?.qty);
        if (!sku || !title || !Number.isInteger(qty) || qty < 1) return null;
        const price = money(item.unitPrice ?? item.price, item.unitPriceCents ?? item.priceCents);
        const lineTotal = money(item.lineTotal ?? item.totalPrice, item.lineTotalCents ?? item.totalPriceCents);
        return {
          sku,
          title,
          qty,
          currency,
          ...(price !== undefined ? { price } : {}),
          ...(lineTotal !== undefined ? { lineTotal } : {}),
          ...(item.description ? { description: String(item.description) } : {}),
          ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        };
      });
      return normalized.every(Boolean) ? normalized : null;
    };

    // ── 6. AUTHORITATIVE QUOTE / CART CARDS ──────────────────────────────
    const quote = validated.outcome?.quote || (
      validated.outcome?.quoteId && Array.isArray(validated.outcome?.items) ? validated.outcome : undefined
    );
    if (quote && (capabilityId.includes('quote') || validated.outcome?.quote)) {
      const currency = String(quote.currency || '').trim().toUpperCase();
      const lines = currency ? quoteLines(quote.lines || quote.items || [], currency) : null;
      const subtotal = money(quote.subtotal, quote.subtotalCents);
      const total = money(quote.total ?? quote.totalAmount, quote.totalCents ?? quote.totalAmountCents);
      if (currency && lines?.length && subtotal !== undefined && total !== undefined) {
        const state = {
          quoteId: String(quote.quoteId),
          heading: quote.heading || release.manifest.name,
          lines,
          totals: { subtotal, total, currency },
          ...(quote.fulfilment ? { fulfilment: quote.fulfilment } : {}),
          ...(Array.isArray(quote.notes) ? { notes: quote.notes } : {}),
          ...(quote.compliance ? { compliance: quote.compliance } : {}),
          ...(quote.ctaLabel ? { ctaLabel: quote.ctaLabel } : {}),
          ...(quote.linesLabel ? { linesLabel: quote.linesLabel } : {}),
        };
        const parsed = CARD_TYPES.quote.state.safeParse(state);
        if (parsed.success && this.cardAllowed(release, 'quote')) {
          const cardId = `card_quote_${Date.now()}`;
          uiInstructions.push({
            actionId: cardId,
            component: 'quote',
            placement: 'inline',
            props: parsed.data,
            envelope: { name: 'presentCard', arguments: { card: { id: cardId, cardType: 'quote', state: parsed.data } } },
          });
        }
      }
    }

    const cart = validated.outcome?.cart;
    if (cart && capabilityId.includes('cart')) {
      const totalsInput = cart.totals || validated.outcome?.totals;
      const currency = String(totalsInput?.currency || cart.currency || '').trim().toUpperCase();
      const lines = currency ? quoteLines(cart.lines || cart.items || [], currency) : null;
      const subtotal = money(totalsInput?.subtotal, totalsInput?.subtotalCents);
      const total = money(totalsInput?.total, totalsInput?.totalCents);
      if (currency && lines?.length && subtotal !== undefined && total !== undefined) {
        const parsed = CARD_TYPES.cart.state.safeParse({
          lines,
          totals: { ...totalsInput, subtotal, total, currency },
        });
        if (parsed.success && this.cardAllowed(release, 'cart')) {
          const cardId = `card_cart_${Date.now()}`;
          uiInstructions.push({
            actionId: cardId,
            component: 'cart',
            placement: 'inline',
            props: parsed.data,
            envelope: { name: 'presentCard', arguments: { card: { id: cardId, cardType: 'cart', state: parsed.data } } },
          });
        }
      }
    }

    // ── 7. VERIFIED PROJECT MATERIALS ─────────────────────────────────────
    if (validated.outcome?.ok === true && Array.isArray(validated.outcome?.materials) && capabilityId.toLowerCase().includes('project')) {
      const currency = String(validated.outcome.currency || '').trim().toUpperCase() || undefined;
      const items = validated.outcome.materials.flatMap((item: any) => {
        const sku = String(item?.sku || '').trim();
        const title = String(item?.title || item?.name || '').trim();
        if (!sku || !title || item.catalogVerified !== true) return [];
        return [{
          sku,
          title,
          description: item.description,
          qty: Number(item.quantity),
          price: item.pricingVerified === true ? item.unitPrice : undefined,
          currency: item.pricingVerified === true ? (item.currency || currency) : undefined,
          attributes: item.attributes,
        }];
      });
      if (items.length === validated.outcome.materials.length && items.length > 0) {
        const state: any = {
          heading: validated.outcome.projectName || validated.outcome.projectType,
          items,
          why: Array.isArray(validated.outcome.verifiedNotes)
            ? validated.outcome.verifiedNotes.join(' ')
            : undefined,
        };
        if (validated.outcome.pricingComplete === true && currency && Number.isFinite(Number(validated.outcome.total))) {
          state.totals = { subtotal: Number(validated.outcome.total), total: Number(validated.outcome.total), currency };
        }
        const parsed = CARD_TYPES.bundle.state.safeParse(state);
        if (parsed.success && this.cardAllowed(release, 'bundle')) {
          const cardId = `card_project_bundle_${Date.now()}`;
          uiInstructions.push({
            actionId: cardId,
            component: 'bundle',
            placement: 'inline',
            props: parsed.data,
            envelope: { name: 'presentCard', arguments: { card: { id: cardId, cardType: 'bundle', state: parsed.data } } },
          });
        }
      }
    }

    // ── 8. GROUNDED ORDER CONFIRMATION ────────────────────────────────────
    const directOrder = validated.outcome?.orderId ? validated.outcome : undefined;
    if (validated.outcome && (validated.outcome.order || directOrder)) {
      const order = validated.outcome.order || directOrder;
      const cardId = `card_order_${Date.now()}`;
      const total = order.totalCents !== undefined || order.totalPriceCents !== undefined
        ? Number(order.totalCents ?? order.totalPriceCents) / 100
        : order.total !== undefined
        ? Number(order.total)
        : undefined;

      const rawOrderItems = Array.isArray(order.items) ? order.items : [];
      const orderLines = rawOrderItems.flatMap((it: any) => {
        const sku = String(it?.sku || it?.id || '').trim();
        const title = String(it?.title || it?.name || '').trim();
        const qty = Number(it?.quantity ?? it?.qty);
        if (!sku || !title || !Number.isInteger(qty) || qty < 1) return [];
        return [{
          sku,
          title,
          qty,
          lineTotal: money(it.lineTotal ?? it.totalPrice, it.lineTotalCents ?? it.totalPriceCents),
        }];
      });

      const orderProps = {
        orderId: order.orderId,
        currency: order.currency,
        totalPriceCents: order.totalPriceCents,
        total,
        status: order.status,
        items: order.items,
        lines: orderLines.length === rawOrderItems.length && orderLines.length > 0 ? orderLines : undefined,
        committedAt: order.committedAt || order.createdAt,
      };

      const parsed = CARD_TYPES.order_confirmation.state.safeParse(orderProps);
      if (parsed.success && order.orderId && order.status && this.cardAllowed(release, 'order_confirmation')) {
        uiInstructions.push({
          actionId: cardId,
          component: 'order_confirmation',
          placement: 'inline',
          props: parsed.data,
          envelope: {
            name: 'presentCard',
            arguments: {
              card: {
                id: cardId,
                cardType: 'order_confirmation',
                state: parsed.data,
              },
            },
          },
        });
      }
    }

    // ── 9. TRUTHFUL STATE REPLIES (ZERO FABRICATED SUCCESS) ───────────────
    if (!assistantMessage) {
      if ((decision as any).type === 'ask_fact' && (decision as any).payload?.question) {
        assistantMessage = (decision as any).payload.question;
      } else {
        const rawMsg = decision.reason || '';
        if (rawMsg && !rawMsg.includes("Stage '") && !rawMsg.includes("Capability '") && !rawMsg.includes("requires input") && !rawMsg.includes("policyId")) {
          assistantMessage = rawMsg;
        } else {
          assistantMessage =
            (release.experience as any)?.welcomeMessage ||
            (release.vocabulary as any)?.welcomeMessage ||
            `Kia ora! How can I assist you with your project today?`;
        }
      }
    }

    return {
      workspace,
      decision,
      assistantMessage,
      uiInstructions,
      executedCapabilities: [],
      trace: {
        stage: workspace.currentStage,
        transitions: [],
        decisionsMade: [decision],
      },
    };
  }
}
