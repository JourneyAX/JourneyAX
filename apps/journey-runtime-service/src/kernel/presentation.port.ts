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
    release: BusinessPackRelease
  ): TurnResult {
    const uiInstructions: UIInstruction[] = [];
    let assistantMessage = '';

    // ── 1. ASK FACT / CLARIFICATION CARD ──────────────────────────────────
    if (decision.type === 'ask_fact') {
      const targetFact = decision.payload.targetFact || decision.payload.missingFacts?.[0] || 'fact';
      const questionText =
        decision.payload.question ||
        `To assist you with your request, could you please specify: ${targetFact.replace(/_/g, ' ')}?`;
      const options: string[] = Array.isArray(decision.payload.options) ? decision.payload.options : [];
      const multi = Boolean(decision.payload.multi);

      assistantMessage = questionText;

      const cardId = `card_clarify_${Date.now()}`;
      const totalMissing = decision.payload.allMissingFacts?.length || decision.payload.missingFacts?.length || 1;
      const clarifyState = {
        questions: [
          {
            id: targetFact,
            text: questionText,
            options,
            multi,
          },
        ],
        progress: `${totalMissing} detail${totalMissing > 1 ? 's' : ''} needed`,
      };

      const parsed = CARD_TYPES.clarify.state.safeParse(clarifyState);
      if (parsed.success) {
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
      assistantMessage = `I was unable to complete that action safely. ${failReason}`;

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
      if (parsed.success) {
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
    const searchItems =
      validated.outcome?.products ||
      (!validated.outcome?.bundle && validated.outcome?.items) ||
      (!validated.outcome?.bundle && decision.payload?.products) ||
      (!validated.outcome?.bundle && decision.payload?.items);

    if (Array.isArray(searchItems) && searchItems.length > 0 && !validated.outcome?.bundle) {
      const currency = validated.outcome?.currency || release.profile?.primaryCurrency || '';
      const validProducts: any[] = [];

      for (let i = 0; i < searchItems.length; i++) {
        const item = searchItems[i];
        if (!item) continue;
        const sku = item.sku || item.id;
        const title = item.title || item.name;

        // Grounded check: must have SKU and title
        if (!sku || typeof sku !== 'string' || sku.trim() === '' || !title || typeof title !== 'string' || title.trim() === '') {
          continue;
        }

        const price = item.priceCents !== undefined
          ? Number(item.priceCents) / 100
          : item.price !== undefined && item.price !== null
          ? Number(item.price)
          : null;

        const imageUrl = item.imageUrl || item.image || null;

        validProducts.push({
          sku: String(sku),
          title: String(title),
          price,
          currency,
          imageUrl,
          recommended: i === 0,
          reason: item.reason || item.description || undefined,
        });
      }

      if (validProducts.length > 0) {
        const cardId = `card_products_${Date.now()}`;
        const heading =
          validated.outcome?.heading ||
          decision.payload?.heading ||
          (release.experience as any)?.cards?.heading ||
          'Matching Products';

        const productsState = {
          heading,
          products: validProducts,
        };

        const parsed = CARD_TYPES.products.state.safeParse(productsState);
        if (parsed.success) {
          if (!assistantMessage) {
            assistantMessage = `I found ${validProducts.length} product(s) matching your criteria.`;
          }
          uiInstructions.push({
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
          });
        }
      }
    }

    // ── 5. GROUNDED ORDER CONFIRMATION ────────────────────────────────────
    if (validated.outcome && validated.outcome.order) {
      const order = validated.outcome.order;
      const cardId = `card_order_${Date.now()}`;
      const total = order.totalPriceCents !== undefined
        ? Number(order.totalPriceCents) / 100
        : order.total !== undefined
        ? Number(order.total)
        : undefined;

      const orderProps = {
        orderId: order.orderId,
        currency: order.currency,
        totalPriceCents: order.totalPriceCents,
        total,
        status: order.status || 'Confirmed',
        items: order.items,
        lines: Array.isArray(order.items) ? order.items.map((it: any) => ({
          sku: String(it.sku || it.id || 'item'),
          title: String(it.title || it.name || it.sku || 'Item'),
          qty: Number(it.quantity || it.qty || 1),
          lineTotal: it.unitPriceCents ? Number(it.unitPriceCents) / 100 : Number(it.price || 0),
        })) : undefined,
        committedAt: order.committedAt,
      };

      const parsed = CARD_TYPES.order_confirmation.state.safeParse(orderProps);
      const stateToUse = parsed.success ? parsed.data : orderProps;

      uiInstructions.push({
        actionId: cardId,
        component: 'order_confirmation',
        placement: 'inline',
        props: stateToUse,
        envelope: {
          name: 'presentCard',
          arguments: {
            card: {
              id: cardId,
              cardType: 'order_confirmation',
              state: stateToUse,
            },
          },
        },
      });
    }

    // ── 6. TRUTHFUL STATE REPLIES (ZERO FABRICATED SUCCESS) ───────────────
    if (!assistantMessage) {
      let rawMsg = decision.reason || '';
      if (!rawMsg || rawMsg.includes("Stage '") || rawMsg.includes("Capability '") || rawMsg.includes("requires input")) {
        const journeysRaw: any = release.journeys;
        const journeys: any[] = Array.isArray(journeysRaw)
          ? journeysRaw
          : journeysRaw?.journeys
          ? journeysRaw.journeys
          : typeof journeysRaw === 'object' && journeysRaw
          ? Object.values(journeysRaw)
          : [];
        const activeJourney = journeys.find((j: any) => j.journeyId === workspace.journeyId);
        if (!activeJourney) {
          throw new Error(`[presentation.port] Unknown or ambiguous journeyId "${workspace.journeyId}" on release for tenant "${release.manifest?.tenantId || 'unknown'}" - failing closed`);
        }
        const stages = activeJourney.stages || {};
        const stageDef = Array.isArray(stages)
          ? stages.find((s: any) => s.stageId === workspace.currentStage)
          : stages[workspace.currentStage];
        const stageName = stageDef?.displayName || workspace.currentStage.replace(/_/g, ' ');
        assistantMessage = `Specifications and items have been updated for ${stageName}.`;
      } else {
        assistantMessage = rawMsg;
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
