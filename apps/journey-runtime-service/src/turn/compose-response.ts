import { TurnResult, UIInstruction, WorkspaceState, Decision } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { ValidatedOutcome } from './validate-outcome';
import { CARD_TYPES } from '@journeyax/ui-cards';

export class PresentationComposer {
  /**
   * Composes grounded UI instructions and natural language response
   * from verified business state and validated capability outcomes.
   */
  async compose(
    validated: ValidatedOutcome,
    decision: Decision,
    workspace: WorkspaceState,
    release: BusinessPackRelease
  ): Promise<TurnResult> {
    const uiInstructions: UIInstruction[] = [];
    let assistantMessage = '';

    if (decision.type === 'ask_fact') {
      const missing: string[] = decision.payload.missingFacts || [];
      assistantMessage = `To continue, please provide: ${missing.join(', ')}.`;

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
      const toolName = decision.payload.displayName || decision.payload.toolId || 'the requested operation';
      assistantMessage = `⚠️ **Confirmation Required**: Please confirm whether you would like to proceed with **${toolName}**.`;
      uiInstructions.push({
        component: 'action_button_group',
        placement: 'inline',
        props: {
          actions: [
            { id: 'confirm_execution', label: 'Approve & Proceed', primary: true },
            { id: 'cancel_execution', label: 'Cancel', primary: false },
          ],
        },
      });
    } else if (decision.type === 'fail') {
      assistantMessage = `I couldn't complete that action safely. ${decision.reason}`;
    } else if (validated.outcome?.status === 'insufficient_verified_results') {
      const missing = Array.isArray(validated.outcome.missing)
        ? ` Missing verified criteria: ${validated.outcome.missing.join(', ')}.`
        : '';
      assistantMessage = `I couldn't find a fully verified result that satisfies all of the requested constraints.${missing} No substitute or unverified compliance claim has been used.`;
    }

    if (validated.outcome && validated.outcome.bundle) {
      const bundle = validated.outcome.bundle;
      const currency = bundle.currency || release.profile.primaryCurrency || 'AUD';
      const formattedTotal = `$${(bundle.totalPriceCents / 100).toFixed(2)} ${currency}`;
      const rawItems = Array.isArray(bundle.items)
        ? bundle.items
        : [bundle.pants, bundle.boots].filter(Boolean);
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
          subtotal: bundle.totalPriceCents / 100,
          total: bundle.totalPriceCents / 100,
          currency,
        },
        why: 'Every item shown was returned by the tenant catalog and validated against the requested constraints.',
        closing: 'bag',
      };
      const parsed = CARD_TYPES.bundle.state.safeParse(state);
      if (!parsed.success) {
        throw new Error(`Invalid bundle card state: ${parsed.error.message}`);
      }

      const cardId = `card_bundle_${Date.now()}`;
      assistantMessage = `I found a verified bundle within the requested budget. Total: **${formattedTotal}**.`;
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
    } else if (decision.type === 'transition_stage') {
      const targetStage = decision.targetStage || workspace.currentStage;
      assistantMessage = `Your workspace has advanced to the **${targetStage}** stage.`;
    } else if (!assistantMessage) {
      assistantMessage = `Your request has been processed. Current stage: ${workspace.currentStage}. How would you like to proceed?`;
    }

    return {
      workspace,
      decision,
      assistantMessage,
      uiInstructions,
      executedCapabilities: validated.outcome ? [
        {
          toolId: decision.targetCapability || 'capability.run',
          status: 'success',
          output: validated.outcome,
        },
      ] : [],
      trace: {
        stage: workspace.currentStage,
        transitions: decision.type === 'transition_stage' && decision.targetStage ? [
          {
            fromStage: workspace.currentStage,
            toStage: decision.targetStage,
            trigger: 'stage_exit_condition',
            reason: decision.reason,
            evaluatedAt: new Date().toISOString(),
          },
        ] : [],
        decisionsMade: [decision],
      },
    };
  }
}
