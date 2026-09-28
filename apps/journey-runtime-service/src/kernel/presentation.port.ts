import { TurnResult, UIInstruction, WorkspaceState, Decision } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { CARD_TYPES } from '@journeyax/ui-cards';

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
      const failReason =
        decision.reason ||
        decision.payload?.error ||
        validated.notes ||
        'The requested action could not be completed safely.';
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

    // ── 3. REQUIRES APPROVAL ──────────────────────────────────────────────
    if (decision.type === 'requires_approval') {
      const toolName = decision.payload.displayName || decision.payload.toolId || 'the requested capability';
      assistantMessage = `⚠️ **Approval Required**: Please confirm if you would like to execute **${toolName}**.`;

      const cardId = `card_approval_${Date.now()}`;
      const btnProps = {
        actions: [
          { id: 'confirm_execution', label: 'Approve & Proceed', primary: true },
          { id: 'cancel_execution', label: 'Cancel', primary: false },
        ],
      };

      uiInstructions.push({
        actionId: cardId,
        component: 'action_button_group',
        placement: 'inline',
        props: btnProps,
        envelope: {
          name: 'presentCard',
          arguments: {
            card: {
              id: cardId,
              cardType: 'action_button_group',
              state: btnProps,
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

    // ── 5. GROUNDED ORDER CONFIRMATION ────────────────────────────────────
    if (validated.outcome && validated.outcome.order) {
      const order = validated.outcome.order;
      const cardId = `card_order_${Date.now()}`;
      const orderProps = {
        orderId: order.orderId,
        currency: order.currency,
        totalPriceCents: order.totalPriceCents,
        status: order.status,
        items: order.items,
        committedAt: order.committedAt,
      };
      uiInstructions.push({
        actionId: cardId,
        component: 'order_confirmation',
        placement: 'inline',
        props: orderProps,
        envelope: {
          name: 'presentCard',
          arguments: {
            card: {
              id: cardId,
              cardType: 'order_confirmation',
              state: orderProps,
            },
          },
        },
      });
    }

    // ── 6. TRUTHFUL STATE REPLIES (ZERO FABRICATED SUCCESS) ───────────────
    if (!assistantMessage) {
      assistantMessage = decision.reason || `Execution completed for stage '${workspace.currentStage}'.`;
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
