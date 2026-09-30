/**
 * @deprecated FROZEN LEGACY INTENT RESOLVER
 * Preserved strictly for legacy unmigrated tenants.
 * Canonical runtime uses published Business Pack journey graphs and stage transitions.
 */
import OpenAI from 'openai';
import { ConversationMode, IntentResult } from '../pipeline/types';

interface DimensionSpec { key: string; label?: string; values?: string[]; description?: string; scoping?: boolean }

function buildIntentSystem(dimensions?: DimensionSpec[]): string {
  const dims = (dimensions ?? []).filter((d) => d && d.key);
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
  "panelRenderBlocked": boolean — true ONLY when the customer EXPLICITLY says they do NOT want the conversation to render/show items yet. Examples that set this true: "don't render yet", "don't choose one for me", "don't show it yet", "just tell me what to look for", "I'll pick the design from the panel — don't render". Examples that leave this false: browsing normally, asking to see items, confirming colours. Default: false.
  "confidence": 0..1,
  "missingInfo": array of context still missing (e.g. ["budget","dimensions","fixtures"]),
  "organization": if the customer names a specific school, college, university, club, team or company they are buying/designing FOR, return { "name": "...", "location": "city, state if given" }; otherwise null
}
CONTEXT DIMENSIONS (config-driven — extract values for THESE only):
${dimBlock}
NOTE: "bathroom_remodel" is the generic whole-context remodel/renovation/new-configuration intent —
use it for any renovation/new-build regardless of vertical, and let "dimensions" carry the specifics.
SERVICE QUESTIONS ARE NEVER DISCOVERY: a return, refund, exchange, credit, warranty or faulty-item claim,
delivery / shipping / pickup status, an account, invoice or order query, or any policy question →
intent="general_question", needsRetrieval=true, retrievalType="faq", stage="intro", inScope=true
(policy questions are always in scope), even if the customer names a product ("return my drilling tools").
The assistant answers these from the business's own policy pages, not by showing products or asking a form.
Classify from the CONVERSATION FLOW, not keywords:
- Early discovery — you have not yet asked clarifying questions, or key context is still missing →
  needsRetrieval=false, retrievalType="none" (ask questions first).
- IMPORTANT — advancement: once the assistant has ALREADY asked clarifying questions and the
  customer is now answering them (or has otherwise given enough to act), discovery is COMPLETE:
  • If diagnosing a leak, plumbing fault, moisture damage, or technical how-to → stage="installation", retrievalType="troubleshooting" or "installation".
  • If shopping for or selecting products, materials, or fixtures → stage="products", retrievalType="product".
  • NEVER set stage="quote" upon answering clarifying questions. Stage="quote" is ONLY for when concrete products/items have already been shown or specified and the customer asks to price, quote, or finalize them (e.g. "quote me", "build my quote", "how much for these", "ready to order").
  Set needsRetrieval=true. Do NOT keep the customer in discovery once they have answered — that is the most common failure.
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
  "installation" for how-to; "faq" for warranty/policy/returns/store-info.
- panelRenderBlocked: set true ONLY when the customer explicitly opts out of seeing items rendered on
  the panel THIS turn ("don't render yet", "just tell me what to look for", "don't choose for me",
  "I'll pick from the panel — don't render it"). This is rare; most browsing turns leave it false.
Return JSON only, no prose.`;
}

export class IntentResolver {
  constructor(private readonly openai: OpenAI, private readonly model: string) {}

  async resolve(
    messages: any[],
    state?: { phase?: string },
    modelOverride?: string,
    dimensions?: DimensionSpec[],
    client?: OpenAI,
  ): Promise<IntentResult> {
    const model = modelOverride || this.model;
    const llm = client || this.openai;
    const strictJson = !client;
    const fallback: IntentResult = {
      intent: 'unknown',
      dimensions: {},
      inScope: true,
      space: 'general',
      stage: state?.phase || 'intro',
      mode: 'business',
      needsRetrieval: true,
      retrievalType: 'product',
      confidence: 0,
      missingInfo: [],
    };

    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (!lastText) return fallback;

      const recent = messages
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[structured message]'}`)
        .join('\n');

      const isReasoning = /^(gpt-5|o[134])/.test(model);
      const res = await llm.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: buildIntentSystem(dimensions) + (strictJson ? '' : '\n\nReply with ONE JSON object and nothing else — no prose, no code fence.') },
          { role: 'user', content: `Current stage: ${state?.phase || 'intro'}\n\nRecent conversation:\n${recent}\n\nClassify the customer's LATEST message in the context of this conversation.` },
        ],
        ...(strictJson ? { response_format: { type: 'json_object' as const } } : { max_tokens: 400 }),
        ...(isReasoning ? {} : { temperature: 0 }),
      });

      const rawOut = String(res.choices[0].message.content || '{}');
      const firstObj = rawOut.indexOf('{'); const lastObj = rawOut.lastIndexOf('}');
      const parsed = JSON.parse(firstObj >= 0 && lastObj > firstObj ? rawOut.slice(firstObj, lastObj + 1) : rawOut);
      const dims: Record<string, string> = {};
      if (parsed.dimensions && typeof parsed.dimensions === 'object') {
        for (const [k, v] of Object.entries(parsed.dimensions)) {
          if (v != null && String(v).trim() && String(v).toLowerCase() !== 'unknown') dims[k] = String(v);
        }
      }
      const inScope = parsed.inScope !== false;
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
        panelRenderBlocked: Boolean(parsed.panelRenderBlocked),
      };
    } catch (err) {
      console.warn('[IntentResolver] classification failed, using safe default:', (err as Error).message);
      return fallback;
    }
  }
}
