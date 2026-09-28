import { TurnCommand, WorkspaceState, FactsMap } from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { ModelGateway } from '../kernel/model.gateway';

export interface InterpretationResult {
  intent: string;
  candidateFacts: FactsMap;
  confidence: number;
}

export class TurnInterpreter {
  constructor(private readonly modelGateway?: ModelGateway) {}

  /**
   * Domain-neutral turn interpreter. Extracts facts and intents dynamically
   * through the ModelGateway port or Business Pack vocabulary, with candidate
   * facts schema-validated before workspace mutation.
   */
  async interpret(
    command: TurnCommand,
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ): Promise<InterpretationResult> {
    const rawMessage = command.message || (command as any).userInput || '';
    const lowerMsg = rawMessage.toLowerCase();
    const rawCandidateFacts: FactsMap = {};
    let extractedIntent = 'process_turn';

    // 1. Model Gateway Port Execution (if ModelGateway is injected)
    if (this.modelGateway) {
      try {
        const prompt = `User message: "${rawMessage}". Available slots: ${JSON.stringify(
          (release.vocabulary as any)?.slotQuestions || {}
        )}. Extract intent and candidate facts matching entity schemas. Return JSON: { intent, candidateFacts: { [key]: { value, confidence } } }`;

        const modelRes = await this.modelGateway.execute(release, {
          taskType: 'fast_intent',
          prompt,
          systemPrompt: 'Extract structured facts and intent according to business pack entity schemas.',
        });

        if (modelRes.content) {
          const parsed = JSON.parse(modelRes.content);
          if (parsed.intent) extractedIntent = parsed.intent;
          if (parsed.candidateFacts && typeof parsed.candidateFacts === 'object') {
            for (const [k, v] of Object.entries(parsed.candidateFacts)) {
              if (v && typeof v === 'object') {
                rawCandidateFacts[k] = {
                  value: (v as any).value !== undefined ? (v as any).value : v,
                  source: 'customer',
                  confidence: (v as any).confidence || 0.95,
                  extractedAt: new Date().toISOString(),
                };
              } else {
                rawCandidateFacts[k] = {
                  value: v,
                  source: 'customer',
                  confidence: 0.95,
                  extractedAt: new Date().toISOString(),
                };
              }
            }
          }
        }
      } catch (err: any) {
        // Fallback to deterministic vocabulary extraction if model execution unconfigured
      }
    }

    // 2. Dynamic slotSynonyms extraction from Business Pack
    const slotSynonyms = release.vocabulary?.slotSynonyms || {};
    for (const [slotKey, synonyms] of Object.entries(slotSynonyms)) {
      if (!Array.isArray(synonyms)) continue;
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

      if (matched.length > 0 && !rawCandidateFacts[slotKey]) {
        const isListSlot = slotKey.includes('items') || slotKey.includes('types') || slotKey.includes('list');
        rawCandidateFacts[slotKey] = {
          value: isListSlot ? matched : matched[0],
          source: 'customer',
          confidence: 0.95,
          extractedAt: new Date().toISOString(),
        };
      }
    }

    // 3. Dynamic vocabulary terms and canonical concepts
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
        if (!rawCandidateFacts[categoryKey]) {
          rawCandidateFacts[categoryKey] = {
            value: item.canonical || item.term,
            source: 'customer',
            confidence: 0.95,
            extractedAt: new Date().toISOString(),
          };
        }
      }
    }

    // 4. Merge explicit command inputFacts (authoritative caller input)
    if (command.inputFacts) {
      for (const [k, v] of Object.entries(command.inputFacts)) {
        rawCandidateFacts[k] = {
          value: v,
          source: 'system',
          confidence: 1.0,
          extractedAt: new Date().toISOString(),
        };
      }
    }

    // ── SCHEMA VALIDATION OF CANDIDATE FACTS BEFORE WORKSPACE MUTATION ──
    const validatedCandidateFacts: FactsMap = {};
    const entities = release.entities?.entities || [];
    const slotQuestions = (release.vocabulary as any)?.slotQuestions || {};

    for (const [factKey, factEntry] of Object.entries(rawCandidateFacts)) {
      const val = factEntry.value;

      // Check entity schema definition
      const entityDef: any = entities.find(
        (e: any) => e.entityName === factKey || e.entityId === factKey || e.name === factKey
      );
      const attrDef: any = entityDef?.attributes?.find((a: any) => a.name === factKey);
      let isValid = true;

      const enumValues = entityDef?.allowedValues || attrDef?.enum;
      if (Array.isArray(enumValues) && enumValues.length > 0) {
        if (!enumValues.includes(val)) {
          isValid = false; // Disallowed enum value
        }
      } else if (
        entityDef?.type === 'number' ||
        entityDef?.type === 'integer' ||
        attrDef?.type === 'number'
      ) {
        const num = Number(val);
        if (isNaN(num)) isValid = false;
        if (entityDef?.minimum !== undefined && num < entityDef.minimum) isValid = false;
        if (entityDef?.maximum !== undefined && num > entityDef.maximum) isValid = false;
      }

      // Check slot question options if entity wasn't explicit
      const slotDef = slotQuestions[factKey];
      if (isValid && slotDef && Array.isArray(slotDef.options) && slotDef.options.length > 0) {
        if (!slotDef.options.includes(val)) {
          isValid = false;
        }
      }

      if (isValid) {
        validatedCandidateFacts[factKey] = factEntry;
      }
    }

    return {
      intent: extractedIntent,
      candidateFacts: validatedCandidateFacts,
      confidence: Object.keys(validatedCandidateFacts).length > 0 ? 0.9 : 0.5,
    };
  }
}
