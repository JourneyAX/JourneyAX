import { TurnCommand, WorkspaceState, FactsMap, FactEntry } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export interface InterpretationResult {
  intent: string;
  candidateFacts: FactsMap;
  confidence: number;
}

export class TurnInterpreter {
  /**
   * Interprets incoming customer message or channel event against the Business Pack
   * vocabulary, slot definitions, and entities.
   */
  async interpret(
    command: TurnCommand,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): Promise<InterpretationResult> {
    const message = command.message || '';
    const lowerMsg = message.toLowerCase();
    const candidateFacts: FactsMap = {};

    // 1. Extract Occupation / Trade Fact
    const occupationMatch = lowerMsg.match(/(?:i['’]m an?|work as an?|role is)\s+([a-zA-Z\s]+?)(?:\.|\,|$|\s+i need|\s+looking for)/i);
    if (occupationMatch) {
      const occ = occupationMatch[1].trim();
      candidateFacts['occupation'] = {
        value: occ,
        source: 'customer',
        confidence: 0.95,
        extractedAt: new Date().toISOString(),
      };
    } else if (lowerMsg.includes('electrician')) {
      candidateFacts['occupation'] = {
        value: lowerMsg.includes('apprentice') ? 'apprentice electrician' : 'electrician',
        source: 'customer',
        confidence: 0.9,
        extractedAt: new Date().toISOString(),
      };
    }

    // 2. Extract Budget Constraint (e.g. "under $250", "$250 budget", "less than 250 AUD")
    const budgetMatch = lowerMsg.match(/(?:under|below|less than|max|budget(?: of)?)\s*\$?(\d+(?:\.\d{2})?)\s*(?:aud|dollars)?/i);
    if (budgetMatch) {
      const dollars = parseFloat(budgetMatch[1]);
      candidateFacts['budget'] = {
        value: {
          amountCents: Math.round(dollars * 100),
          currency: release.profile.primaryCurrency || 'AUD',
          scope: 'total',
        },
        source: 'customer',
        confidence: 0.98,
        extractedAt: new Date().toISOString(),
      };
    }

    // 3. Decompose Required Item Slots (e.g. pants, boots) using Business Pack vocabulary
    const detectedSlots: string[] = [];
    const slotSynonyms = release.vocabulary.slotSynonyms || {};

    for (const [canonicalSlot, synonyms] of Object.entries(slotSynonyms)) {
      const match = synonyms.some((syn) => lowerMsg.includes(syn.toLowerCase()));
      if (match) {
        detectedSlots.push(canonicalSlot);
      }
    }

    // Fallback checks if not configured in vocabulary
    if (!detectedSlots.includes('pants') && (lowerMsg.includes('pants') || lowerMsg.includes('cargos') || lowerMsg.includes('trousers'))) {
      detectedSlots.push('pants');
    }
    if (!detectedSlots.includes('boots') && (lowerMsg.includes('boots') || lowerMsg.includes('footwear') || lowerMsg.includes('shoes'))) {
      detectedSlots.push('boots');
    }

    if (detectedSlots.length > 0) {
      candidateFacts['required_item_types'] = {
        value: detectedSlots,
        source: 'customer',
        confidence: 0.95,
        extractedAt: new Date().toISOString(),
      };
    }

    // 4. Feature and Safety Constraint Extraction
    if (lowerMsg.includes('composite') || lowerMsg.includes('composite-toe')) {
      candidateFacts['safety_spec'] = {
        value: 'composite_toe',
        source: 'customer',
        confidence: 0.95,
        extractedAt: new Date().toISOString(),
      };
    }
    if (lowerMsg.includes('lightweight') || lowerMsg.includes('summer')) {
      candidateFacts['fabric_spec'] = {
        value: 'lightweight_summer',
        source: 'customer',
        confidence: 0.9,
        extractedAt: new Date().toISOString(),
      };
    }

    // Merge any programmatic inputFacts directly
    if (command.inputFacts) {
      for (const [k, v] of Object.entries(command.inputFacts)) {
        candidateFacts[k] = {
          value: v,
          source: 'system',
          confidence: 1.0,
          extractedAt: new Date().toISOString(),
        };
      }
    }

    return {
      intent: detectedSlots.length > 0 ? 'build_solution' : 'general_inquiry',
      candidateFacts,
      confidence: 0.92,
    };
  }
}
