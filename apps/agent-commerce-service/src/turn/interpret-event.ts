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
   * vocabulary, slot definitions, entities, and rules.
   */
  async interpret(
    command: TurnCommand,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): Promise<InterpretationResult> {
    const rawMessage = command.message || (command as any).userInput || '';
    const lowerMsg = rawMessage.toLowerCase();
    const candidateFacts: FactsMap = {};

    // 1. Dynamic vocabulary & term matching from Business Pack
    const terms = release.vocabulary?.terms || [];
    for (const item of terms) {
      const termName = item.term.toLowerCase();
      const termCanonical = (item.canonical || item.term).toLowerCase();
      const synonyms = (item.synonyms || []).map((s: string) => s.toLowerCase());

      const matched =
        lowerMsg.includes(termName) ||
        lowerMsg.includes(termCanonical) ||
        synonyms.some((s: string) => lowerMsg.includes(s));

      if (matched) {
        if (item.category === 'cloud' || termName.includes('gcp') || termName.includes('aws') || termName.includes('azure')) {
          candidateFacts['cloudPlatform'] = {
            value: item.term.toUpperCase().includes('GCP') ? 'GCP' : item.term,
            source: 'customer',
            confidence: 0.98,
            extractedAt: new Date().toISOString(),
          };
        }
        if (item.category === 'cloud' || item.category === 'consulting' || lowerMsg.includes('moderniz') || lowerMsg.includes('migrat')) {
          candidateFacts['domain'] = {
            value: item.canonical || item.term,
            source: 'customer',
            confidence: 0.95,
            extractedAt: new Date().toISOString(),
          };
        }
      }
    }

    // 2. Dynamic slotSynonyms matching from Business Pack
    const slotSynonyms = release.vocabulary?.slotSynonyms || {};
    for (const [slotKey, synonyms] of Object.entries(slotSynonyms)) {
      const matchedSyns = (synonyms as string[]).filter((syn) => lowerMsg.includes(syn.toLowerCase()));
      if (matchedSyns.length > 0) {
        candidateFacts[slotKey] = {
          value: matchedSyns,
          source: 'customer',
          confidence: 0.95,
          extractedAt: new Date().toISOString(),
        };

        if (slotKey === 'scope' || slotKey === 'scopeItems') {
          candidateFacts['scopeItems'] = {
            value: matchedSyns,
            source: 'customer',
            confidence: 0.95,
            extractedAt: new Date().toISOString(),
          };
        }

        if (slotKey === 'cloud' || slotKey === 'cloudPlatform') {
          candidateFacts['cloudPlatform'] = {
            value: matchedSyns[0].toUpperCase(),
            source: 'customer',
            confidence: 0.98,
            extractedAt: new Date().toISOString(),
          };
        }
      }
    }

    // 3. Trade / Occupation Extraction (Workwear / Services)
    const occupationMatch = lowerMsg.match(/(?:i['’]m an?|work as an?|role is)\s+([a-zA-Z\s]+?)(?:\.|\,|$|\s+i need|\s+looking for)/i);
    if (occupationMatch) {
      candidateFacts['occupation'] = {
        value: occupationMatch[1].trim(),
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

    // 4. Budget Constraint Extraction (Supports "$250", "$80,000", "80k", "$80,000 USD", "$250 AUD")
    const budgetMatch = lowerMsg.match(/(?:under|below|less than|max|budget)[^\$0-9]*\$?([0-9,]+(?:\.[0-9]{2})?)\s*(k|thousand)?\s*(aud|usd|nzd|cad|eur|gbp|dollars)?/i);
    if (budgetMatch) {
      let numStr = budgetMatch[1].replace(/,/g, '');
      let multiplier = 1;
      if (budgetMatch[2]?.toLowerCase() === 'k' || budgetMatch[2]?.toLowerCase() === 'thousand') {
        multiplier = 1000;
      }
      const rawDollars = parseFloat(numStr) * multiplier;
      const currency = (budgetMatch[3] || release.profile.primaryCurrency || 'USD').toUpperCase();
      const amountCents = Math.round(rawDollars * 100);

      candidateFacts['budget'] = {
        value: {
          amountCents,
          amountUsd: currency === 'USD' ? rawDollars : Math.round(rawDollars * 0.65),
          amount: rawDollars,
          currency,
          scope: 'total',
        },
        source: 'customer',
        confidence: 0.98,
        extractedAt: new Date().toISOString(),
      };
    }

    // 5. Workwear item slots fallback
    const detectedItemTypes: string[] = [];
    if (lowerMsg.includes('pants') || lowerMsg.includes('cargos') || lowerMsg.includes('trousers')) {
      detectedItemTypes.push('pants');
    }
    if (lowerMsg.includes('boots') || lowerMsg.includes('footwear') || lowerMsg.includes('shoes')) {
      detectedItemTypes.push('boots');
    }
    if (detectedItemTypes.length > 0) {
      candidateFacts['required_item_types'] = {
        value: detectedItemTypes,
        source: 'customer',
        confidence: 0.95,
        extractedAt: new Date().toISOString(),
      };
    }

    // 6. Safety Spec Extraction
    if (lowerMsg.includes('composite') || lowerMsg.includes('composite-toe')) {
      candidateFacts['safety_spec'] = {
        value: 'composite_toe',
        source: 'customer',
        confidence: 0.95,
        extractedAt: new Date().toISOString(),
      };
    }

    // 7. Merge explicit inputFacts
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
      intent: detectedItemTypes.length > 0 ? 'build_solution' : 'general_inquiry',
      candidateFacts,
      confidence: 0.92,
    };
  }
}
