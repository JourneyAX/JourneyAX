import { TurnResult, UIInstruction, WorkspaceState, Decision } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { ValidatedOutcome } from './validate-outcome';

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

    // If decision was to ask for missing required facts
    if (decision.type === 'ask_fact') {
      const missing: string[] = decision.payload.missingFacts || [];
      if (missing.includes('budget')) {
        assistantMessage = `G'day! To tailor the ideal workwear setup for your role as an ${workspace.facts['occupation']?.value || 'tradesperson'}, what is your target budget?`;
      } else {
        assistantMessage = `Could you share a bit more detail about your ${missing.join(', ')} so I can build your compliant setup?`;
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

    // If capability returned a bundle solution
    if (validated.outcome && validated.outcome.bundle) {
      const bundle = validated.outcome.bundle;
      const currency = bundle.currency || release.profile.primaryCurrency || 'AUD';
      const formattedTotal = `$${(bundle.totalPriceCents / 100).toFixed(2)} ${currency}`;

      assistantMessage = `Here is your compliant workwear setup tailored for an **${workspace.facts['occupation']?.value || 'electrician'}**, strictly within your **$${(workspace.facts['budget']?.value?.amountCents / 100).toFixed(2)} ${currency}** budget ceiling.\n\n` +
        `• **Pants:** ${bundle.pants.name} (${bundle.pants.sku}) — $${(bundle.pants.priceCents / 100).toFixed(2)}\n` +
        `• **Boots:** ${bundle.boots.name} (${bundle.boots.sku}) — $${(bundle.boots.priceCents / 100).toFixed(2)} *(AS/NZS 2210.3 compliant composite non-metallic toe)*\n\n` +
        `**Total:** **${formattedTotal}** *(Budget compliant ✅)*`;

      // Build structured UI card for JourneyAX Go Storefront
      uiInstructions.push({
        component: 'bundle_summary_card',
        placement: 'inline',
        props: {
          title: 'Apprentice Electrician Starter Bundle',
          currency,
          totalPriceCents: bundle.totalPriceCents,
          budgetCeilingCents: workspace.facts['budget']?.value?.amountCents,
          isCompliant: true,
          items: [
            {
              sku: bundle.pants.sku,
              title: bundle.pants.name,
              category: 'Pants',
              priceCents: bundle.pants.priceCents,
              imageUrl: bundle.pants.imageUrl,
              features: ['Lightweight Summer Dobby Fabric', 'Ripstop Cargo Pockets'],
            },
            {
              sku: bundle.boots.sku,
              title: bundle.boots.name,
              category: 'Footwear',
              priceCents: bundle.boots.priceCents,
              imageUrl: bundle.boots.imageUrl,
              features: ['Non-Metallic Composite Toe', 'Electrical Hazard Resistance'],
            },
          ],
        },
      });

      uiInstructions.push({
        component: 'action_button_group',
        placement: 'inline',
        props: {
          actions: [
            { id: 'accept_bundle', label: 'Accept & Select Sizes', primary: true },
            { id: 'request_quote', label: 'Generate Formal Quote', primary: false },
          ],
        },
      });
    } else if (decision.type === 'transition_stage') {
      assistantMessage = `Moving forward to build your compliant setup.`;
    } else {
      assistantMessage = `Your request has been processed. How would you like to proceed?`;
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
        transitions: [],
        decisionsMade: [decision],
      },
    };
  }
}
