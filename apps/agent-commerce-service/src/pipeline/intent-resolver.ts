/**
 * Step 1 — Intent Resolver.
 *
 * One cheap, structured LLM call that classifies the customer's latest message
 * BEFORE the main generation. Its job is to decide WHAT kind of turn this is so
 * the rest of the pipeline can route correctly (especially: should we retrieve,
 * and if so from where — the fix for "fetching install PDFs during discovery").
 *
 * Resilient: on any error it returns a safe default (discovery, no retrieval),
 * so the agent degrades to normal behaviour rather than breaking.
 */
import OpenAI from 'openai';
import { ConversationMode, IntentResult } from './types';

interface DimensionSpec { key: string; label?: string; values?: string[]; description?: string; scoping?: boolean }

function buildIntentSystem(dimensions?: DimensionSpec[]): string {
  const dims = (dimensions ?? []).filter((d) => d && d.key);
  // Context dimensions are CONFIG-DRIVEN per project. The extractor pulls a value for
  // each from the conversation; scoping dimensions with a fixed value set also decide
  // whether the request is in-scope for the business.
  const dimBlock = dims.length
    ? dims
        .map((d) => {
          const vals = d.values?.length ? ` — allowed values: [${d.values.join(', ')}]` : ' — free text';
          const scope = d.scoping && d.values?.length ? ' (SCOPING: a request whose value is outside these means the business does NOT serve it)' : '';
          return `  • "${d.key}"${d.label ? ` (${d.label})` : ''}${vals}${d.description ? ` — ${d.description}` : ''}${scope}`;
        })
        .join('\n')
    : '  (none configured — leave "dimensions" empty and "inScope" true)';
  return `You are the intent classifier for a conversational commerce/service assistant. Read the RECENT
CONVERSATION and the customer's latest message, and return ONLY a JSON object:
{
  "intent": one of ["bathroom_remodel","leak_repair","product_recommendation","installation_help","quote_order","design_inspiration","general_question","unknown"],
  "dimensions": an object mapping each CONFIGURED dimension key to the value you confidently extract (omit a key if unknown; a value from its allowed list, matched case-insensitively then returned in the list's exact casing),
  "inScope": boolean — false only if the request clearly falls OUTSIDE a SCOPING dimension's allowed values (i.e. something this business does not serve); otherwise true,
  "stage": one of ["intro","clarify","products","quote","ordered","installation"],
  "mode": "business" for planning/selling/discovery, "technical" for install/repair/specs,
  "needsRetrieval": boolean,
  "retrievalType": one of ["product","design","collection","troubleshooting","installation","faq","none"],
  "confidence": 0..1,
  "missingInfo": array of context still missing (e.g. ["budget","dimensions","fixtures"]),
  "organization": if the customer names a specific school, college, university, club, team or company they are buying/designing FOR, return { "name": "...", "location": "city, state if given" }; otherwise null
}
CONTEXT DIMENSIONS (config-driven — extract values for THESE only):
${dimBlock}
NOTE: "bathroom_remodel" is the generic whole-context remodel/renovation/new-configuration intent —
use it for any renovation/new-build regardless of vertical, and let "dimensions" carry the specifics.
Classify from the CONVERSATION FLOW, not keywords:
- Early discovery — you have not yet asked clarifying questions, or key context is still missing →
  needsRetrieval=false, retrievalType="none" (ask questions first).
- IMPORTANT — advancement: once the assistant has ALREADY asked clarifying questions and the
  customer is now answering them (or has otherwise given enough to act), discovery is COMPLETE.
  Advance the stage (usually to "products") and set needsRetrieval=true. Do NOT keep the customer
  in discovery once they have answered — that is the most common failure.
- GUIDED OPENING (default): on the customer's FIRST substantive message of a new journey — when they
  describe an OCCASION, PROJECT or GOAL (a party, wedding, remodel, team kit, celebration) rather than
  naming ONE specific product to see — classify stage="intro" and needsRetrieval=false, EVEN IF they
  already gave budget, size, colours or theme. Extracting context DIMENSIONS does NOT mean discovery is
  complete: the guided experience is to acknowledge their intent, confirm the essentials with a short
  set of clarifying questions, then advance. Ask FIRST, then recommend.
- Skip straight to stage="products" on the OPENING turn ONLY when the customer explicitly asks to SEE a
  specific NAMED product or style ("show me the Tulip favours", "open the designer for the cake box").
- Match retrievalType to the need: "product" to choose/compare fixtures; "design"/"collection" for
  inspiration or a whole-room look; "troubleshooting" for a fault/leak (safety+diagnosis first);
  "installation" for how-to; "faq" for warranty/policy.
Return JSON only, no prose.`;
}

export class IntentResolver {
  constructor(private readonly openai: OpenAI, private readonly model: string) {}

  async resolve(
    messages: any[],
    state?: { phase?: string },
    modelOverride?: string,
    dimensions?: DimensionSpec[],
  ): Promise<IntentResult> {
    const model = modelOverride || this.model;
    const fallback: IntentResult = {
      intent: 'unknown',
      dimensions: {},
      inScope: true,
      space: 'general',
      stage: state?.phase || 'intro',
      mode: 'business',
      needsRetrieval: false,
      retrievalType: 'none',
      confidence: 0,
      missingInfo: [],
    };

    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (!lastText) return fallback;

      // Recent conversation so the classifier can see the FLOW (e.g. the assistant
      // already asked questions and the customer is now answering → advance). This
      // is what lets us drop the "my answers" keyword heuristic.
      const recent = messages
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[structured message]'}`)
        .join('\n');

      // Reasoning models (gpt-5.x / o-series) only support the default temperature —
      // sending temperature:0 is a 400. Omit it for those; keep 0 for others so
      // classification stays deterministic.
      const isReasoning = /^(gpt-5|o[134])/.test(model);
      const res = await this.openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: buildIntentSystem(dimensions) },
          { role: 'user', content: `Current stage: ${state?.phase || 'intro'}\n\nRecent conversation:\n${recent}\n\nClassify the customer's LATEST message in the context of this conversation.` },
        ],
        response_format: { type: 'json_object' },
        ...(isReasoning ? {} : { temperature: 0 }),
      });

      const parsed = JSON.parse(res.choices[0].message.content || '{}');
      // Normalise extracted dimensions to string→string.
      const dims: Record<string, string> = {};
      if (parsed.dimensions && typeof parsed.dimensions === 'object') {
        for (const [k, v] of Object.entries(parsed.dimensions)) {
          if (v != null && String(v).trim() && String(v).toLowerCase() !== 'unknown') dims[k] = String(v);
        }
      }
      const inScope = parsed.inScope !== false;
      // Derive back-compat `space`: the extracted space value, else general/out_of_scope.
      const space = dims.space || (inScope ? 'general' : 'out_of_scope');
      return {
        intent: String(parsed.intent || 'unknown'),
        dimensions: dims,
        inScope,
        space,
        stage: String(parsed.stage || fallback.stage),
        mode: (parsed.mode === 'technical' ? 'technical' : 'business') as ConversationMode,
        needsRetrieval: Boolean(parsed.needsRetrieval),
        retrievalType: parsed.retrievalType || 'none',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo.map(String) : [],
        organization: parsed.organization && typeof parsed.organization === 'object' && parsed.organization.name
          ? { name: String(parsed.organization.name), location: parsed.organization.location ? String(parsed.organization.location) : undefined }
          : undefined,
      };
    } catch (err) {
      console.warn('[IntentResolver] classification failed, using safe default:', (err as Error).message);
      return fallback;
    }
  }
}
