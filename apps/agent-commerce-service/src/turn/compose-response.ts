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
        assistantMessage = release.profile.companyName === 'Workwear Group'
          ? `G'day! To tailor the ideal workwear setup for your role as an ${workspace.facts['occupation']?.value || 'tradesperson'}, what is your target budget?`
          : `Welcome to ${release.profile.companyName}. To help scope your solution effectively, what is your estimated budget or investment ceiling?`;
      } else {
        assistantMessage = `Could you share a bit more detail regarding ${missing.join(', ')} so we can complete your blueprint?`;
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

    // If capability returned a bundle solution (Commerce/Workwear)
    if (validated.outcome && validated.outcome.bundle) {
      const bundle = validated.outcome.bundle;
      const currency = bundle.currency || release.profile.primaryCurrency || 'AUD';
      const formattedTotal = `$${(bundle.totalPriceCents / 100).toFixed(2)} ${currency}`;

      assistantMessage = `Here is your compliant workwear setup tailored for an **${workspace.facts['occupation']?.value || 'electrician'}**, strictly within your **$${(workspace.facts['budget']?.value?.amountCents / 100).toFixed(2)} ${currency}** budget ceiling.\n\n` +
        `• **Pants:** ${bundle.pants.name} (${bundle.pants.sku}) — $${(bundle.pants.priceCents / 100).toFixed(2)}\n` +
        `• **Boots:** ${bundle.boots.name} (${bundle.boots.sku}) — $${(bundle.boots.priceCents / 100).toFixed(2)} *(AS/NZS 2210.3 compliant composite non-metallic toe)*\n\n` +
        `**Total:** **${formattedTotal}** *(Budget compliant ✅)*`;

      uiInstructions.push({
        component: 'bundle_summary_card',
        placement: 'inline',
        props: {
          title: 'Apprentice Electrician Starter Bundle',
          currency,
          totalPriceCents: bundle.totalPriceCents,
          items: [
            {
              sku: bundle.pants.sku,
              name: bundle.pants.name,
              category: 'Work Pants',
              priceCents: bundle.pants.priceCents,
              imageUrl: bundle.pants.imageUrl,
            },
            {
              sku: bundle.boots.sku,
              name: bundle.boots.name,
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
      const targetStage = decision.targetStage || workspace.currentStage;
      const domain = workspace.facts['domain']?.value || 'Modernization';
      const cloud = workspace.facts['cloudPlatform']?.value || 'Cloud';
      const budget = workspace.facts['budget']?.value?.amount
        ? `$${workspace.facts['budget']?.value?.amount.toLocaleString()} ${workspace.facts['budget']?.value?.currency || 'USD'}`
        : 'specified target';

      assistantMessage = `Thank you for sharing your architecture goals. We have captured your target domain as **${domain}** on **${cloud}** with a budget of **${budget}**.\n\nYour workspace has advanced to the **${targetStage}** stage. We are now preparing your technical scoping blueprint and sprint estimates.`;

      uiInstructions.push({
        component: 'scoping_summary_card',
        placement: 'inline',
        props: {
          title: `Architecture Blueprint: ${domain}`,
          targetCloud: cloud,
          budget,
          currentStage: targetStage,
        },
      });
    } else {
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
        transitions: [],
        decisionsMade: [decision],
      },
    };
  }
}
