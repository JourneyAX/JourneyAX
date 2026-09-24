import { TurnCommand, WorkspaceState, FactsMap } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export interface InterpretationResult {
  intent: string;
  candidateFacts: FactsMap;
  confidence: number;
}

export class TurnInterpreter {
  /**
   * Domain-neutral turn interpreter. Extracts facts and intents dynamically
   * from the Business Pack vocabulary, slot synonyms, and entity schemas.
   * Contains zero hardcoded industry/tenant terms.
   */
  async interpret(
    command: TurnCommand,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): Promise<InterpretationResult> {
    const rawMessage = command.message || (command as any).userInput || '';
    const lowerMsg = rawMessage.toLowerCase();
    const candidateFacts: FactsMap = {};

    // 1. Dynamic slotSynonyms extraction from Business Pack
    const slotSynonyms = release.vocabulary?.slotSynonyms || {};
    for (const [slotKey, synonyms] of Object.entries(slotSynonyms)) {
      if (!Array.isArray(synonyms)) continue;
      // Sort synonyms by length descending so longer phrases match first
      const sortedSyns = [...synonyms].sort((a, b) => b.length - a.length);
      const matched: string[] = [];

      for (const syn of sortedSyns) {
        const lowerSyn = syn.toLowerCase();
        if (lowerMsg.includes(lowerSyn)) {
          if (!matched.some((m) => m.toLowerCase().includes(lowerSyn))) {
            matched.push(syn);
          }
        }
      }

      if (matched.length > 0) {
        const isListSlot = slotKey.includes('items') || slotKey.includes('types') || slotKey.includes('list');
        candidateFacts[slotKey] = {
          value: isListSlot ? matched : matched[0],
          source: 'customer',
          confidence: 0.95,
          extractedAt: new Date().toISOString(),
        };
      }
    }

    // 2. Dynamic vocabulary terms and canonical concepts
    const terms = release.vocabulary?.terms || [];
    for (const item of terms) {
      const termName = item.term.toLowerCase();
      const termCanonical = (item.canonical || item.term).toLowerCase();
      const synonyms = (item.synonyms || []).map((s: string) => s.toLowerCase());

      const isMatch =
        lowerMsg.includes(termName) ||
        lowerMsg.includes(termCanonical) ||
        synonyms.some((s: string) => lowerMsg.includes(s));

      if (isMatch && item.category) {
        const categoryKey = item.category;
        if (!candidateFacts[categoryKey]) {
          candidateFacts[categoryKey] = {
            value: item.canonical || item.term,
            source: 'customer',
            confidence: 0.95,
            extractedAt: new Date().toISOString(),
          };
        }
      }
    }

    // 3. Domain-neutral budget and numerical constraint extraction
    const budgetMatch = lowerMsg.match(
      /(?:under|below|less than|max|budget)[^\$0-9]*\$?([0-9,]+(?:\.[0-9]{2})?)\s*(k|thousand)?\s*([a-zA-Z]{3}|dollars)?/i
    );
    if (budgetMatch) {
      const numStr = budgetMatch[1].replace(/,/g, '');
      let multiplier = 1;
      if (budgetMatch[2]?.toLowerCase() === 'k' || budgetMatch[2]?.toLowerCase() === 'thousand') {
        multiplier = 1000;
      }
      const rawAmount = parseFloat(numStr) * multiplier;
      const currency = (budgetMatch[3] || release.profile.primaryCurrency || 'USD').toUpperCase();
      const amountCents = Math.round(rawAmount * 100);

      candidateFacts['budget'] = {
        value: {
          amountCents,
          amount: rawAmount,
          currency,
          scope: 'total',
        },
        source: 'customer',
        confidence: 0.98,
        extractedAt: new Date().toISOString(),
      };
    }

    // 4. Merge explicit command inputFacts (authoritative caller input)
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
      intent: 'process_turn',
      candidateFacts,
      confidence: Object.keys(candidateFacts).length > 0 ? 0.9 : 0.5,
    };
  }
}
