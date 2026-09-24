import { TurnResult, UIInstruction, WorkspaceState, Decision } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { CARD_TYPES } from '@journeyax/ui-cards';

export interface ValidatedTurnOutcome {
  valid: boolean;
  outcome?: any;
  error?: string;
  violations?: string[];
}

export class PresentationPort {
  compose(
    validated: ValidatedTurnOutcome,
    decision: Decision,
    workspace: WorkspaceState,
    release: BusinessPackRelease
  ): TurnResult {
    const uiInstructions: UIInstruction[] = [];
    let assistantMessage = '';

    if (decision.type === 'ask_fact') {
      const missing: string[] = decision.payload.missingFacts || [];
      const humanMissing = missing.map((m) => m.replace(/_/g, ' ')).join(', ');
      assistantMessage = `To assist you with your request, could you please specify: ${humanMissing}?`;

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

    if (decision.type === 'requires_approval') {
      const toolName = decision.payload.displayName || decision.payload.toolId || 'the requested action';
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
    } else if (decision.type === 'fail') {
      assistantMessage = `I was unable to complete that action safely. ${decision.reason || ''}`;
    } else if (validated.outcome?.status === 'insufficient_verified_results') {
      const missing = Array.isArray(validated.outcome.missing)
        ? ` Missing verified criteria: ${validated.outcome.missing.join(', ')}.`
        : '';
      assistantMessage = `I could not find verified items satisfying all criteria.${missing} No unverified substitute has been suggested.`;
    }

    // ── Present Domain-Neutral Recommendation Bundle ──
    if (validated.outcome && validated.outcome.bundle) {
      const bundle = validated.outcome.bundle;
      const currency = bundle.currency || 'USD';
      const formattedTotal = `$${((bundle.totalPriceCents || 0) / 100).toFixed(2)} ${currency}`;

      // Pure generic items handling
      const rawItems = Array.isArray(bundle.items) ? bundle.items : [];
      const items = rawItems.map((item: any) => ({
        sku: String(item.sku),
        title: item.name || item.title || String(item.sku),
        description: item.description,
        imageUrl: item.imageUrl || null,
        price: Number(item.priceCents || 0) / 100,
        currency,
        brand: item.brand,
        category: item.category,
        attributes: item.attributes,
        badges: Array.isArray(item.certifications) ? item.certifications : undefined,
      }));

      const state = {
        heading: 'Verified recommendation',
        items,
        totals: {
          subtotal: (bundle.totalPriceCents || 0) / 100,
          total: (bundle.totalPriceCents || 0) / 100,
          currency,
        },
        why: 'Every item shown was verified against tenant records and requested constraints.',
        closing: 'quote',
      };

      const parsed = CARD_TYPES.bundle.state.safeParse(state);
      if (parsed.success) {
        const cardId = `card_bundle_${Date.now()}`;
        assistantMessage = `I found verified matching items. Total: **${formattedTotal}**.`;
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

    // ── Present Grounded Order Confirmation ──
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

    if (!assistantMessage) {
      assistantMessage = 'I have processed your request with verified business rules.';
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
