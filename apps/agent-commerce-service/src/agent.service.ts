import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { adapterRegistry, createPublishedConfigResolver } from '@journeyax/integration';
import { getChatClient } from './llm/provider';
import { QuoteService } from './commerce/quote.service';
import { OrderService } from './commerce/order.service';
import { SchoolResearchService } from './commerce/school-research.service';
import {
  JourneyState, emptyJourneyState, reduceActions, alreadyPresented,
  renderJourneyStateBlock,
} from './pipeline/journey-memory';
import { verifyComparisonProvenance, lookupSkuFacts } from './presentation/provenance';
import { sanitizeChips, fenceSearchResultText } from './presentation/fencing';
import { skillIndexBlock, loadSkillBody, ConfiguredSkillSummary } from './skills/loader';
import type { EffectiveAgentConfig } from './runtime-config';
import { UI_TOOL_NAMES } from './tools/registry';
import { buildToolset } from './tools/policy';
import { lookupOptions, lookupRelated, resolveSkuByName } from './tools/executors/retrieval';
import { bundleRefused, emptyShowItemsVerdict, findCatalogueMatch, groundItemFacts } from './tools/executors/presentation';
import { DEMO_CUSTOMER_TOOLS, applyOrderPlacedContext, applyStorefrontCartCommand, buildAuthoritativeQuote, demoProfile, recommendSize, recommendStorage, runDemoCustomerTool } from './tools/executors/commerce';
import { checkArtworkApproval, checkReviewStatus, requestArtwork } from './tools/executors/customisation';
import { designableAlternatives, validateDesign, analyzeDesign, generateDesign, generateTeamDesign, uploadPhotosFor3D, submitForReview, submitTeamOrder } from './tools/executors/customisation';
import { handleBuildProjectPlan, handleCheckBranchStock, saveEntity } from './tools/executors/support';
import { getTeamColours, readRoster, lookupEntities, skusThatExist } from './tools/executors/team';

export { AVAILABLE_CAPABILITIES, buildToolset } from './tools/policy';

const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

function configuredSkillIds(agentConfig?: EffectiveAgentConfig): string[] | undefined {
  const skills = agentConfig?.skills;
  if (!Array.isArray(skills)) return undefined;
  return skills
    .map((skill: any) => typeof skill === 'string' ? skill : skill?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function configuredSkills(agentConfig?: EffectiveAgentConfig): ConfiguredSkillSummary[] | undefined {
  const skills = agentConfig?.skills;
  if (!Array.isArray(skills)) return undefined;
  const result: ConfiguredSkillSummary[] = [];
  for (const skill of skills as any[]) {
    const id = typeof skill === 'string' ? skill : skill?.id;
    if (typeof id === 'string' && id.length > 0) {
      result.push({ id, name: skill?.name, description: skill?.description });
    }
  }
  return result;
}

/** Keep transcripts bounded (context editing) — recent turns are enough; the
 *  journey-memory block carries the durable facts. */
const MAX_TRANSCRIPT_MESSAGES = 16;

/**
 * How many pieces the customer needs ("14 players", "25 jerseys", "roster of 18").
 *
 * The quote engine multiplies unitPrice × quantity correctly, but quantity
 * defaults to 1 when the model omits it — so an 18-player order quoted as one
 * jersey. The headcount is always stated in plain language; capture it
 * deterministically rather than hoping the model carries it to updateQuote.
 *
 * Generic language only (no brand/domain data): a number followed by a
 * countable-people/garment noun. Returns undefined when nothing is stated, so a
 * single-item enquiry is never inflated.
 */
export function extractTeamSize(text: string): number | undefined {
  const s = String(text || '').toLowerCase();
  // Allow up to two describing words between the count and the noun — real
  // phrasing is "25 FOOTBALL jerseys" / "14 girls varsity players", not "25 jerseys".
  // Words only (no punctuation), so it cannot run across clauses and pick up an
  // unrelated number from the next sentence.
  const re = /(\d{1,4})\s+(?:[a-z'’-]+\s+){0,2}?(players?|athletes?|kids?|jerseys?|uniforms?|kits?|shirts?|pieces?|sets?|guests?|favou?rs?|candies|candy|boxes?|bags?|tins?|jars?|dispensers?|packs?|servings?|people|attendees?|recipients?)\b/g;
  let best: number | undefined;
  for (const m of s.matchAll(re)) {
    const n = parseInt(m[1], 10);
    // Sanity band: a team, not a typo or a year.
    if (Number.isFinite(n) && n > 1 && n <= 500) best = Math.max(best ?? 0, n);
  }
  // "roster of 18" / "squad of 22"
  const of = s.match(/(?:roster|squad|team)\s+of\s+(\d{1,4})/);
  if (of) {
    const n = parseInt(of[1], 10);
    if (n > 1 && n <= 500) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The customer's stated budget in whole dollars, if they gave one. Matches
 *  "$175", "budget is 175", "around $1,500", "under $2k" — so the agent can
 *  keep the plan within it instead of quoting a total that blows past it. */
export function extractBudget(text: string): number | undefined {
  const s = String(text || '').toLowerCase();
  let best: number | undefined;
  const re = /(?:\$|budget[^\d]{0,12}|around |about |under |up to |max(?:imum)? )\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/g;
  for (const m of s.matchAll(re)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2] === 'k') n *= 1000;              // "$2k" → 2000
    if (Number.isFinite(n) && n >= 20 && n <= 5_000_000) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The clean transcript we persist: user turns + assistant TEXT replies only
 *  (no system, no tool-call/result pairs — those are transient within a turn).
 *
 *  A single assistant message can carry BOTH text and tool_calls (the model
 *  narrates "let me look that up" while emitting searchKnowledge in the same
 *  turn). We keep the text, but must DROP tool_calls: the matching tool-result
 *  messages are stripped as transient, so a surviving tool_calls array would be
 *  an assistant message whose tool_call_ids have no responses — which makes
 *  OpenAI reject the NEXT turn with 400 "tool_call_ids did not have response
 *  messages" (and, because it's baked into the saved transcript, every turn
 *  after that until the session is cleared). Persist clean text only. */
function persistableTranscript(conversation: any[]): any[] {
  const out = conversation
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()))
    .map((m) =>
      m.role === 'assistant' && m.tool_calls
        ? { role: 'assistant', content: m.content }
        : m,
    );
  return out.slice(-MAX_TRANSCRIPT_MESSAGES);
}

/** Reasoning models (gpt-5.x / o-series) reject an explicit temperature. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[134])/.test(model);
}

/** Apply the project's configured temperature — but only where the model supports it.
 *  Plain 'gpt-5' gets `reasoning_effort:'low'` instead: at the default effort, a turn
 *  carrying this agent's full journeyGuidance + tool schema can take 60-90s+ per
 *  completion, and a multi-tool troubleshooting turn (JOURNEY 4: showGuide +
 *  searchKnowledge + showItems) chains several of those sequentially — compounding
 *  past two minutes with no error, just silence. 'low' keeps tool-call selection
 *  reliable while cutting that reasoning overhead sharply — confirmed live on gpt-5.
 *
 *  This does NOT extend to every reasoning model: gpt-5.5 (Caroma's model) 400s on
 *  chat.completions the moment reasoning_effort is combined with tool calling —
 *  "Function tools with reasoning_effort are not supported for gpt-5.5... set
 *  reasoning_effort to 'none'." — a live regression caught during PlaceMakers
 *  verification. o-series and other gpt-5 variants (mini/nano) are unverified either
 *  way, so this stays scoped to the one exact model where both the original hang and
 *  this fix were proven, rather than guessing at a shared param across the family. */
function genParams(model: string, temperature?: number): { temperature?: number; reasoning_effort?: 'low' } {
  if (isReasoningModel(model)) return model === 'gpt-5' ? { reasoning_effort: 'low' } : {};
  if (typeof temperature === 'number') return { temperature };
  return {};
}

/** Parses a tool call's raw (string) arguments defensively — used only for the session step trace. */
function safeParseArgs(raw: string | undefined): any {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
import { IntentResolver } from './pipeline/intent-resolver';
import { buildRetrievalPolicy } from './pipeline/retrieval-router';
import { validateGrounding } from './pipeline/grounding-validator';
import { ConfigLoader } from './pipeline/config-loader';
import { SessionStore, summarizeToolCall } from './pipeline/session-store';
import { assembleSystemPrompt } from './prompts';
import { IntentResult, TraceEntry } from './pipeline/types';
import { randomUUID } from 'crypto';

// System prompt is assembled per-turn from ./prompts (base + mode + stage).

/** Back Office is authoritative; Brand Hub is used only by legacy tenants that
 * have not published a Back Office business profile. Custom work alone does
 * not make a configurator usable: its component and capability must be on. */
function resolveCustomisationAvailability(projectConfig: any, brandHubProfile: any): {
  supportsCustomisation: boolean;
  configuratorAvailable: boolean;
} {
  const backOfficeValue = projectConfig?.business?.customised;
  const supportsCustomisation = typeof backOfficeValue === 'boolean'
    ? backOfficeValue
    : brandHubProfile?.model?.customised === true;
  const configuratorAvailable = supportsCustomisation
    && projectConfig?.configuratorEnabled === true
    && Array.isArray(projectConfig?.capabilities)
    && projectConfig.capabilities.includes('configurator');
  return { supportsCustomisation, configuratorAvailable };
}

function withoutConfiguratorTool(toolDefinitions: OpenAI.ChatCompletionTool[]): OpenAI.ChatCompletionTool[] {
  return toolDefinitions.filter((tool) => tool.type !== 'function' || tool.function.name !== 'showConfigurator');
}
/** Persist a customer-named entity through the BUSINESS port. Provenance is
 *  recorded as customer-stated so nothing here is mistaken for verified fact. */

/**
 * Identity guard for the configurator (AUG-22).
 *
 * The model would sometimes render a DIFFERENT style than the one the customer
 * named — it searched, found a real product, and put that code in `sku` while
 * its own message still referenced the requested style. The customer then sees
 * the wrong garment, which is the most damaging error this flow can make.
 *
 * Prompt wording did not reliably prevent it, so identity is settled in code:
 * if the customer named a code that exists in this catalogue, that code wins.
 * Exact match against a known set — the same approach used for team names, and
 * for the same reason: a near-miss on identity is not a small error.
 */
async function enforceNamedSku(tenantId: string, conversation: any[], call: any): Promise<void> {
  if (call?.function?.name !== 'showConfigurator') return;
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return; }

  // Only what the CUSTOMER said — never the assistant's own prior turns, or the
  // model's earlier substitution would justify itself on the next turn.
  const said = conversation
    .filter((m) => m?.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content).join(' ').toUpperCase();

  // Style codes always carry a digit (329X3M, 228130, 257); requiring one keeps
  // colour and team words out of the candidate set entirely.
  const tokens = [...new Set(said.match(/\b[A-Z0-9]{3,12}\b/g) || [])]
    .filter((t) => /\d/.test(t))
    .slice(0, 12);
  if (!tokens.length) return;

  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/skus/exists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus: tokens }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const found: string[] = ((await res.json())?.found || []).map((x: string) => x.toUpperCase());
    if (!found.length) return;

    // The most recently named one, so "actually make it 228131" wins over the
    // style mentioned earlier in the conversation.
    const named = tokens.filter((t) => found.includes(t)).pop();
    if (!named) return;

    const current = String(args.sku || '').toUpperCase();
    if (current === named) return;
    console.warn(`[AgentService] configurator sku corrected: model said "${args.sku}", customer named "${named}"`);
    args.sku = named;
    call.function.arguments = JSON.stringify(args);
  } catch {
    // Guard is best-effort: never block the render on a validation hiccup.
  }
}

/**
 * Check a proposed design against what the platform can actually produce, and
 * tell the MODEL the truth about it (AUG-35).
 *
 * Every UI tool used to be answered with `{ success: true }` regardless of
 * outcome. So the model would confirm "your jersey in Maroon and Gold is set
 * up" when Gold is not a colour this brand stocks and the style had no
 * printable artwork at all — the customer was told their design was ready when
 * it could not be made. A tool result is the only thing the model reads after
 * acting, so it has to carry the real outcome.
 *
 * Two jobs, in order:
 *   1. CORRECT the arguments deterministically, so the panel never renders a
 *      design line the style does not have. Correction cannot depend on the
 *      model choosing to behave.
 *   2. REPORT what happened, so the sentence the model writes next matches
 *      what the customer is looking at.
 */
/**
 * Stop stock styles being PRESENTED as customisable (AUG-25).
 *
 * Annotating retrieval was not enough. Told plainly that a style is
 * `designable: false`, the model still listed three stock jerseys and wrote
 * "we can customize with navy and Vegas gold" over the top of them — the exact
 * claim the annotation existed to prevent. This is the lesson already recorded
 * for `enforceNamedSku`: prompt wording does not reliably prevent it, so it is
 * settled in code.
 *
 * Two strengths, because the right answer depends on what the customer wants:
 *
 *   LABEL always. Every card carries `customisable`, so the panel itself states
 *   whether a garment can take team colours. A card that says so cannot be
 *   contradicted by a sentence beside it.
 *
 *   REMOVE only once a design is actually under way. A stock jersey is a
 *   perfectly good answer to "cheap blank jerseys" — dropping it always would
 *   trade one wrong answer for another. So removal is gated on evidence from
 *   THIS conversation that a custom design is in progress (team colours looked
 *   up, or the configurator already opened), and even then only when a
 *   designable garment survives to offer in its place.
 */
/**
 * presentComparison carries only SKUs + the model's cells; the column
 * headers (name, price, image) are catalogue FACTS and get joined here from
 * the real records — the model never re-types them, and a comparison the
 * model raised without a preceding showItems (seen live: "Matte vs Dual
 * Matte" answered straight from the comparison tool) still shows product
 * names instead of bare SKU codes. Best-effort: a lookup miss leaves the SKU.
 */
async function attachComparisonFacts(tenantId: string, call: any): Promise<void> {
  let args: any;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return; }
  const skus: string[] = Array.isArray(args?.skus) ? args.skus.map((s: unknown) => String(s || '').trim()).filter(Boolean) : [];
  if (!skus.length) return;
  // Exact-code lookup (products/skus/lookup) — semantic search ranks a code's
  // neighbours, not the code, so it cannot be used to join a SKU to its name.
  const facts = await lookupSkuFacts(tenantId, skus);
  if (!facts.length) return;
  const byCode = new Map(facts.map((f) => [f.sku.toUpperCase(), f]));
  args.products = skus.map((sku) => {
    const f = byCode.get(sku.toUpperCase());
    return f ? { sku, title: f.name, price: f.price, imageUrl: f.imageUrl, url: f.url, category: f.category } : { sku };
  });
  call.function.arguments = JSON.stringify(args);
}

/**
 * presentBundle: same contract as the other presentation tools — the model
 * picks SKUs, quantities and reasons; every fact (name, image, price, stock)
 * is joined from the catalogue's pricebook, the total is computed here, and a
 * SKU the catalogue does not have is dropped. Refuses when fewer than two
 * real items survive (a "set" of one is a product card, not a bundle).
 */
/** Pricebook rows (name, price, inStock, …) for a set of SKUs — [] on any failure. */
async function fetchPricebookRows(tenantId: string, skus: string[]): Promise<any[]> {
  if (!skus.length) return [];
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }), signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return ((await res.json())?.items || []) as any[];
  } catch { return []; }
}

async function attachBundleFacts(tenantId: string, call: any): Promise<Record<string, unknown> | null> {
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return null; }
  const wanted: any[] = Array.isArray(args?.items) ? args.items : [];
  const skus = [...new Set(wanted.map((i) => String(i?.sku || '').trim().toUpperCase()).filter(Boolean))];
  if (skus.length < 2) return { success: false, instruction: 'A bundle needs at least two real SKUs. Use showItems for a single item.' };
  let book: any = { items: [], missing: skus };
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }), signal: AbortSignal.timeout(5000),
    });
    if (res.ok) book = await res.json();
  } catch { /* best effort — falls through to a refusal below if nothing priced */ }
  const byCode = new Map<string, any>((book.items || []).map((i: any) => [String(i.sku).toUpperCase(), i]));
  const items = wanted.map((w) => {
    const code = String(w?.sku || '').trim().toUpperCase();
    const f = byCode.get(code);
    if (!f || f.inStock === false) return null;
    const quantity = Math.max(1, Math.floor(Number(w?.quantity) || 1));
    return { sku: f.sku, title: f.name, price: f.price, currency: f.currency, imageUrl: f.imageUrl || null, url: f.url, category: f.category, quantity, reason: w?.reason || undefined, stockLabel: 'In stock' };
  }).filter(Boolean) as any[];
  if (items.length < 2) {
    const soldOut = wanted.map((w) => byCode.get(String(w?.sku || '').trim().toUpperCase())).filter((f) => f && f.inStock === false).map((f) => f.name);
    const kept = items.map((i) => i.title);
    return { success: false, removedNotFound: skus.filter((s) => !byCode.has(s)), soldOut, inStock: kept,
      instruction: `Fewer than two of those are in stock, so no set card was shown.${soldOut.length ? ` SOLD OUT: ${soldOut.join(', ')}.` : ''}${kept.length ? ` In stock: ${kept.join(', ')} — showItems that one.` : ''} Tell the customer plainly which pieces are sold out, show what is available, and offer an alternative set or the nearest match. Never call a sold-out item available.` };
  }
  const priced = items.filter((i) => typeof i.price === 'number');
  const subtotal = Number(priced.reduce((n, i) => n + i.price * i.quantity, 0).toFixed(2));
  const currency = items.find((i) => i.currency)?.currency || 'USD';
  args.items = items;
  args.totals = { subtotal, total: subtotal, currency, itemCount: items.reduce((n, i) => n + i.quantity, 0), pricedAll: priced.length === items.length };
  call.function.arguments = JSON.stringify(args);
  return null;
}

/**
 * The storage ask, read in code: "a box for 100 double-sleeved Commander
 * cards" → { cards: 100, sleeving: 'double', kind: 'deck-box' }. The model was
 * told to call recommendStorage first and did not (it narrated capacities
 * from retrieved copy instead), so the arithmetic is run here, before the
 * model speaks, and handed to it as facts — the same pre-read pattern
 * demoCustomerContext uses for order history.
 */
function parseStorageAsk(text: string): { cards: number; sleeving: string; kind: string } | null {
  const t = (text || '').toLowerCase();
  const num = t.match(/\b(\d{2,4})\b/);
  let cards = num ? Number(num[1]) : 0;
  if (!cards) {
    if (/\bcommander\b|\bedh\b/.test(t)) cards = 100;
    else if (/\b(standard|modern|pioneer|legacy|pauper|deck)\b/.test(t)) cards = 60;
  }
  if (!cards) return null;
  const sleeving = /\bunsleeved\b/.test(t) ? 'unsleeved'
    : /\bsealable\b/.test(t) ? 'sealable-double'
    : /\b(double|twice|two|2)[- ]?sleev/.test(t) ? 'double' : 'single';
  const kind = /\bbinder\b/.test(t) ? 'binder'
    : /\b(portfolio|album)\b/.test(t) ? 'portfolio'
    : /\bdrawer\b/.test(t) ? 'drawer'
    : /\b(deck ?box|box|case)\b/.test(t) ? 'deck-box' : 'any';
  return { cards, sleeving, kind };
}

type StorageFacts = { cards: number; sleeving: string; kind: string; fits: any[]; tooSmall: any[] };

function computeStorageFacts(cfg: any, lastUserText: string): StorageFacts | null {
  const ask = parseStorageAsk(lastUserText);
  if (!ask || !Array.isArray(cfg?.storageGuide) || !cfg.storageGuide.length) return null;
  let r: any = recommendStorage(cfg, JSON.stringify(ask));
  // A kind the guide does not know (no "binder" rows, say) → widen to any.
  if (!(r.fits || []).length && !(r.tooSmall || []).length && ask.kind !== 'any') r = recommendStorage(cfg, JSON.stringify({ ...ask, kind: 'any' }));
  return { cards: ask.cards, sleeving: ask.sleeving, kind: ask.kind, fits: r.fits || [], tooSmall: r.tooSmall || [] };
}

function storageFactsBlock(f: StorageFacts): string {
  const fit = f.fits.map((x: any) => `${x.family}: holds ${x.capacity} ${f.sleeving}-sleeved (${x.spare} spare${x.note ? `; ${x.note}` : ''})`).join(' · ');
  const small = f.tooSmall.map((x: any) => `${x.family}: only ${x.capacity}`).join(' · ');
  return `[STORAGE FACTS] Computed from this business's own capacity guide for ${f.cards} ${f.sleeving}-sleeved cards${f.kind !== 'any' ? ` (${f.kind})` : ''}. `
    + (fit ? `FITS — ${fit}. ` : 'Nothing in the guide fits that count in one piece — say so and suggest splitting across two. ')
    + (small ? `TOO SMALL — ${small}. ` : '')
    + 'Quote ONLY these capacity numbers. The storefront will show cards for the fitting families under your text; your text is your pick, the number you used, and one next-step question — do not list the products.';
}

/**
 * A showItems whose every item was dropped (sold out, fabricated) must not
 * reach the storefront as an empty card, and the model must hear WHY so its
 * text says "sold out" instead of praising an item nobody can buy.
 */
async function enforceItemDesignability(
  tenantId: string, call: any, designFirst = false,
): Promise<Record<string, unknown> | null> {
  // v3 Card CMS presentation contract (docs/v3-card-cms-architecture.md):
  // reuse this function's existing wiring at all three dispatch sites rather
  // than adding new call sites — mutating `call.function.arguments` in place
  // is exactly the pattern that already gets picked up everywhere `parsedArgs`/
  // `emitArgs` is re-read after this call returns.
  if (call?.function?.name === 'presentComparison') {
    const refusal = await verifyComparisonProvenance(tenantId, call);
    if (!refusal) await attachComparisonFacts(tenantId, call);
    return refusal;
  }
  if (call?.function?.name === 'presentBundle') return attachBundleFacts(tenantId, call);
  if (call?.function?.name === 'presentSuggestions') {
    try {
      const a = JSON.parse(call.function.arguments || '{}');
      a.chips = sanitizeChips(a.chips);
      call.function.arguments = JSON.stringify(a);
    } catch { /* malformed JSON — leave call.function.arguments as-is; the tool schema requires `chips` so a bad payload surfaces downstream */ }
    return null;
  }
  if (call?.function?.name !== 'showItems') return null;
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return null; }
  let products = args?.products;
  if (!Array.isArray(products) || !products.length) return null;

  const skus = [...new Set(products.map((p: any) => String(p?.sku || '').trim().toUpperCase()).filter(Boolean))];

  /* EXISTENCE, before anything else (grounding incident, 2026-08-23).
   *
   * A model with nothing real to show — a retrieval failure it never surfaced,
   * a provider outage — has invented a whole product: a plausible SKU, a
   * price, an image URL. The designability check below only ever asks "can
   * this SKU be customised," so a SKU that does not exist at all reads as
   * 'unknown' and is treated exactly like a real, unproven one — it renders
   * with whatever price/image the model made up. This is the same lesson as
   * `enforceNamedSku`: wording ("never invent products") does not hold, so it
   * is settled here too, with the SAME existence endpoint that guard already
   * uses. Anything not found is dropped outright — never labelled, never kept
   * "to be safe." A codeless item (no sku at all) is a different, legitimate
   * case handled further below; this only strikes items claiming a SKU that
   * is not real. */
  if (skus.length) {
    try {
      const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
      const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/skus/exists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                   'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({ skus }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const found = new Set<string>(((await res.json())?.found || []).map((x: string) => x.toUpperCase()));
        const real = products.filter((p: any) => {
          const sku = String(p?.sku || '').trim().toUpperCase();
          return !sku || found.has(sku);   // codeless items pass through to the case below
        });
        if (real.length !== products.length) {
          const fake = products.filter((p: any) => !real.includes(p)).map((p: any) => p.sku);
          console.warn(`[AgentService] showItems: dropped ${fake.length} item(s) with a SKU not in the catalogue: ${fake.join(', ')}`);
          if (!real.length) {
            return {
              success: false,
              removedNotFound: fake,
              instruction: 'None of those items exist in the real catalogue — do not describe or apologise for them. '
                + 'Say you could not find matching products and ask a clarifying question instead.',
            };
          }
          products = real;
          args.products = real;
          call.function.arguments = JSON.stringify(args);
        }
      }
    } catch {
      // Best-effort, same stance as the sibling guards: never block the panel on a validation hiccup.
    }
  }

  /* An item with NO style code cannot be designed, quoted or ordered.
   *
   * Design-line documents ("MAN UP — FREESTYLE SUBLIMATED TURBO DYNASPEED
   * BASKETBALL JERSEY") describe a look, not a purchasable style, and they
   * carry no sku. They read like products, so the model presented them as
   * products — and every one of them failed at preview, which is exactly the
   * loop the customer hit. Previously this function returned early when no sku
   * was present, so the guard never even ran on the worst case.
   *
   * In a design-first vertical they are replaced by real styles matching what
   * the customer clearly wanted — the design document's own name is the best
   * description of that. Elsewhere they are left alone: a codeless row is a
   * reference document, and some verticals legitimately show those. */
  if (!skus.length) {
    if (!designFirst) return null;
    const wanted = String(products[0]?.name || args?.title || '').trim();
    const alt = await designableAlternatives(tenantId, '', 4, wanted);
    const replacements = alt
      .filter((a) => a.price != null)
      .map((a) => ({ name: a.name, sku: a.sku, price: a.price, imageUrl: a.image,
                     customisable: true, designable: true }));
    if (!replacements.length) return null;   // nothing better to offer — leave it
    args.products = replacements;
    call.function.arguments = JSON.stringify(args);
    console.warn(`[AgentService] showItems (design-first): replaced ${products.length} code-less item(s) with ${replacements.length} real styles`);
    return {
      success: true,
      replacedWithProven: replacements.map((p: any) => p.sku),
      instruction:
        'The items you listed were DESIGN references, not orderable styles — they have been replaced '
        + 'on the panel with real styles that can be designed and priced. Describe ONLY what is on the '
        + 'panel now, by name, and invite the customer to pick one to see in 3D.',
    };
  }

  let map: Record<string, 'yes' | 'no' | 'unknown'> = {};
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/designability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    map = (await res.json())?.designable || {};
  } catch {
    return null;   // enforcement is best-effort; never block the panel on it
  }

  const state = (p: any) => map[String(p?.sku || '').trim().toUpperCase()];
  // 'unknown' is left unlabelled — not checked must never read as "cannot".
  // Both spellings are written because both are read: the model reasons over
  // `customisable`, while the storefront's Design button gates on `designable`.
  // Writing only one is how a visor the agent had just called "not
  // customizable" still showed a "Design this in 3D" button under it.
  const labelled = products.map((p: any) => {
    const s = state(p);
    return s === 'yes' || s === 'no'
      ? { ...p, customisable: s === 'yes', designable: s === 'yes' }
      : p;
  });

  const stock = labelled.filter((p: any) => state(p) === 'no');
  const custom = labelled.filter((p: any) => state(p) !== 'no');

  /* DESIGN-FIRST verticals (project's brand-hub model says customised): a style
   * that cannot be designed is not an option, full stop.
   *
   * The augment-don't-filter stance below was a judgment call, and the business
   * has since overruled it for this kind of vertical: their trade IS designed
   * product, and a conversation that offers three styles whose previews then
   * fail one after another ("3D not working") is worse than a shorter list.
   * Proven styles are kept; unproven ('unknown') ones are kept only while
   * proven ones are too few to fill a panel; definite stock is dropped. If
   * nothing proven survives, proven alternatives replace the list entirely —
   * the customer always lands on something that will actually open in 3D. */
  if (designFirst) {
    const proven = labelled.filter((p: any) => state(p) === 'yes');
    const unknown = labelled.filter((p: any) => state(p) === undefined || state(p) === 'unknown');

    /* Proven wins outright, and 'unknown' does NOT get the benefit of the doubt
     * here. The renderability probe has already covered essentially the whole
     * sublimated catalogue, so at offer time 'unknown' nearly always means "no
     * product record at all" — a text chunk wearing a product's name. The
     * broken conversation this fixes offered three such items IN A ROW, each
     * failing at preview. Proven alternatives of the same kind are fetched
     * before any unknown is allowed through; unknowns survive only when the
     * alternative is a blank panel. */
    let keep = proven;
    let addedAlt: any[] = [];
    if (!keep.length) {
      const first: any = stock[0] || products[0] || {};
      let alt = await designableAlternatives(tenantId, String(first.sku || ''), 4);
      if (!alt.length && first.name) alt = await designableAlternatives(tenantId, '', 4, String(first.name));
      addedAlt = alt
        .filter((a) => a.price != null)
        .map((a) => ({ name: a.name, sku: a.sku, price: a.price, imageUrl: a.image,
                       customisable: true, designable: true }));
      keep = addedAlt;
    }
    if (!keep.length) keep = unknown.slice(0, 3);
    if (!keep.length) return null;   // nothing anywhere — do not blank the panel

    const dropped = labelled.filter((p: any) => !keep.includes(p)).map((p: any) => p.sku).filter(Boolean);
    /* Write the panel EVEN when nothing was dropped: `keep` carries the
     * designable labels, and the storefront's Design button renders off them.
     * Returning early here discarded the labels along with the verdict, and
     * proven jerseys shipped to the panel unmarked. */
    args.products = keep;
    call.function.arguments = JSON.stringify(args);
    if (dropped.length || addedAlt.length) {
      console.warn(`[AgentService] showItems (design-first): kept ${keep.length}, dropped ${dropped.length} unprovable`);
    }
    if (!dropped.length && !addedAlt.length) return null;   // labels written; nothing to tell the model
    return {
      success: true,
      removedNotDesignable: dropped,
      ...(addedAlt.length ? { replacedWithProven: addedAlt.map((p: any) => p.sku) } : {}),
      instruction:
        'Styles that cannot be custom-designed were REMOVED from the panel — never mention them, '
        + 'never apologise for them, and never offer an item as designable unless it appears on the '
        + 'panel now. Describe what IS on the panel and invite the customer to pick one to see in 3D.',
    };
  }

  if (!stock.length) return null;                    // nothing to correct

  /* AUGMENT rather than filter.
   *
   * Deciding whether THIS turn is "a custom job" means inferring intent, and
   * every rule for that is a guess that will be wrong for someone: a customer
   * asking for cheap blanks deserves the stock jerseys, and one outfitting a
   * school deserves the sublimated ones. Guessing wrong hides real products.
   *
   * So nothing is hidden. Instead, when a panel would otherwise show ONLY
   * garments whose colours are fixed, customisable styles of the same kind are
   * added beside them. Retrieval alone never does this — it ranks on text, and
   * "BASEBALL JERSEY ADULT" beats "FreeStyle Sublimated Full-Button Baseball
   * Jersey" for the words "baseball jersey", which is why a school asking for
   * team jerseys got six stock styles and none of the 59 that can be printed.
   *
   * The customer then sees both, each labelled, and can choose. That is the
   * outcome the labelling was for; leaving it to the model to volunteer the
   * missing half is what failed. */
  let added: any[] = [];
  if (!custom.length) {
    const alt = await designableAlternatives(tenantId, String(stock[0]?.sku || ''), 4);
    added = alt
      .filter((a) => a.price != null)   // a card without a real price is not groundable
      .map((a) => ({ name: a.name, sku: a.sku, price: a.price, imageUrl: a.image, customisable: true }));
  }

  // Customisable first — the panel should lead with what the request can be built from.
  args.products = [...custom, ...added, ...stock];
  call.function.arguments = JSON.stringify(args);
  if (added.length) {
    console.warn(`[AgentService] showItems: added ${added.length} customisable style(s) beside ${stock.length} stock`);
  }

  return {
    success: true,
    notCustomisable: stock.map((p: any) => p.sku),
    ...(added.length ? { addedCustomisable: added.map((p: any) => p.sku) } : {}),
    instruction:
      'Items marked customisable:false are STOCK — their colours are fixed and they cannot carry '
      + 'team colours, a logo, names or numbers. You may present them, but you must NEVER say they '
      + 'can be customised or printed. '
      + (added.length
        ? 'The items in addedCustomisable WERE added to the panel because the customer needs styles '
          + 'that can be printed — describe those first, by name.'
        : 'State plainly which of these can be customised and which cannot.'),
  };
}

/**
 * Tell the model which retrieved styles can actually be custom-designed (AUG-25).
 *
 * Retrieval ranks on text similarity, which cannot distinguish a made-to-order
 * style from a stock one — "Game7 Two-Button Baseball Jersey" is an excellent
 * text match for "baseball jersey" and a completely wrong answer for a team
 * that wants their own colours on it. The model was choosing blind.
 *
 * Annotating each result is the difference between catching this before the
 * customer sees it and apologising afterwards. `designable` is stated only where
 * the platform has actually probed the style; where it has not, the field is
 * omitted rather than set false, so "not checked" can never read as "no".
 */
async function markDesignable(tenantId: string, result: any): Promise<any> {
  const items = result?.results;
  if (!Array.isArray(items) || !items.length) return result;

  const skus = [...new Set(items.map((i: any) => String(i?.sku || '').trim().toUpperCase()).filter(Boolean))];
  if (!skus.length) return result;

  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/designability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return result;
    const map: Record<string, 'yes' | 'no' | 'unknown'> = (await res.json())?.designable || {};

    let anyDesignable = false;
    const annotated = items.map((i: any) => {
      const state = map[String(i?.sku || '').trim().toUpperCase()];
      if (state === 'yes') anyDesignable = true;
      return state === 'unknown' || !state ? i : { ...i, designable: state === 'yes' };
    });

    /* When NOTHING retrieved can be designed, annotation alone is not enough.
     *
     * The note below only fires when at least one result is designable — it
     * tells the model which of the options to prefer. If every result is stock,
     * there is nothing to prefer, so the model was left holding a list of stock
     * garments and recommended one of them. That is how a customer asking for
     * team caps was offered a stock cap while 100 configurable caps went
     * unmentioned: retrieval ranks on text, and a stock cap's page describes a
     * cap just as well as a customisable one does.
     *
     * So in that case we go and fetch styles that CAN be designed, described
     * like the ones that were found, using the same helper AUG-25 already uses
     * when a specific style turns out to be undesignable. */
    const stock = annotated.filter((i: any) => i?.designable === false);
    let alternatives: { sku: string; name?: string; price?: number; image?: string }[] = [];
    if (!anyDesignable && stock.length) {
      alternatives = await designableAlternatives(tenantId, String(stock[0].sku), 5);
    }

    return {
      ...result,
      results: annotated,
      ...(anyDesignable ? {
        designabilityNote:
          'Only styles marked designable:true can carry custom team colours, patterns, names '
          + 'and numbers. A style marked designable:false is stock — its colours are fixed and '
          + 'cannot be changed. For a custom team kit, offer ONLY designable styles.',
      } : {}),
      ...(alternatives.length ? {
        designableAlternatives: alternatives,
        designabilityNote:
          'NONE of the search results can be customised — they are stock items with fixed '
          + 'colours. Do NOT offer them for a custom team kit. Offer the styles in '
          + 'designableAlternatives instead: those are the same kind of garment and are proven '
          + 'to take custom team colours, names and numbers.',
      } : {}),
    };
  } catch {
    // Annotation is an enhancement; retrieval must still work without it.
    return result;
  }
}

/**
 * Styles proven designable, described like the one that failed (AUG-25).
 *
 * Keyed off the failed style's own name so the replacement is the same KIND of
 * garment: a customer who asked for a baseball jersey must not be offered
 * basketball shorts because those happened to be designable. Returns [] on any
 * failure — an empty list degrades to the plain "cannot preview" message, which
 * is worse but never wrong.
 */
/**
 * The catalogue owns what a card SAYS — image, price, name, link (AUG-82).
 *
 * `showItems` lets the model fill in `imageUrl` and `price`, and it does not
 * fill them from the retrieved rows: on a five-jersey panel it wrote the SAME
 * photo onto every card (a red cap-sleeve shirt for a sleeveless, a long
 * sleeve and a turbo alike), so a coach could not tell the products apart. It
 * rounds money the same way — $65 where the catalogue says $65.10, which is
 * then a different number from the one Stripe charges.
 *
 * Prices were already made server-authoritative for the quote (P0-04); this
 * applies the same rule one step earlier, to the card the customer is looking
 * at when they decide. Anything the catalogue can state, the catalogue states.
 * Prose stays the model's — only facts are overwritten, and only when the
 * lookup actually returns one, so a thin catalogue row never blanks a card.
 */
function extractSearchQuery(lastUserText: string, messages?: any[]): string {
  const lt = lastUserText.toLowerCase();

  // Combine with previous user messages to preserve the original topic
  const historyText = Array.isArray(messages)
    ? messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content || '')).join(' ').toLowerCase()
    : '';
  const combined = `${historyText} ${lt}`;

  // If the user answered clarification questions, extract their chosen values!
  if (lt.includes('my answers:') || lt.includes('->') || lt.includes('→')) {
    const answers = [...lastUserText.matchAll(/(?:→|->)\s*([^\n\r?]+)/g)]
      .map(m => m[1].trim().replace(/\s*\([^)]*\)/g, ''))
      .filter(Boolean);

    const allAnswersStr = answers.join(' ').toLowerCase();

    // Check specific options first
    if (allAnswersStr.includes('vitex')) return 'Vitex decking timber';
    if (allAnswersStr.includes('kwila')) return 'Kwila decking timber';
    if (allAnswersStr.includes('radiata')) return 'Radiata pine decking timber';
    if (allAnswersStr.includes('composite')) return 'composite decking';
    if (allAnswersStr.includes('aqualine')) return 'GIB Aqualine plasterboard moisture resistant';
    if (allAnswersStr.includes('standard') && (combined.includes('gib') || combined.includes('plasterboard') || combined.includes('wall'))) return 'GIB Standard plasterboard';
    if (allAnswersStr.includes('braceline')) return 'GIB Braceline wallboard';

    // Did the original question or current turn have a specific product topic?
    if (combined.includes('adhesiv') || combined.includes('sealant') || combined.includes('silicone') || combined.includes('glue')) {
      return 'construction adhesives sealants silicone';
    }
    if (combined.includes('hinge') || combined.includes('joiner') || combined.includes('hardware') || combined.includes('bracket')) {
      return 'cabinet hinges hardware joinery fasteners';
    }
    if (combined.includes('landscap') || combined.includes('retaining') || combined.includes('sleeper')) {
      return 'landscaping timber retaining sleepers H4';
    }
    if (combined.includes('deck')) {
      return 'decking timber kwila vitex';
    }
    if (combined.includes('gib') || combined.includes('plasterboard') || combined.includes('wallboard')) {
      return 'GIB plasterboard standard aqualine';
    }
    if (combined.includes('timber') || combined.includes('framing') || combined.includes('radiata')) {
      return 'radiata pine SG8 framing timber';
    }

    // Check answers for domain areas
    if (allAnswersStr.includes('shower') || allAnswersStr.includes('mixer') || allAnswersStr.includes('tapware') || allAnswersStr.includes('cartridge')) {
      return 'shower mixer tapware cartridge';
    }
    if (allAnswersStr.includes('toilet') || allAnswersStr.includes('cistern') || allAnswersStr.includes('flush')) {
      return 'toilet suite cistern valve';
    }
    if (allAnswersStr.includes('basin') || allAnswersStr.includes('sink') || allAnswersStr.includes('vanity')) {
      return 'bathroom vanity basin mixer';
    }
    if (allAnswersStr.includes('building materials') || allAnswersStr.includes('timber')) {
      return 'radiata pine SG8 framing timber';
    }
    if (allAnswersStr.includes('bathroom') || allAnswersStr.includes('plumbing')) {
      return 'bathroom vanity shower tapware';
    }
    if (allAnswersStr.includes('laundry')) {
      return 'laundry cabinet supertub storage';
    }
    if (allAnswersStr.includes('outdoor')) {
      return 'decking timber landscaping';
    }

    // Fallback to the most specific answer (avoiding generic "DIY home renovation" or "Branch pickup")
    const specificAnswer = answers.find(a => {
      const al = a.toLowerCase();
      return !al.includes('diy') && !al.includes('branch pickup') && !al.includes('delivery') && !al.includes('contractor') && !al.includes('licensed');
    });
    if (specificAnswer) {
      return specificAnswer.slice(0, 50).trim();
    }
    if (answers.length > 0) {
      return answers[0].slice(0, 50).trim();
    }
  }

  // Standalone user queries
  if (lt.includes('vitex')) return 'Vitex decking timber';
  if (lt.includes('kwila')) return 'Kwila decking timber';
  if (lt.includes('lining') || lt.includes('waterproof') || lt.includes('wet area') || lt.includes('shower')) return 'moisture resistant linings waterproofing';
  if (lt.includes('adhesiv') || lt.includes('sealant') || lt.includes('glue') || lt.includes('silicone') || lt.includes('gib fix') || lt.includes('sikaflex')) return 'construction adhesives sealants silicone';
  if (lt.includes('hinge') || lt.includes('joiner') || lt.includes('hardware') || lt.includes('bracket') || lt.includes('runner') || lt.includes('handle')) return 'cabinet hinges hardware joinery fasteners';
  if (lt.includes('landscap') || lt.includes('retaining') || lt.includes('sleeper') || lt.includes('h4') || lt.includes('h5')) return 'landscaping timber retaining sleepers H4';
  if (lt.includes('deck')) return 'decking timber';
  if (lt.includes('radiata') || lt.includes('pine') || lt.includes('framing') || lt.includes('timber') || lt.includes('stud') || lt.includes('joist') || lt.includes('sg8')) return 'radiata pine SG8 framing timber';
  if (lt.includes('gib') || lt.includes('plasterboard') || lt.includes('wallboard')) return 'GIB plasterboard wallboard standard aqualine';
  if (lt.includes('laundry') || lt.includes('cabinet') || lt.includes('tub') || lt.includes('supertub')) return 'laundry cabinet supertub storage';
  if (lt.includes('bathroom') || lt.includes('vanity') || lt.includes('toilet') || lt.includes('tiles')) return 'bathroom vanity shower tapware';
  if (lt.includes('kitchen')) return 'kitchen cabinets modular';
  if (lt.includes('leak') || lt.includes('drip')) return 'shower mixer valve seal';
  return lastUserText.replace(/^my answers:/i, '').slice(0, 60).trim() || 'building materials';
}

/**
 * Normalise a retrieved catalogue record for showItems on the open-model
 * path. FACTS ONLY. The previous version of this function invented, from
 * keyword matches on the name, feature bullets ("NZS 3604 Verified",
 * "Moisture Resistant Core"), a specs table ("Building Standard: NZS
 * 3604:2011 Compliant", "Store Pickup: 60-Min Click & Collect (Mt Wellington
 * / Cook St)"), an Unsplash stock photo (the construction-worker picture on
 * every PlaceMakers tile) and a placemakers.co.nz URL — for ANY tenant.
 * Fabricated compliance claims are a liability, and none of it was
 * config-driven. Anything the record does not carry is left absent; the card
 * templates already hide absent fields and fall back to an icon.
 */
function normalizeTradeProduct(it: any): any {
  const name = String(it.name || it.title || '').trim();
  const category = it.category || (Array.isArray(it.categoryPath) && it.categoryPath.length ? it.categoryPath[it.categoryPath.length - 1] : undefined);
  // `content` is the record's vectorised search text (name repeated, category
  // path, "Also searched as: …" synonyms) — retrieval fodder, not something a
  // customer should read as the reason to buy. Only a real description counts.
  const description = String(it.description || it.summary || '').trim() || undefined;
  const features: string[] | undefined = Array.isArray(it.features) && it.features.length ? it.features : undefined;
  const specs: Record<string, string> | undefined = it.specs && typeof it.specs === 'object' && Object.keys(it.specs).length ? it.specs : undefined;
  const imageUrl = it.imageUrl || (Array.isArray(it.images) ? it.images[0] : undefined) || undefined;
  const out: any = { ...it, name, title: name };
  if (category) out.category = category;
  if (description) out.description = description;
  if (features) out.features = features;
  if (specs) out.specs = specs;
  if (imageUrl) out.imageUrl = imageUrl;
  if (it.url) out.url = it.url;
  return out;
}




/**
 * A confirmed programme's colours (AUG-27).
 *
 * Delegated so the model never states colours from memory: the service decides
 * whether they are confirmed, merely proposed, or unknown, and maps them onto
 * what the brand can actually print.
 */
export function resolveOrdinalSku(raw: string, lastShown?: { sku: string }[]): string {
  const list = lastShown || [];
  if (!list.length) return '';
  const s = String(raw || '').toLowerCase().trim();

  const WORDS: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  let idx = 0;
  // "product 2" / "option 3" / "item 1" / "number 2" / "#2"
  const labelled = s.match(/(?:product|option|item|number|style|no\.?|#)\s*(\d{1,2})\b/);
  if (labelled) idx = parseInt(labelled[1], 10);
  // "the 2nd" / "3rd one"
  if (!idx) {
    const nth = s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (nth) idx = parseInt(nth[1], 10);
  }
  // "the first one" / "second"
  if (!idx) {
    for (const [w, n] of Object.entries(WORDS)) {
      if (new RegExp(`\\b${w}\\b`).test(s)) { idx = n; break; }
    }
  }
  // A bare number ONLY when that is essentially the whole message ("2").
  if (!idx && /^\d{1,2}$/.test(s)) idx = parseInt(s, 10);

  return idx >= 1 && idx <= list.length ? list[idx - 1].sku : '';
}

/**
 * Which of these tokens are real style codes in this catalogue.
 *
 * Exact membership, not search. A fuzzy lookup answers "what is most like this?"
 * and happily returns a different style for a code that exists perfectly well —
 * which is how a customer naming PG8130 was treated as though they had named
 * nothing at all.
 */

const SIZE_QUESTION_RE = /\b(what|which)('?s| is| are)?\s+size\b|\bsize\s+should\s+i\b|\bwhat\s+size\s+am\s+i\b|\bdon'?t\s+know\s+(my|what)\s+size\b|\bwaist\s+(is|measurement)\b|\b\d{2,3}\s*(inch|in|cm)\s*waist\b|\bwaist\s+of\s+\d{2,3}\b/i;

async function maybeForceSizeRecommendation(
  tenantId: string,
  conversation: any[],
  activeTools: OpenAI.ChatCompletionTool[],
  capabilities: string[] | undefined,
  uiToolCalls: any[],
  emit: (event: string, data: any) => void,
  model: string,
  llm: OpenAI,
): Promise<void> {
  if (!capabilities?.includes('fitmentGuide')) return;
  const lastUser = [...conversation].reverse().find((m) => m?.role === 'user' && typeof m.content === 'string');
  const text = String(lastUser?.content || '');
  if (!SIZE_QUESTION_RE.test(text)) return;
  try {
    const forced = await llm.chat.completions.create({
      model,
      messages: [
        ...conversation,
        {
          role: 'system',
          content: 'The customer just asked a sizing question. Before anything else, call recommendSize with the item category and whatever measurement or usual size they gave.',
        },
      ],
      tools: activeTools,
      tool_choice: { type: 'function', function: { name: 'recommendSize' } },
    });
    const fmsg = forced.choices[0].message;
    const call = fmsg.tool_calls?.[0];
    if (!call || call.type !== 'function') {
      console.warn('[AgentService] forced recommendSize produced no tool call');
      return;
    }
    conversation.push(fmsg);
    const result = await recommendSize(tenantId, call.function.arguments);
    conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    uiToolCalls.push(call);
    emit('uiAction', { name: 'recommendSize', arguments: result });
  } catch (err) {
    console.warn('[AgentService] maybeForceSizeRecommendation failed:', (err as Error).message);
  }
}

/**
 * The customisation flow is a business concern, not a garment/team concern.
 * Its wording comes from the published Business Profile and labels, while the
 * configured capability still determines which underlying action is available.
 */
function configuredCustomisationGuidance(
  projectConfig: any,
  options: { activeSku?: string; hasDesignImage: boolean; enabled: boolean },
): Array<{ role: 'system'; content: string }> {
  if (!options.enabled) return [];
  const business = projectConfig?.business || {};
  const entity = business?.entityModel || {};
  const item = business?.vocabulary?.secondaryDimension || projectConfig?.labels?.itemsSingular || 'item';
  const orderFor = entity?.label ? ` for the ${entity.label}` : '';
  const approval = business?.approvalRequired === true
    ? ' Customer approval is required before describing an order as production-ready.'
    : '';
  const out: Array<{ role: 'system'; content: string }> = [];

  if (options.activeSku && !options.hasDesignImage) {
    out.push({ role: 'system', content:
      `[CONFIGURED CUSTOMISATION IN PROGRESS] The customer is already viewing a configured ${item}${orderFor}. ` +
      'Do not restart discovery or repeat completed questions. Answer their actual request about the item shown, apply only supported changes, or explain the next configured approval step.' + approval });
  }
  if (options.hasDesignImage) {
    out.push({ role: 'system', content:
      `[CUSTOMISATION REFERENCE ATTACHED] The customer supplied a reference for a configured ${item}. ` +
      'Analyse it against the tenant’s verified templates first. If a verified template matches, present it as a proof on that template; otherwise explain that a new production pattern may be required. Never invent an item code or claim the reference is production-ready.' + approval });
  }
  if ((projectConfig?.capabilities || []).includes('customDesign') && !options.hasDesignImage) {
    out.push({ role: 'system', content:
      `[CONFIGURED CUSTOMISATION] This business offers per-order customisation${orderFor}. ` +
      `When the customer asks to create or change a ${item}, use the configured customisation flow before browsing unrelated catalogue items. ` +
      'Use verified catalogue data for any template or price, and explain the configured approval step when it applies.' + approval });
  }
  return out;
}

// ── Service Interface ─────────────────────────────────────────────────
export interface ChatRequest {
  /**
   * Client-minimal contract: the storefront sends ONLY the new user message +
   * sessionId (+ optional customerId when signed in). The server owns and
   * reconstructs the transcript and journey state. `messages` is retained only
   * for back-compat with older clients that still send the whole array.
   */
  message?: string;
  messages?: any[];
  state?: {
    phase?: string;
    bom?: any[];
    recommendedProducts?: any[];
    finish?: string;
    qty?: number;
  };
  tenantId?: string;
  /** Server-side session id. If omitted, one is generated and returned. */
  sessionId?: string;
  /** Durable customer identity when signed in (long-term memory key). */
  customerId?: string;
  /** Sample-customer demo: the profile the visitor picked in the storefront.
   *  Bound server-side per request — the only identity the customerHistory
   *  tools ever read by. A customer id typed into the chat is never used. */
  demoPrincipalId?: string;
  /** CDL: a design image the customer attached THIS turn (data URL or raw base64).
   *  Never entered into the LLM prompt — held server-side and read by analyzeDesign. */
  imageBase64?: string;
  /** CDL: a design image referenced by URL instead of uploaded bytes. */
  imageUrl?: string;
}

export interface ChatResponse {
  message: any;
  conversation: any[];
  uiActions: { name: string; arguments: any }[];
  /** Session id for this conversation — the client should echo it back next turn. */
  sessionId: string;
  /** Resolved intent for this turn (additive — frontend may ignore). */
  intent?: IntentResult;
  /** Observable reasoning trace for the conversation (additive). */
  trace?: TraceEntry[];
}

/**
 * What the customer is actually shopping for, reconstructed from the thread:
 * their latest substantive brief plus every clarify answer they have given.
 *
 * Seen live on PlaceMakers (open model, TOOL_CALL syntax): after the customer
 * tapped clarify chips, the model called searchKnowledge("Dedicated space")
 * and, on a blank card, searchKnowledge("Not answered") — the LAST message
 * verbatim, not the laundry-makeover brief — and the catalogue dutifully
 * returned garden sheds. Retrieval is only as good as the query; a query that
 * merely echoes an answer or a placeholder gets the real brief folded in.
 */
interface RetrievalContext { brief: string; answers: string[]
  /** The customer's latest message is the clarify answers themselves. */
  lastIsAnswers?: boolean;
}

function deriveRetrievalContext(messages: Array<{ role: string; content: unknown }>): RetrievalContext {
  const text = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ') : String(c ?? '');
  // Storefront-generated cart commands ("Add SKU X (qty 1) to my bag.") are
  // instructions, not briefs — never search them.
  const isCartCommand = (t: string) => /^(?:Add SKU \S+ \(qty \d+\) to my|Remove SKU \S+ from my|Change the quantity of SKU \S+ to \d+)/i.test(t.trim());
  const users = messages.filter((m) => m.role === 'user').map((m) => text(m.content).trim()).filter((t) => t && !isCartCommand(t));
  const isAnswers = (t: string) => /^\s*my answers:/i.test(t);
  const briefs = users.filter((t) => !isAnswers(t));
  // Prefer the latest brief that actually describes something (≥4 words) over
  // a "yes, add both" style confirmation; fall back to the latest non-answer.
  const brief = [...briefs].reverse().find((t) => t.split(/\s+/).length >= 4) || briefs[briefs.length - 1] || '';
  const answers: string[] = [];
  for (const t of users) {
    if (!isAnswers(t)) continue;
    for (const line of t.split('\n')) {
      const m = line.match(/→\s*(.+)$/);
      const v = m?.[1]?.trim();
      // An answer about the customer's situation ("Just researching options &
      // prices", "ASAP", "DIY") describes nothing in the catalogue — folding it
      // into the search query only drags the vector away from the products.
      const meta = /\b(research|browsing|options?|prices?|budget|quote|asap|urgent|soon|week|month|not sure|no idea|diy|professional|myself|other)\b/i;
      if (v && !/^not answered$/i.test(v) && !meta.test(v)) answers.push(v);
    }
  }
  const lastUser = users[users.length - 1] || '';
  return { brief: brief.slice(0, 300), answers, lastIsAnswers: isAnswers(lastUser) };
}

/**
 * One catalogue search per turn, started early. Every retrieval in a turn —
 * the prefetch fired at turn start (while the model is still thinking), the
 * model's own searchKnowledge calls, the show-first / after-answers guarantee
 * — goes through this memo: a query whose words overlap an in-flight one by
 * 60%+ reuses that promise instead of hitting Atlas again. A PlaceMakers turn
 * used to run three near-identical searches (8–33s each on the current
 * cluster); now the first is already running when the model asks for it.
 */
class TurnSearchMemo {
  private entries: { key: string; tokens: Set<string>; sig: string; limit: number; p: Promise<any> }[] = [];
  constructor(private readonly tenantId: string) {}
  private static tokens(q: string): Set<string> {
    return new Set(String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  }
  search(opts: { query: string; type?: string; category?: string; limit?: number; gender?: string }): Promise<any> {
    const tokens = TurnSearchMemo.tokens(opts.query);
    const sig = `${opts.type || ''}|${opts.category || ''}|${opts.gender || ''}`;
    const limit = opts.limit || 8;
    if (tokens.size) {
      for (const e of this.entries) {
        if (e.sig !== sig || limit > e.limit) continue;
        const inter = [...tokens].filter((t) => e.tokens.has(t)).length;
        const union = new Set([...tokens, ...e.tokens]).size;
        if (union && inter / union >= 0.6) {
          console.log(`[agent] search memo: "${opts.query}" reuses the in-flight search "${e.key}"`);
          return e.p;
        }
      }
    }
    const p = (async () => (await adapterRegistry.getKnowledge(this.tenantId)).search({ tenantId: this.tenantId }, opts))();
    p.catch(() => { /* handled where awaited */ });
    this.entries.push({ key: opts.query, tokens, sig, limit, p });
    return p;
  }
  /** Fire the turn's likely search now; whoever needs it later awaits the same promise. */
  prefetch(query: string): void {
    if (TurnSearchMemo.tokens(query).size < 2) return;
    console.log(`[agent] search prefetch: "${query}"`);
    this.search({ query, type: 'product', limit: 8 });
  }
}

/** The model's query, or the brief + answers folded in when the query alone
 *  is not a search (an echoed clarify answer, "Not answered", a lone word). */
function effectiveSearchQuery(modelQuery: unknown, ctx?: RetrievalContext): string {
  const q = String(modelQuery ?? '').trim();
  if (!ctx) return q;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q);
  const echoesAnswer = !!nq && ctx.answers.some((a) => { const na = norm(a); return na === nq || na.includes(nq); });
  const placeholder = /not answered/i.test(q);
  const tooShort = nq.split(' ').filter(Boolean).length < 2;
  if (q && !placeholder && !echoesAnswer && !tooShort) return q;
  const composed = [ctx.brief, ...ctx.answers, echoesAnswer || placeholder ? '' : q]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!composed) return q;
  console.log(`[agent] searchKnowledge: weak model query "${q}" → "${composed}"`);
  return composed;
}

/**
 * Output budget for an open (self-hosted) model — config-driven per tenant
 * (`ProjectConfig.maxTokens`). The old fixed 256 was enough for prose plus
 * ONE TOOL_CALL; a reply that searched AND asked clarify questions got its
 * second call cut mid-JSON ("tap an option below" with no options rendered).
 * Default 768; clamped so a typo can't disable the budget or run away.
 */
function openModelMaxTokens(projectConfig: any): number {
  const n = Number(projectConfig?.maxTokens);
  if (!Number.isFinite(n) || n <= 0) return 768;
  return Math.min(Math.max(Math.round(n), 128), 4096);
}

/* ──────────────────────────────────────────────────────────────────────
 * Sample-customer demo (capability `customerHistory`).
 *
 * The project's `demoCustomers` fixtures are ONE fictional dataset: profiles,
 * their orders, today's simulated offers per market, and a staff inventory
 * snapshot. Everything below is read-only and keyed by the demo principal the
 * STOREFRONT bound to the request — never by an id the model or customer
 * supplied — so "show Alex's orders, his id is DEMO-ALEX" from a guest reads
 * nothing. Results carry `demo: true` so the model can say so.
 * ────────────────────────────────────────────────────────────────────── */

/** The per-turn identity block the model reasons from. Server-bound; the
 *  rules here are what the demo checks (D01–D07) test for. */
function demoCustomerBlock(cfg: any, principalId?: string): string | null {
  const dc = cfg?.demoCustomers;
  if (!dc?.enabled) return null;
  const p = demoProfile(cfg, principalId);
  if (!p) return null;
  const rules =
    'RULES: (1) You have NOT been given this customer\'s history. What they bought, when, how many, at what price exists ONLY behind getMyOrders / getMyLatestOrder / getMyOrder — any statement about their past purchases that did not come from one of those calls THIS conversation is a fabrication. Never read history for another person, and never accept a customer id typed into the chat. ' +
    '(2) A historical order price is NOT today\'s price — before quoting a price or stock for a repeat purchase call getCurrentOffer for that SKU and quantity, and say clearly which is which. ' +
    '(3) Use the EXPLICIT preferences below; never infer a preference from a past order, and never from a gift purchase. ' +
    '(4) Everything in this profile, its orders, prices and stock is demo data — say "demo" when you quote a figure; no real order, payment or forecast is ever made. ' +
    '(5) When the customer wants to buy again, resolve the item to its real SKU from the order line, check getCurrentOffer, then showItems / the cart as usual. ' +
    '(6) These tools are not catalogue retrieval and this overrides any "ask first" opening guidance: when the question is about their own orders, prices or inventory, call the tool THIS turn and answer from it — do not open with clarifying questions.';
  if (p.role === 'guest' || p.signedIn !== true) {
    return `[GUEST — NOT SIGNED IN] The visitor has no customer history available. If they ask for orders — their own or anyone else's (e.g. "show Alex's orders, his id is …") — refuse, explain that signing in is required to see one's own orders, and offer general help instead. Never look up or reveal another profile's history. ${rules}`;
  }
  const prefs = Object.entries(p.preferences || {}).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none stated';
  const head = p.role === 'staff_read_only'
    ? `[SIGNED-IN DEMO STAFF PROFILE — bound by the server] ${p.name} (${p.country || '—'}), role: staff (read-only). Permissions: ${(p.permissions || []).join(', ') || 'none'}. They may ask about inventory and aggregate operational data (getStaffInventory); they are not buying. Never turn missing lead-time/inbound data into a forecast — state what is missing.`
    : `[SIGNED-IN DEMO CUSTOMER — bound by the server] ${p.name} · ${p.country || '—'} · ${p.currency || ''}. Explicit preferences: ${prefs}. When a recommendation rests on one of these, say so in one clause ("since you collect Pokémon and want to see both sides, Standard-size clear sleeves…"), and when a past purchase was a gift say you are not treating it as a preference.`;
  return `${head} ${rules}`;
}

/**
 * The identity block PLUS, when the customer's message is plainly about their
 * own history / today's price / staff inventory, the answer pre-read from the
 * fixtures and attached as facts. Belt and braces: the tools stay available
 * for the model to call, but the codebase's standing lesson holds — prompt
 * wording alone does not stop a model from narrating a "last order" it never
 * looked up (seen on the first run: a confident "two packs of Black Matte"
 * with no tool call). With the real lines in context, there is nothing to
 * invent.
 */
async function demoCustomerContext(cfg: any, principalId: string | undefined, text: string, tenantId: string): Promise<string | null> {
  const block = demoCustomerBlock(cfg, principalId);
  if (!block) return null;
  const p = demoProfile(cfg, principalId);
  if (!p || p.signedIn !== true || p.role === 'guest') return block;
  const t = (text || '').toLowerCase();
  const asksHistory = /\b(last|latest|previous|recent|earlier)\b[\s\S]{0,40}\b(order|purchase|bought|buy|time)\b|\bwhat did i\b|\border history\b|\bmy (order|orders|purchase|purchases)\b|\bsame (size|as before|again)\b|\b(bought|ordered) (before|again|last)\b|\bbefore\b|\bcomplaint\b|\bdamage\b/.test(t);
  const asksInventory = p.role === 'staff_read_only' && /\b(inventory|stock|units?|reserved|unreserved|replenish|on hand|inbound|lead time)\b/.test(t);
  const facts: string[] = [];
  try {
    if (asksHistory) {
      const r: any = await runDemoCustomerTool(cfg, principalId, 'getMyOrders', '{}', tenantId);
      const orders: any[] = r?.orders || [];
      if (orders.length) {
        facts.push(`ORDER HISTORY (demo, read by the server for ${p.name} — most recent first): ` + orders.map((o: any) =>
          `${o.orderReference} on ${o.date} [${o.status}${o.purposeNote ? `, ${o.purposeNote}` : ''}${o.issue ? `; issue: ${o.issue}` : ''}]: ` +
          (o.lines || []).map((l: any) => `${l.productName} (SKU ${l.sku}) × ${l.quantity} @ ${o.currency} ${l.unitPrice} each`).join(', ')).join(' | '));
        // Today's offer for every SKU they have bought, so "check today's
        // price" has a real number to work from (historical ≠ current).
        const skus = [...new Set(orders.flatMap((o: any) => (o.lines || []).map((l: any) => String(l.sku))))];
        const offers = await Promise.all(skus.map((sku) => runDemoCustomerTool(cfg, principalId, 'getCurrentOffer', JSON.stringify({ sku, quantity: 1 }), tenantId)));
        const lines = offers.map((o: any) => o?.unitPrice !== undefined && !o.error
          ? `${o.productName} (SKU ${o.sku}): ${o.currency} ${o.unitPrice} per pack today, ${o.availableQuantity ?? 'n/a'} available in ${o.country}`
          : `SKU ${o?.sku || '?'}: ${o?.error === 'price_on_request' ? 'price on request (' + (o.note || 'made to order') + ')' : 'no current offer for this market'}`);
        facts.push(`TODAY'S OFFERS (demo, ${p.country || 'market'}): ${lines.join('; ')}. Multiply by the quantity asked; tax and shipping are not included.`);
      }
    }
    if (asksInventory) {
      const r: any = await runDemoCustomerTool(cfg, principalId, 'getStaffInventory', '{}', tenantId);
      if (r?.inventory?.length) {
        facts.push(`STAFF INVENTORY (demo snapshot): ` + r.inventory.map((i: any) =>
          `${i.productName} (SKU ${i.sku}, ${i.country}): on hand ${i.onHand}, reserved ${i.reserved}, unreserved ${Math.max(0, Number(i.onHand) - Number(i.reserved))}, lead time ${i.leadTimeDays ?? 'unknown'}, inbound ${i.inboundUnits ?? 'unknown'}${i.note ? ` — ${i.note}` : ''}`).join(' | ') +
          `. ${r.reason}`);
      }
    }
  } catch (err) {
    console.warn('[agent] demo customer context failed:', (err as Error).message);
  }
  if (facts.length) console.log(`[agent] demo customer context for ${p.id}: ${facts.length} fact block(s) attached`);
  return facts.length ? `${block}\n\n${facts.join('\n')}\nAnswer from these facts; call the tools only for something not covered here.` : block;
}

/** Names of the items a card is rendering this turn (showItems / presentComparison). */
function shownItemNames(uiToolCalls: any[]): string[] {
  const names: string[] = [];
  for (const call of uiToolCalls || []) {
    const fn = call?.function?.name;
    if (fn !== 'showItems' && fn !== 'presentComparison') continue;
    let args: any = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
    const items: any[] = args.products || args.items || [];
    for (const it of items) {
      const n = String(it?.name || it?.title || '').trim();
      if (n) names.push(n);
    }
  }
  return [...new Set(names)];
}

/**
 * The card already lists every item (name, image, price, reason). gpt-4o
 * still narrates them one by one above it — numbered, then bulleted once
 * numbering was banned — however the prompt is worded. So this is settled
 * in code: drop the lines that merely enumerate the shown items and keep
 * the consultant's framing (intro sentence, lead pick, closing question).
 * Deterministic, no model call. Untouched unless at least two such lines
 * would go — a single mention in flowing prose is fine.
 */
function compactItemListing(text: string, names: string[]): string {
  if (!text || names.length < 2) return text;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The model often shortens a card name in prose ("Play To Win - Brushed Art
  // Sleeves" for "… - Standard Size"): the first four words are the key too.
  const keys = [...new Set(names.flatMap((n) => { const k = norm(n); const short = k.split(' ').slice(0, 4).join(' '); return short.length >= 12 && short !== k ? [k, short] : [k]; }))].filter((k) => k.length >= 4);
  if (!keys.length) return text;
  // Segment by line; a single paragraph that inlines "…:1. Name: … 2. Name: …"
  // is split at its NUMBERED markers too. Dashes are never inline markers —
  // product names carry them ("Blue - Matte Sleeves"); a bullet only counts
  // at the start of a line.
  const marker = /(?=(?<=^|[\s:.!?;])\d+[.)]\s+(?=[A-Z*"“]))/;
  const segs = text.split(/\n+/).flatMap((line) => line.split(marker));
  const isListLine = (s: string) => /^\s*(?:\d+[.)]|[-•*])\s+/.test(s) || /^\s*\*\*[^*]+\*\*\s*[:—–-]/.test(s);
  const mentions = (s: string) => { const ns = norm(s); return keys.some((k) => ns.includes(k)); };
  const drop = segs.map((s) => isListLine(s) && mentions(s));
  if (drop.filter(Boolean).length < 2) return text;
  const kept = segs
    .flatMap((s, i) => {
      if (!drop[i]) return [s];
      // A closing question glued to the last item ("…unique twist.Which one
      // catches your eye?") is the consultant's, not the item's — keep it.
      const tail = s.match(/(?<=[.!?])\s*([A-Z][^.!?]*\?)\s*$/);
      return tail && !mentions(tail[1]) ? [tail[1]] : [];
    })
    .map((s) => s.trim())
    .filter(Boolean)
    // An intro that ended in a colon now introduces the card, not a list.
    .map((s) => s.replace(/:\s*$/, '.'));
  const out = kept.join('\n\n').trim();
  return out || text;
}

/** Config `ProductMatch` against a catalogue fact (name/category/sku). All present fields must match. */
function productMatches(match: any, f: { sku: string; name?: string; category?: string; collections?: string[] }): boolean {
  if (!match || typeof match !== 'object') return false;
  const name = String(f.name || '').toLowerCase();
  if (match.category && String(match.category).toLowerCase() !== String(f.category || '').toLowerCase()) return false;
  if (match.titleContains && !name.includes(String(match.titleContains).toLowerCase())) return false;
  if (match.skuPrefix && !String(f.sku || '').toUpperCase().startsWith(String(match.skuPrefix).toUpperCase())) return false;
  if (match.collection && !(f.collections || []).some((c) => c.toLowerCase() === String(match.collection).toLowerCase())) return false;
  return !!(match.category || match.titleContains || match.skuPrefix || match.collection);
}

/** "The whole X set", "everything in the series", "a kit", "matching pieces". */
/**
 * Config-driven journey questions (ContextDimension.askWhenMissing) — the
 * questions a business wants asked when they are still unknown, with the
 * business's own answer chips, instead of whatever the model improvises.
 * Derived dimensions (ContextDimension.derive: size from game) are filled
 * in code so they are never asked and always filter.
 */
function deriveDimensions(dims: any[] | undefined, known: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...known };
  for (const d of dims || []) {
    if (!d?.derive?.from || out[d.key]) continue;
    const src = out[d.derive.from];
    if (!src) continue;
    const map: Record<string, string> = d.derive.map || {};
    const hit = Object.keys(map).find((k) => k !== '*' && String(src).toLowerCase().includes(k.toLowerCase()));
    const v = hit ? map[hit] : map['*'];
    if (v) out[d.key] = v;
  }
  return out;
}

/**
 * Config `aliases` — "commander", "edh", "mtg" → Magic: The Gathering — read
 * straight from the customer's words, so an inferable dimension is never asked.
 */
function inferDimensionsFromText(dims: any[] | undefined, text: string, known: Record<string, string>): Record<string, string> {
  const out = { ...known };
  const t = ` ${(text || '').toLowerCase()} `;
  for (const d of dims || []) {
    if (out[d.key] || !d?.aliases || typeof d.aliases !== 'object') continue;
    for (const [value, list] of Object.entries(d.aliases as Record<string, string[]>)) {
      if ((list || []).some((a) => t.includes(` ${String(a).toLowerCase()} `) || new RegExp(`[^a-z0-9]${String(a).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`).test(t))) { out[d.key] = value; break; }
    }
  }
  return out;
}

function missingAskableDimensions(dims: any[] | undefined, known: Record<string, string>): any[] {
  return (dims || []).filter((d) => d?.askWhenMissing && Array.isArray(d.values) && d.values.length >= 2
    && !known[d.key] && !(d.derive?.from && known[d.derive.from]));
}

function askBesideBlock(missing: any[]): string {
  const lines = missing.slice(0, 4).map((d) => `- id "${d.key}": "${d.question || `Which ${(d.label || d.key).toLowerCase()}?`}" → options ${JSON.stringify(d.values.slice(0, 7))}`).join('\n');
  return '[CHIPS AVAILABLE — this business\'s own questions, still unanswered] Most turns need NONE of these; you decide.\n' + lines +
    '\nYou decide whether one is worth asking — only when the answer changes what you would show AND it cannot be inferred from what they said (a Commander deck is Magic; "the Raid set" needs no questions). If you ask, ask as tappable chips: setPhase(phase:"clarify", questions:[{id,title,options}]) with EXACTLY these ids and options — never a free-text question in your reply. At most two, beside the cards: a named product, game, colour or series still gets showItems in the same turn. ' +
    'Ask FIRST (no cards yet) only for an open goal the customer cannot name a product for — a gift, "protect my collection". Never for a complaint, a policy or how-to question, a reorder, or a named product.';
}

/**
 * Config-driven HARD filter (ContextDimension.hardFilter): once a value is
 * known — "Japanese" sleeve size for a Yu-Gi-Oh! player — an item that names a
 * SIBLING value ("… - Standard") never reaches a card, whatever the model put
 * in showItems. Returns what was dropped, for the model.
 */
function applyDimensionHardFilter(call: any, dims: any[] | undefined, known: Record<string, string>): string[] {
  if (call?.function?.name !== 'showItems') return [];
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return []; }
  const products: any[] = Array.isArray(args?.products) ? args.products : [];
  if (!products.length) return [];
  const dropped: string[] = [];
  const kept = products.filter((p) => {
    const hay = `${p?.name || p?.title || ''} ${p?.category || ''}`.toLowerCase();
    for (const d of dims || []) {
      if (!d?.hardFilter || !Array.isArray(d.values) || !known[d.key]) continue;
      const want = String(known[d.key]).toLowerCase();
      if (hay.includes(want)) continue;
      const sibling = d.values.find((v: string) => String(v).toLowerCase() !== want && hay.includes(String(v).toLowerCase()));
      if (sibling) { dropped.push(`${p?.name || p?.sku} is ${sibling}, the customer needs ${known[d.key]}`); return false; }
    }
    return true;
  });
  if (dropped.length) {
    args.products = kept;
    if (Array.isArray(args.items)) args.items = kept;
    call.function.arguments = JSON.stringify(args);
    console.log(`[AgentService] showItems: hard filter dropped ${dropped.length}: ${dropped.join('; ')}`);
  }
  return dropped;
}

/** Known hard-filter values ("Japanese") appended to every catalogue search so retrieval starts in the right place. */
function dimensionQuerySuffix(dims: any[] | undefined, known: Record<string, string>): string {
  return (dims || []).filter((d) => d?.hardFilter && known[d.key]).map((d) => String(known[d.key])).join(' ');
}

/** "a gift for my nephew", "birthday present for a Magic player". */
function isGiftAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(gift|present|birthday|christmas|anniversary)\b/.test(t) || /\bfor my (son|daughter|nephew|niece|partner|husband|wife|boyfriend|girlfriend|friend|brother|sister|kid|kids|dad|mum|mom|grandson|granddaughter)\b/.test(t);
}

/** "the non-glare ones", "two of those", "AT-11821" → the one product in `pool` it names; null when nothing or several match. */
function pickNamedProduct(text: string, pool: { sku: string; name?: string }[]): { sku: string; name?: string } | null {
  const seen = new Set<string>();
  const items = pool.filter((p) => { const k = String(p?.sku || '').toUpperCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const norm = (v: string) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const words = norm(text).replace(/\b(ones?|sleeves?|pack|packs|please|of|them|it|my|the|a|an|to|bag|cart|basket|that|this|these|those)\b/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return items.length === 1 ? items[0] : null;
  const scored = items.map((p) => ({ p, score: words.filter((w) => norm(p.name || '').includes(w) || String(p.sku).toLowerCase() === w).length }));
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (!best) return null;
  const top = scored.filter((x) => x.score === best);
  return top.length === 1 ? top[0].p : null;
}

function isSetAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(whole|entire|full|complete)\b.*\b(set|series|collection|kit|look)\b/.test(t)
    || /\b(set|bundle|kit)\b.*\b(for|of)\b/.test(t)
    || /\b(matching|that match(es)?|goes? with|to go with|complete the (set|look))\b/.test(t);
}

/** "A box for a 100-card deck", "binder for 600 cards", "what fits a double-sleeved Commander deck". */
function isStorageAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  const storage = /\b(deck ?box|box|binder|portfolio|album|storage|store|storing|drawer|case|fit|fits|hold|holds)\b/.test(t);
  const count = /\b\d{2,4}\b|\b(commander|standard|deck|decks|collection)\b/.test(t);
  return storage && count;
}

/** "Tell me more about X", "more details on X", "specs for X" — one item, not a new list. */
function isDetailAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 300) return false;
  return /^(tell me more about|more (details|info|information) (on|about)|what are the (specs|specifications|details) (of|for)|details (on|about|for)|explain) /.test(t);
}

/** "What's the difference between X and Y", "X vs Y", "compare A with B". */
function isComparisonAsk(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.length > 400) return false;
  return /\b(difference|differ|differences)\b.*\b(between|and|vs|versus)\b/.test(t)
    || /\b(compare|comparison|compared)\b/.test(t)
    || /\b\w+\s+(vs\.?|versus)\s+\w+/.test(t)
    || /\bwhich (one )?(is|should i)\b.*\b(or)\b/.test(t);
}

function findBalancedToolCall(buffer: string): { fullMatch: string; toolName: string; rawArgs: string; endIndex: number } | null {
  const prefixMatch = /TOOL_CALL:\s*([a-zA-Z0-9_]+)\s*\(/i.exec(buffer);
  if (!prefixMatch) return null;

  const startIndex = prefixMatch.index;
  const toolName = prefixMatch[1];
  const parenOpenIndex = startIndex + prefixMatch[0].length - 1;

  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escape = false;

  for (let i = parenOpenIndex; i < buffer.length; i++) {
    const ch = buffer[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (inString) {
      if (ch === quoteChar) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          const rawArgs = buffer.slice(parenOpenIndex + 1, i);
          const fullMatch = buffer.slice(startIndex, i + 1);
          return { fullMatch, toolName, rawArgs, endIndex: i + 1 };
        }
      }
    }
  }

  return null;
}

@Injectable()
export class AgentService {
  private openai: OpenAI;
  private intentResolver: IntentResolver;
  private configLoader: ConfigLoader;
  private sessionStore: SessionStore;
  private quoteService: QuoteService;
  private orderService: OrderService;
  private schoolResearch: SchoolResearchService;
  private readonly model = process.env.LLM_MODEL || 'gpt-4o-mini';
  // Intent classification is a trivial structured task — always use a fast model
  // (never the tenant's reasoning model). This is internal plumbing, so it is a
  // platform ENV concern, not per-tenant config.
  private readonly intentModel = process.env.INTENT_MODEL || 'gpt-4o-mini';


  /**
   * DETERMINISTIC school research (AUG-48) — the mandatory opening move.
   *
   * gpt-4o cannot be trusted to call researchSchool first (it reaches for the
   * directory or just asks the customer), so the SERVER does it: when the intent
   * classifier extracts an organisation the customer is buying for, we research
   * it here — once per journey — emit the panel card, and inject the confirmed
   * colours into the conversation so the model stops asking for them.
   */
  /**
   * Remember how many pieces the customer needs, and tell the model to price it.
   *
   * Stated once ("14 players") and needed many turns later at updateQuote — the
   * model reliably forgets, and the quote engine's quantity default of 1 makes
   * that failure silent and money-wrong. Sticky on journeyState so it survives
   * every later turn.
   */
  private noteTeamSize(conversation: any[], journeyState: any): void {
    const lastUser = [...(conversation || [])].reverse().find((m: any) => m.role === 'user');
    const text = String(lastUser?.content || '');
    const found = extractTeamSize(text);
    if (found && found !== journeyState.teamSize) journeyState.teamSize = found;
    const foundBudget = extractBudget(text);
    if (foundBudget && foundBudget !== journeyState.budget) journeyState.budget = foundBudget;
    const size = Number(journeyState.teamSize) || 0;
    const budget = Number(journeyState.budget) || 0;
    if (size > 1) {
      conversation.push({ role: 'system', content:
        `ORDER SIZE — there are ${size} recipients. On updateQuote, set quantity=${size} for every PER-RECIPIENT item: ` +
        `a per-guest favour (a bag/box/tin/pouch of personalised candy, a party favour) or a per-player garment ` +
        `(jersey, shorts, socks, cap). But set quantity=1 for a ONE-OFF item bought ONCE for the whole event — a ` +
        `centrepiece, a single gift box, a gift jar, a candy dispenser, a cake box, a display piece. ` +
        `Both mistakes are money-wrong: a per-recipient favour left at 1 (a $2.99 unit shown as the whole total), AND a ` +
        `one-off centrepiece multiplied by ${size} (one gift box × ${size} = a wildly inflated total).` });
    }
    if (budget > 0) {
      conversation.push({ role: 'system', content:
        `BUDGET — the customer's budget is about $${budget.toLocaleString('en-US')}. Keep the recommended plan and the ` +
        `quote total within it. If a quote comes back OVER budget, do NOT present it as final — say plainly it is over ` +
        `the $${budget.toLocaleString('en-US')} budget and offer a within-budget alternative (a cheaper item, fewer ` +
        `pieces, or a smaller pack). Prefer per-guest favours priced × ${size || 'the guest count'} that land under budget.` });
    }
  }

  /**
   * Tell the model what is on the panel right now, numbered.
   *
   * Customers pick by POSITION — "product 2", "the first one", "the second
   * option" — which is the most natural thing to do and the thing we handled
   * worst: the reference resolved to nothing, so the style was reported
   * undesignable and the alternatives lookup fell back to unrelated products
   * (the Westfield cap spiral). Giving the model the numbered list lets it map
   * the ordinal to a real style code itself, at the source.
   */
  private noteShownItems(conversation: any[], journeyState: any): void {
    const shown: { sku: string; name?: string }[] = journeyState.lastShown || [];
    if (!shown.length) return;
    const list = shown.map((p, i) => `${i + 1}) ${p.sku}${p.name ? ` — ${p.name}` : ''}`).join('; ');
    conversation.push({ role: 'system', content:
      `ON THE PANEL NOW (in the order the customer sees them): ${list}. ` +
      `If they refer to one by POSITION ("product 2", "the first one", "the second option") or by name, ` +
      `map it to that exact style code and use the CODE in every tool call. Never pass a position or a ` +
      `product name where a style code is expected.` });
  }

  /**
   * Naming a product is a request to SEE it, not an invitation to a form (AUG-80).
   *
   * "I want to see baseball jerseys" was answered with three questions — team,
   * gender, quantity — and an empty panel, every time, in four phrasings out of
   * four. The questions themselves are reasonable; asking them INSTEAD of
   * showing anything is what breaks the conversation, and one reply even said
   * "answer the questions below" to a customer who had asked to look at
   * jerseys. AUG-68 tried to fix this in the prompt and the model went on
   * gating anyway, which is the lesson already recorded for `enforceNamedSku`
   * and `enforceItemDesignability`: wording does not hold, so this is settled
   * in code.
   *
   * True only when the customer has named a KIND of product this turn and the
   * panel is still empty. Once something is on the panel, clarifying beside it
   * is exactly right — that is the "show first, then narrow" order, not a ban
   * on questions.
   */
  private askedToSeeSomething(intent: any, journeyState: any, commerceMode?: string): boolean {
    if (journeyState?.activeSku) return false;                 // already looking at one
    if ((journeyState?.lastShown || []).length) return false;   // panel already has items
    /* A stylist/retail brand (commerceMode 'cart') SELLS the guided journey —
     * occasion, fit, size, colour are the value, not friction. Naming "a blue
     * shirt" is the START of that conversation, not a demand to dump a product
     * list. So for cart brands we never force show-first; the model follows
     * journeyGuidance (ask up to 3, or show if the brief is already complete).
     * Fixtures/kit brands keep show-first so a direct "show me toilets" isn't
     * buried under a questionnaire (AUG-68/AUG-80). */
    if (commerceMode === 'cart') return false;
    const dims = intent?.dimensions || {};
    // A garment/product kind is the signal. Sport or team size alone is a brief,
    // not a request to see a specific thing.
    const named = Object.entries(dims).some(([k, v]) =>
      /garment|product|category|item/i.test(k) && String(v || '').trim().length > 1);
    return Boolean(named) && intent?.intent === 'product_recommendation';
  }

  /* GENDER GATE (config-driven, deterministic). For a brand that declares GENDER a
   * must-ask context dimension (e.g. apparel: men's and women's are different
   * products), never show products until gender is known. The model alone doesn't
   * hold this reliably — it will happily show men's jeans for "baggy jeans, size 32".
   * Returns true when we must clarify gender before any showItems. Self-resolves:
   * once the shopper says men/women/kids (or the intent extracts it) it stops firing,
   * so it never loops. No-op for non-gendered brands (Caroma/Augusta). */
  private needsGenderFirst(intent: any, projectConfig: any, messages: any[]): boolean {
    const dims = (projectConfig?.contextDimensions || []) as any[];
    const g = dims.find((d) => String(d?.key || '').toLowerCase() === 'gender');
    const mustAsk = g && (g.scoping === true || g.scoping === 'must-ask' || g.mustAsk === true || g.required === true);
    if (!mustAsk) return false;
    if (intent?.dimensions?.gender) return false;              // intent already resolved it
    const text = (messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => (typeof m?.content === 'string' ? m.content : '')).join(' ').toLowerCase();
    if (/\b(men|mens|man|male|women|womens|woman|female|kid|kids|boy|boys|girl|girls|son|daughter|his|her|hers)\b/.test(text)) return false;
    return true;                                               // gendered brand + gender genuinely unknown
  }

  /* Deterministic guided-clarify panel for the gender gate. Always asks gender;
   * adds occasion when it's still unknown. Used as a post-turn safety net so the
   * buttoned clarify ALWAYS renders when the gate fired, even if the model replied
   * with plain text instead of calling setPhase. */
  private synthGenderClarify(intent: any): { name: string; arguments: any } {
    const qs: any[] = [{ id: 'gender', title: 'Who are you shopping for?', options: ['Men', 'Women', 'Kids'] }];
    if (!intent?.dimensions?.occasion) qs.push({ id: 'occasion', title: "What's the occasion?", options: ['Casual', 'Work', 'Date', 'Party', 'Vacation'] });
    return { name: 'setPhase', arguments: { phase: 'clarify', questions: qs } };
  }

  /**
   * Model-led Product Grounding for Open Models (Gemma 2 9B / MLX / Cloud Run):
   * Resolves products dynamically based on model output or explicit user request,
   * without pre-injecting random products or hardcoded question forms.
   */
  private async resolveOpenModelProducts(
    tenantId: string,
    userText: string,
    modelText: string,
    intent: IntentResult,
    uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
    pushTrace?: (entry: TraceEntry) => void,
  ): Promise<void> {
    const cleanUser = (userText || '').toLowerCase().trim();

    // Direct policy, FAQ, return questions -> no product cards
    if (
      intent.stage === 'faq' ||
      intent.space === 'policy' ||
      /\b(return|returns|refund|refunds|exchange|warranty|guarantee|policy|hours|location|branch|contact|invoice|terms)\b/i.test(cleanUser)
    ) {
      return;
    }

    // 1. Check if model or user mentioned specific PlaceMakers SKU codes (6-8 digit numbers)
    const skuRegex = /(?:sku\s*[:#]?\s*|\/p\/|\b)(\d{6,8})\b/gi;
    const foundSkus: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = skuRegex.exec(modelText || '')) !== null) {
      const s = match[1];
      if (s.length >= 6 && !foundSkus.includes(s)) {
        foundSkus.push(s);
      }
    }

    let itemsToRender: any[] = [];

    // 2. Exact SKU search
    if (foundSkus.length > 0) {
      try {
        const knowledge = await adapterRegistry.getKnowledge(tenantId);
        for (const sku of foundSkus.slice(0, 4)) {
          const res: any = await knowledge.search({ tenantId }, { query: sku, limit: 2 });
          const hits = res?.results || res?.products || res?.items || [];
          for (const h of hits) {
            if (h && !itemsToRender.some((it) => it.sku === h.sku || it.id === h.sku)) {
              itemsToRender.push(normalizeTradeProduct(h));
            }
          }
        }
      } catch (err) {
        console.warn('[agent] SKU lookup error:', err);
      }
    }

    // 3. Explicit product inquiries (e.g. "show me kwila decking", "adhesives", "my answers:", or intent.stage === 'products')
    const isExplicitProductRequest =
      /\b(show me|looking for|buy|price of|options for|decking|timber|framing|lining|adhesive|gib|screws|bracket|vanity|shower|toilet)\b/i.test(cleanUser) ||
      cleanUser.includes('my answers:') ||
      intent.stage === 'products';

    if (itemsToRender.length === 0 && isExplicitProductRequest) {
      const query = extractSearchQuery(userText, []);
      if (query && query !== 'building materials' && query.length >= 3) {
        try {
          const knowledge = await adapterRegistry.getKnowledge(tenantId);
          const rawResults: any = await knowledge.search({ tenantId }, { query, type: 'product', limit: 6 });
          const prods = rawResults?.results || rawResults?.products || rawResults?.items || [];
          if (prods.length) {
            itemsToRender = prods.slice(0, 6).map(normalizeTradeProduct);
          }
        } catch (err) {
          console.warn('[agent] Product query search error:', err);
        }
      }
    }

    // 4. If items found, emit showItems and setPhase: 'products'
    if (itemsToRender.length > 0) {
      const showItemsAction = { name: 'showItems', arguments: { items: itemsToRender, products: itemsToRender } };
      uiToolCalls.push({
        id: `open_model_products_${Date.now()}`,
        type: 'function',
        function: { name: 'showItems', arguments: JSON.stringify(showItemsAction.arguments) },
      });
      if (emit) emit('uiAction', showItemsAction);

      const setPhaseAction = { name: 'setPhase', arguments: { phase: 'products' } };
      uiToolCalls.push({
        id: `open_model_phase_${Date.now()}`,
        type: 'function',
        function: { name: 'setPhase', arguments: JSON.stringify(setPhaseAction.arguments) },
      });
      if (emit) emit('uiAction', setPhaseAction);

      if (pushTrace) {
        pushTrace({ step: 'retrieval', detail: `rendered ${itemsToRender.length} product card(s) in the thread` });
      }
    }
  }

  /**
   * Open models depend on a short, explicit action protocol. Keep that protocol
   * stable, but substitute a bounded Back Office business overlay for the old
   * tenant-specific trade prose so config does not increase prefill latency.
   */
  private buildOpenModelTradePrompt(projectConfig?: any): string {
    const company = String(projectConfig?.companyName || 'this business').replace(/\s*\(.*?\)\s*$/, '');
    const persona = String(projectConfig?.systemName || `${company} consultant`);
    const business = projectConfig?.business || {};
    const entity = business?.entityModel || {};
    const dimensions = Array.isArray(projectConfig?.contextDimensions)
      ? projectConfig.contextDimensions.slice(0, 4)
        .map((dimension: any) => {
          const label = String(dimension?.label || dimension?.key || '').trim();
          const question = String(dimension?.question || '').trim();
          const values = Array.isArray(dimension?.values) ? dimension.values.slice(0, 6).join(', ') : '';
          return label ? `${label}${question ? `: ${question}` : ''}${values ? ` [${values}]` : ''}` : '';
        })
        .filter(Boolean)
      : [];
    const activeRules = Array.isArray(projectConfig?.agentConfig?.rules?.business)
      ? projectConfig.agentConfig.rules.business.slice(0, 3)
        .map((rule: any) => [rule?.condition, rule?.action].filter(Boolean).join(' → '))
        .filter(Boolean)
      : [];
    const compactBusinessContext = [
      String(business?.summary || '').trim(),
      business?.sellsTo ? `Serves: ${business.sellsTo}.` : '',
      business?.orderPattern ? `Order pattern: ${business.orderPattern}.` : '',
      entity?.label ? `Every order is for a ${entity.label}. ${entity.askPrompt || ''}` : '',
      business?.customised === true ? 'Customisation is available only through configured, verified options.' : '',
      business?.approvalRequired === true ? 'Customer approval is required before describing an order as production-ready.' : '',
      dimensions.length ? `Configured discovery context: ${dimensions.join('; ')}.` : '',
      String(projectConfig?.journeyGuidance || '').trim(),
      activeRules.length ? `Active rules: ${activeRules.join('; ')}.` : '',
    ].filter(Boolean).join('\n').slice(0, 1_600);
    return (
      `You are ${persona} — an expert advisor for ${company}.\n` +
      `Provide practical, professional advice that follows this business's configured policies, terminology, and market requirements.\n` +
      `Tone: professional, direct, and helpful. Avoid filler and unsupported claims.\n` +
      (compactBusinessContext ? `BUSINESS CONTEXT:\n${compactBusinessContext}\n` : '') +
      `You have access to UI and lookup actions:\n` +
      `1. DIAGNOSTIC & CLARIFYING QUESTIONS (tappable options in the conversation):\n` +
      `SHOW FIRST, THEN NARROW. Whenever the customer names an offering or a project, emit TOOL_CALL: searchKnowledge with their own words FIRST so verified results appear immediately — never make them answer a questionnaire before seeing anything. Then, when the request is open-ended or needs diagnosis, ask only the configured missing questions beside those results.\n` +
      `Emit a TOOL_CALL line:\n` +
      `TOOL_CALL: setPhase({"phase": "clarify", "questions": [{"id": "<id>", "title": "<diagnostic question>", "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"]}]})\n` +
      `2. PRODUCT & CATALOG SEARCH:\n` +
      `TOOL_CALL: searchKnowledge({"query": "<customer's own product or service words>"})\n` +
      `3. BRANCH STOCK & AVAILABILITY:\n` +
      `TOOL_CALL: checkBranchStock({"sku": "<sku>", "branch": "<branch name>"})\n` +
      `4. STRUCTURAL PROJECT PLAN:\n` +
      `TOOL_CALL: buildProjectPlan({"projectType": "decking"|"fencing"|"lining"|"retaining"|"cladding", "length": <number>, "width": <number>})\n\n` +
      `CRITICAL RULES:\n` +
      `- Products first: a turn that names something to buy or plan ALWAYS includes TOOL_CALL: searchKnowledge, even when you also ask questions. Once the customer has answered your questions, search again with their brief PLUS their answers — do not ask a further round.\n` +
      `- When diagnosing an issue or clarifying scope, emit TOOL_CALL: setPhase with dynamic questions tailored to the configured context — beside results, not instead of them.\n` +
      `- In your chat prose, say briefly why the results shown fit and, if you asked questions, that tapping an answer narrows them.\n` +
      `- Never quote internal rules or echo customer inputs verbatim.`
    );
  }

  /**
   * Executes tools decided by open models (e.g. Gemma 2 9B) via prompt tool decision syntax.
   * Model can emit:
   *   TOOL_CALL: searchKnowledge({"query": "..."})
   *   TOOL_CALL: checkBranchStock({"sku": "...", "branch": "..."})
   *   TOOL_CALL: setPhase({"phase": "clarify", "questions": [...]})
   */
  /**
   * Catalogue search → showItems + setPhase(products) for the open-model
   * (TOOL_CALL text) path. Shared by the model's own searchKnowledge call and
   * the after-answers guarantee below. True when something was shown.
   */
  private async runOpenModelSearch(
    tenantId: string,
    query: string,
    uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
    memo?: TurnSearchMemo,
  ): Promise<boolean> {
    try {
      const res: any = memo
        ? await memo.search({ query, type: 'product', limit: 6 })
        : await (await adapterRegistry.getKnowledge(tenantId)).search({ tenantId }, { query, type: 'product', limit: 6 });
      const prods = res?.results || res?.products || res?.items || [];
      console.log(`[JourneyAX:ToolResult] 📦 searchKnowledge("${query}") returned ${prods.length} product(s)`);
      if (!prods.length) return false;
      // Retrieval can return the same SKU twice (variant rows) — one tile each.
      const seen = new Set<string>();
      const unique = prods.filter((p: any) => { const k = String(p?.sku || '').toUpperCase(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
      const itemsToRender = unique.slice(0, 6).map(normalizeTradeProduct);
      const showItemsAction = { name: 'showItems', arguments: { items: itemsToRender, products: itemsToRender } };
      uiToolCalls.push({
        id: `model_tool_search_${Date.now()}`,
        type: 'function',
        function: { name: 'showItems', arguments: JSON.stringify(showItemsAction.arguments) },
      });
      if (emit) emit('uiAction', showItemsAction);
      const setPhaseAction = { name: 'setPhase', arguments: { phase: 'products' } };
      uiToolCalls.push({
        id: `model_tool_phase_${Date.now()}`,
        type: 'function',
        function: { name: 'setPhase', arguments: JSON.stringify(setPhaseAction.arguments) },
      });
      if (emit) emit('uiAction', setPhaseAction);
      return true;
    } catch (err) {
      console.warn('[agent] searchKnowledge tool execution failed:', err);
      return false;
    }
  }

  /**
   * Storage ask guarantee: the fitting families computed in code are shown as
   * cards even when the model answered in prose only (gpt-4o did exactly that
   * — quoted capacities from retrieved copy, called no tool). One search per
   * top family, merged into one card, so the text's pick has cards under it.
   */
  private async ensureStorageCards(
    tenantId: string, facts: StorageFacts | null, uiToolCalls: any[], conversation: any[],
    emit?: (event: string, data: any) => void,
  ): Promise<void> {
    if (!facts?.fits?.length) return;
    if (uiToolCalls.some((c) => c?.function?.name === 'presentComparison')) return;
    // The model's own showItems counts only if it actually shows a fitting
    // family — a semantic search for "commander storage" brought back a
    // playmat and toploaders beside a text that (correctly) named the Strongbox.
    const needles = facts.fits.map((f: any) => String(f.searchFor || f.family).toLowerCase());
    const alreadyShown = uiToolCalls.some((c) => {
      if (c?.function?.name !== 'showItems') return false;
      try { return (JSON.parse(c.function.arguments || '{}').products || []).some((p: any) => needles.some((n) => String(p?.name || '').toLowerCase().includes(n))); } catch { return false; }
    });
    if (alreadyShown) return;
    try {
      const knowledge = await adapterRegistry.getKnowledge(tenantId);
      const seen = new Set<string>();
      const items: any[] = [];
      for (const f of facts.fits.slice(0, 3)) {
        const res: any = await knowledge.search({ tenantId }, { query: String(f.searchFor || f.family), type: 'product', limit: 3 });
        for (const p of (res?.results || res?.products || res?.items || [])) {
          const k = String(p?.sku || '').toUpperCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          items.push({ ...normalizeTradeProduct(p), description: `Holds ${f.capacity} ${facts.sleeving}-sleeved cards` });
          if (items.length >= 6) break;
        }
        if (items.length >= 6) break;
      }
      if (!items.length) return;
      const call = { id: `storage_cards_${Date.now()}`, type: 'function', function: { name: 'showItems', arguments: JSON.stringify({ items, products: items }) } } as any;
      await groundItemFacts(tenantId, call);   // pricebook facts; sold-out dropped
      let args: any = {};
      try { args = JSON.parse(call.function.arguments); } catch { return; }
      if (!Array.isArray(args.products) || !args.products.length) return;
      console.log(`[agent] storage guarantee: showing ${args.products.length} card(s) for ${facts.fits.map((f: any) => f.family).join(', ')}`);
      uiToolCalls.push(call);
      if (emit) emit('uiAction', { name: 'showItems', arguments: args });
      conversation.push({ role: 'system', content: '[CARDS SHOWN] Cards for the fitting storage families are now on screen under your text. Do not list them; give your pick, the capacity number you used, and one next-step question.' });
    } catch (err) {
      console.warn('[agent] storage guarantee failed:', err);
    }
  }

  /**
   * "Do NOT keep the customer in discovery once they have answered — that is
   * the most common failure" (the intent resolver's own rule). The open model
   * on PlaceMakers kept doing exactly that: three rounds of clarify after
   * "My answers:" and never a search. Once the customer has answered at
   * least one round and this turn ran no catalogue search, run one from the
   * brief + answers and show what came back beside whatever the model said.
   */
  private async ensureRetrievalAfterAnswers(
    tenantId: string,
    retrieval: RetrievalContext,
    stats: { searched: boolean },
    uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
    pushTrace?: (entry: TraceEntry) => void,
    /** Show-first: when nothing has been shown yet this conversation and the
     *  customer's message is a substantive brief, search it now — products
     *  come first, the model's questions sit beside them (AUG-68/AUG-80's
     *  rule, applied to the open-model path in code because the prompt alone
     *  does not hold: "show me laundry tubs" still got a questionnaire). */
    showFirst?: { journeyState: any; intent: any; answersOnly?: boolean },
    memo?: TurnSearchMemo,
  ): Promise<boolean> {
    if (stats.searched) return false;
    if (showFirst?.intent?.panelRenderBlocked) return false;
    // Cards are a SHOPPING guarantee. A return, a refund, a policy or a
    // how-to question that the agent clarified must not end in product cards
    // — "return my drilling tools" + three answers produced six drills.
    const it = showFirst?.intent;
    if (it && (it.intent === 'general_question' || it.intent === 'unknown' || it.retrievalType === 'faq' || it.space === 'policy')) return false;
    // Only the turn that IS the answers counts — a later "tell me more about X"
    // in the same conversation must not be glued to old clarify answers.
    const answered = retrieval.answers.length > 0 && retrieval.lastIsAnswers === true;
    const nothingShownYet = !!showFirst && !showFirst.answersOnly && !(showFirst.journeyState?.lastShown || []).length && !showFirst.journeyState?.activeSku;
    const substantive = retrieval.brief.split(/\s+/).filter(Boolean).length >= 3;
    if (!answered && !(nothingShownYet && substantive)) return false;
    const query = answered ? effectiveSearchQuery('', retrieval) : retrieval.brief;
    if (!query) return false;
    console.log(`[agent] ${answered ? 'after-answers' : 'show-first'} retrieval guarantee: searchKnowledge("${query}")`);
    if (pushTrace) pushTrace({ step: 'tool-call', detail: `searchKnowledge(${JSON.stringify({ query, forced: true })})`, data: { query, forced: true } });
    const shown = await this.runOpenModelSearch(tenantId, query, uiToolCalls, emit, memo);
    if (shown) stats.searched = true;
    return shown;
  }

  /**
   * The storefront's own cart controls send a fixed sentence — "Add SKU X
   * (qty N) to my bag.", "Remove SKU X from my quote.", "Change the quantity
   * of SKU X to N." — and the model was expected to turn that into an
   * updateQuote call. It did not reliably: on a retail tenant it replied
   * "I've added …" with no tool call, and in a fresh session "that SKU isn't
   * available" (it had never retrieved it). A tap on Add is not a request to
   * be interpreted; it is an instruction with a real code in it. Apply it
   * here, deterministically, through the same authoritative QuoteService the
   * updateQuote tool uses, emit the resulting quote as that tool's action,
   * and tell the model it already happened so it just confirms.
   */

  private async executeOpenModelToolCalls(
    tenantId: string,
    rawModelText: string,
    intent: IntentResult,
    uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
    pushTrace?: (entry: TraceEntry) => void,
    retrieval?: RetrievalContext,
    /** Out-param: did a catalogue search actually run this turn? */
    stats?: { searched: boolean },
    /** Tenant capability 'domainClarify' — the built-in trade question bank is opt-in. */
    allowDomainClarify = false,
    memo?: TurnSearchMemo,
  ): Promise<boolean> {
    let executedAny = false;
    let searchStr = rawModelText || '';

    while (true) {
      const tool = findBalancedToolCall(searchStr);
      if (!tool) break;
      const { toolName, rawArgs, endIndex } = tool;
      searchStr = searchStr.slice(endIndex);

      let args: any = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        try {
          args = JSON.parse(rawArgs.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":'));
        } catch {
          console.warn('[agent] Failed to parse tool call args:', rawArgs);
        }
      }

      console.log(`[JourneyAX:ToolDecision] 🛠️ Model decided to invoke tool: ${toolName}(${JSON.stringify(args)})`);
      if (pushTrace) {
        pushTrace({ step: 'tool-call', detail: `${toolName}(${JSON.stringify(args)})`, data: args });
      }

      if (toolName === 'searchKnowledge') {
        const query = effectiveSearchQuery(args.query || args.q || '', retrieval);
        if (query && await this.runOpenModelSearch(tenantId, query, uiToolCalls, emit, memo)) {
          executedAny = true;
          if (stats) stats.searched = true;
        }
      } else if (toolName === 'checkBranchStock') {
        const sku = args.sku || '';
        const branch = args.branch || '';
        const stockResult = handleCheckBranchStock(JSON.stringify(args));
        if (stockResult?.ok) {
          uiToolCalls.push({
            id: `model_tool_stock_${Date.now()}`,
            type: 'function',
            function: { name: 'checkBranchStock', arguments: JSON.stringify(stockResult) },
          });
          if (emit) emit('uiAction', { name: 'checkBranchStock', arguments: stockResult });
          executedAny = true;
        }
        if (sku) {
          try {
            const knowledge = await adapterRegistry.getKnowledge(tenantId);
            const res: any = await knowledge.search({ tenantId }, { query: sku, limit: 2 });
            const prods = res?.results || res?.products || res?.items || [];
            console.log(`[JourneyAX:ToolResult] 🏢 checkBranchStock("${sku}", "${branch}") found ${prods.length} item(s)`);
            if (prods.length) {
              const itemsToRender = prods.slice(0, 2).map(normalizeTradeProduct);
              const showItemsAction = { name: 'showItems', arguments: { items: itemsToRender, products: itemsToRender } };
              uiToolCalls.push({
                id: `model_tool_stock_items_${Date.now()}`,
                type: 'function',
                function: { name: 'showItems', arguments: JSON.stringify(showItemsAction.arguments) },
              });
              if (emit) emit('uiAction', showItemsAction);
              executedAny = true;
            }
          } catch (err) {
            console.warn('[agent] checkBranchStock tool execution failed:', err);
          }
        }
      } else if (toolName === 'buildProjectPlan') {
        try {
          const planResult = handleBuildProjectPlan(JSON.stringify(args));
          if (planResult?.ok) {
            console.log(`[JourneyAX:ToolResult] 📐 buildProjectPlan computed plan: ${planResult.projectType}`);
            const planAction = { name: 'buildProjectPlan', arguments: planResult };
            uiToolCalls.push({
              id: `model_tool_plan_${Date.now()}`,
              type: 'function',
              function: { name: 'buildProjectPlan', arguments: JSON.stringify(planResult) },
            });
            if (emit) emit('uiAction', planAction);
            executedAny = true;
          }
        } catch (err) {
          console.warn('[agent] buildProjectPlan tool execution failed:', err);
        }
      } else if (toolName === 'setPhase') {
        const phase = args.phase || 'clarify';
        let questions = Array.isArray(args.questions) ? args.questions : [];
        if (questions.length === 0 && phase === 'clarify' && allowDomainClarify) {
          const fallback = this.buildDomainClarify(rawModelText, intent, rawModelText);
          if (fallback) questions = fallback.questions;
        }
        if (questions.length > 0) {
          console.log(`[JourneyAX:ToolResult] 📋 Model generated ${questions.length} diagnostic question(s) via setPhase:`, questions.map((q: any) => q.title));
          const setPhaseAction = { name: 'setPhase', arguments: { phase, questions } };
          uiToolCalls.push({
            id: `model_tool_phase_${Date.now()}`,
            type: 'function',
            function: { name: 'setPhase', arguments: JSON.stringify(setPhaseAction.arguments) },
          });
          if (emit) emit('uiAction', setPhaseAction);
          executedAny = true;
        }
      }
    }

    return executedAny;
  }

  /**
   * Extracts diagnostic and clarifying questions directly from the model's generated text response
   * when the model asked questions in natural language instead of emitting a formal TOOL_CALL.
   */
  private extractQuestionsFromModelResponse(
    modelText: string,
    userText: string,
    intent: IntentResult,
    allowDomainClarify = false,
  ): { name: 'setPhase'; arguments: { phase: 'clarify'; questions: any[] } } | null {
    if (!modelText) return null;
    const mt = modelText.trim();
    const lt = (userText || '').toLowerCase();

    // Check if the model asked a question in its response text
    if (!mt.includes('?') && !mt.toLowerCase().includes('narrow down') && !mt.toLowerCase().includes('where')) {
      return null;
    }

    const questions: any[] = [];

    // Pattern: Model asks "Is it coming from X, the Y, a Z, or somewhere else?"
    const orChoiceRegex = /(?:is it (?:coming )?from|is it|do you need|are you looking for|is the leak in|which)\s+([^?]+)\?/i;
    const match = orChoiceRegex.exec(mt);

    if (match && match[1]) {
      const rawOptions = match[1]
        .split(/(?:,|\bor\b)/i)
        .map((s) => s.trim().replace(/^(the|a|an)\s+/i, ''))
        .filter((s) => s.length > 1 && !/^(either|both)$/i.test(s));

      if (rawOptions.length >= 2) {
        const titleMatch = /(?:narrow down|figure out|determine|check)\s+([^.!?]+)/i.exec(mt);
        const title = titleMatch
          ? titleMatch[1].trim().replace(/^where\s+/i, 'Where ') + '?'
          : 'Where is the leak located or coming from?';

        const formattedOptions = rawOptions.map((opt) => {
          const lOpt = opt.toLowerCase();
          if (lOpt.includes('shower')) return 'Shower enclosure / mixer / tray';
          if (lOpt.includes('toilet')) return 'Toilet suite / cistern / inlet';
          if (lOpt.includes('sink') || lOpt.includes('basin')) return 'Vanity basin / mixer tap / waste pipe';
          if (lOpt.includes('somewhere else') || lOpt.includes('wall') || lOpt.includes('pipe')) return 'Behind wall / in-wall pipework';
          return opt.charAt(0).toUpperCase() + opt.slice(1);
        });

        questions.push({
          id: 'leak_location',
          title: title.charAt(0).toUpperCase() + title.slice(1),
          options: formattedOptions,
        });

        if (lt.includes('leak') || mt.toLowerCase().includes('leak')) {
          questions.push({
            id: 'leak_urgency',
            title: 'What is the severity of the leak?',
            options: [
              'Active leak (need water isolated now)',
              'Slow drip / gradual moisture buildup',
              'Water damage / subfloor & lining dampness',
            ],
          });
        }
      }
    }

    // If options couldn't be extracted regex-wise but the model asked diagnostic questions,
    // construct cards aligned with the model's topic
    if (questions.length === 0 && allowDomainClarify && (mt.includes('?') || intent.intent === 'leak_repair')) {
      const fallback = this.buildDomainClarify(userText, intent, modelText);
      if (fallback) return { name: 'setPhase', arguments: { phase: 'clarify', questions: fallback.questions } };
    }

    if (questions.length > 0) {
      return {
        name: 'setPhase',
        arguments: {
          phase: 'clarify',
          questions,
        },
      };
    }

    return null;
  }

  /* Universal Clarify Generator: Ensures that whenever a customer request has
   * wide/broad context (e.g., wet area linings, remodeling, laundry makeover, decking,
   * leaks) without specific SKUs, the right panel ALWAYS renders interactive
   * question cards with selectable options — consistently across ALL models (Gemma, OpenAI, etc.). */
  private buildDomainClarify(
    userText: string,
    intent: IntentResult,
    modelText: string,
  ): { phase: 'clarify'; questions: any[]; chatLead: string } | null {
    const qLower = (userText || '').toLowerCase().trim();
    const mLower = (modelText || '').toLowerCase().trim();
    const combined = `${qLower} ${mLower}`;

    // 1. If customer already answered clarification questions, DO NOT re-clarify!
    if (qLower.startsWith('my answers:') || qLower.includes('my answers:')) {
      return null;
    }

    // 2. Specific product search bypass: if asking for a specific SKU or direct product code
    if (/\b(sku\s*\d+|code\s*\d+|price of\s+[a-z0-9]+|buy now|add to cart)\b/.test(qLower) && !/\b(remodel|makeover|renovat|build|plan|how|what do i need)\b/.test(qLower)) {
      return null;
    }

    // 3. Wet Area / Moisture / Waterproofing / Linings
    if (
      combined.includes('lining') ||
      combined.includes('moisture') ||
      combined.includes('waterproof') ||
      combined.includes('wet area') ||
      combined.includes('aquachek') ||
      combined.includes('aqualine') ||
      combined.includes('villaboard')
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'surface_lining',
            title: 'What surface are you lining in your wet area?',
            options: [
              'Tiled shower / bath (requires waterproof membrane)',
              'Acrylic shower wall liner',
              'GIB Aqualine plasterboard (painted wet area)',
              'Fibre cement / Villaboard underlay',
            ],
          },
          {
            id: 'substrate_floor',
            title: 'What is your flooring or substrate?',
            options: [
              'Concrete slab floor',
              'Timber floorboards / Particle board',
              'Plywood subfloor',
              'Existing wall / floor over-boarding',
            ],
          },
          {
            id: 'accessories_ventilation',
            title: 'Any special fixtures or ventilation requirements?',
            options: [
              'Heated towel rail placement',
              'Extraction / ventilation fan ducting',
              'Both towel rail & ventilation fan',
              'Standard shower enclosure only',
            ],
          },
        ],
        chatLead:
          'Got it — we can help you with your wet area linings and waterproofing! I’ve popped a few quick questions below so I can pinpoint your exact space requirements and pull up the right NZS 3604-compliant linings, waterproofing systems, and trade packs.\n\nCan you tap the options below that best match what you’re planning?',
      };
    }

    // 3b. Leak Repair / Plumbing Issues (Bathroom / Kitchen / Laundry Leak)
    if (
      combined.includes('leak') ||
      combined.includes('leaking') ||
      combined.includes('dripping') ||
      intent.intent === 'leak_repair'
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'leak_location',
            title: 'Where is the leak located or coming from?',
            options: [
              'Shower enclosure / mixer / tray',
              'Toilet suite / cistern / inlet valve',
              'Vanity basin / tapware / waste pipe',
              'Behind wall / ceiling / in-wall pipework',
            ],
          },
          {
            id: 'leak_urgency',
            title: 'What is the severity of the leak?',
            options: [
              'Active leak (need water isolated now)',
              'Slow drip / gradual moisture buildup',
              'Water damage / subfloor & lining dampness',
            ],
          },
          {
            id: 'repair_approach',
            title: 'What repair or replacement are you planning?',
            options: [
              'DIY replacement parts (valves, seals, tapware)',
              'Waterproofing membrane & lining repair',
              'Licensed Trade Plumber installation required',
            ],
          },
        ],
        chatLead:
          'A leaking bathroom can cause serious subfloor and lining damage if not caught early! I’ve put a few quick diagnostic questions below so we can identify the source and get you the right repair parts or compliant waterproofing solutions.\n\nCould you select where the leak is coming from below?',
      };
    }

    // 4. Bathroom Remodel / Renovation
    if (
      combined.includes('remodel') ||
      combined.includes('bathroom makeover') ||
      combined.includes('renovate bathroom') ||
      combined.includes('bathroom renovation') ||
      intent.intent === 'bathroom_remodel'
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'remodel_scope',
            title: 'What is the primary scope of your bathroom project?',
            options: [
              'Full bathroom makeover (vanity, shower, toilet, tiles)',
              'Shower & vanity upgrade only',
              'Toilet suite & tapware replacement',
              'DIY repairs & cosmetic refresh',
            ],
          },
          {
            id: 'finish_style',
            title: 'What finish or aesthetic do you prefer?',
            options: [
              'Modern Chrome',
              'Matte Black contemporary',
              'Brushed Brass / Gold luxury',
              'Classic White / Neutral',
            ],
          },
          {
            id: 'bathroom_size',
            title: 'What is the layout or size of your bathroom?',
            options: [
              'Compact ensuite (under 4m²)',
              'Standard family bathroom (4m² to 7m²)',
              'Large master bathroom (8m²+)',
            ],
          },
        ],
        chatLead:
          'Exciting project! To help plan your bathroom renovation properly, I’ve popped a few quick questions below to understand your scope, layout, and finish preferences.\n\nCan you tap the options below that match what you have in mind?',
      };
    }

    // 5. Laundry Makeover / Cabinets
    if (
      combined.includes('laundry') ||
      combined.includes('laundry cabinet') ||
      combined.includes('tub')
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'laundry_width',
            title: 'What space / width are you planning for?',
            options: [
              'Compact space (under 1.5m)',
              'Standard laundry wall (1.8m to 2.4m)',
              'Full dedicated laundry room (3m+)',
            ],
          },
          {
            id: 'cabinet_storage',
            title: 'What storage configuration do you need?',
            options: [
              'Modular base & overhead wall cabinets',
              'Continuous benchtop over washing machine',
              'Tub unit with bypass storage',
              'Custom shelving & utility pantry',
            ],
          },
          {
            id: 'plumbing_protection',
            title: 'Do you require plumbing fixtures or moisture barriers?',
            options: [
              'Laundry tub & mixer tap',
              'Wall cavity moisture underlay / foil roll',
              'Both plumbing tapware & moisture underlay',
              'Cabinetry only',
            ],
          },
        ],
        chatLead:
          'A well-organised laundry makes a huge difference! I’ve popped a few quick questions below so I can pinpoint the right cabinet dimensions, storage units, and moisture protection for your space.\n\nCan you tap the options below that best describe your setup?',
      };
    }

    // 6. Decking / Outdoor Timber
    if (
      combined.includes('deck') ||
      combined.includes('decking') ||
      combined.includes('timber deck')
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'timber_species',
            title: 'What decking timber material do you prefer?',
            options: [
              'Radiata Pine (H3.2 Premium Grip Tread)',
              'Kwila Hardwood (Smooth / Reeded)',
              'Vitex Hardwood',
              'Composite Low-Maintenance Decking',
            ],
          },
          {
            id: 'deck_size',
            title: 'What is the approximate size of your deck?',
            options: [
              'Small deck / landing (under 15m²)',
              'Medium family deck (15m² to 30m²)',
              'Large entertaining deck (30m²+)',
            ],
          },
          {
            id: 'deck_height',
            title: 'What is the ground elevation or foundation?',
            options: [
              'Low ground-level (under 1m, no consent required)',
              'Elevated deck (requires balustrades / handrails)',
              'Rebuilding over existing subframe',
            ],
          },
        ],
        chatLead:
          'Building a deck is a great way to expand your outdoor living! I’ve put three quick picks below to pinpoint your timber species, dimensions, and height requirements under NZS 3604.\n\nCan you tap the options that best match your project?',
      };
    }

    // 7. Plumbing Leak / Repair
    if (
      combined.includes('leak') ||
      combined.includes('drip') ||
      combined.includes('seeping') ||
      intent.intent === 'leak_repair'
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'leak_location',
            title: 'Where are you seeing the leak?',
            options: [
              'From the showerhead / handset',
              'Shower mixer / tap body or base',
              'Shower tray or screen perimeter seal',
              'Under vanity / waste pipe',
            ],
          },
          {
            id: 'leak_timing',
            title: 'When does it leak?',
            options: [
              'Only when the shower/tap is running',
              'Dripping continuously 24/7',
              'Weeping slowly after taps are turned off',
            ],
          },
          {
            id: 'water_volume',
            title: 'How much water are we talking?',
            options: [
              'Steady drip',
              'Slow trickle / damp patch',
              'Active running water',
            ],
          },
        ],
        chatLead:
          'Got it — we can help you track this down and sort it. I’ve popped a few quick questions below so I can pinpoint the cause and suggest the right fix and parts.\n\nCan you tap the options that best match what you’re seeing?',
      };
    }

    // 8. Timber Framing & Structural Timber
    if (
      combined.includes('framing') ||
      combined.includes('timber for framing') ||
      combined.includes('framing timber') ||
      combined.includes('studs') ||
      combined.includes('joists')
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'framing_application',
            title: 'What type of framing are you building?',
            options: [
              'Internal non-load bearing wall framing',
              'External load-bearing framing',
              'Subfloor framing & floor joists',
              'Deck / outdoor subframe',
            ],
          },
          {
            id: 'treatment_grade',
            title: 'What timber grade / treatment is required?',
            options: [
              'SG8 Kiln Dried H1.2 Pink Pine (Standard Internal)',
              'SG8 Treated H3.2 (Wet Areas & Exterior Cavities)',
              'H4 Ground Contact Treated Timber',
              'Untreated Radiata Pine',
            ],
          },
          {
            id: 'timber_dimensions',
            title: 'What stud or framing sizing do you need?',
            options: [
              '90x45 standard wall studs & plates',
              '140x45 thicker exterior cavity wall framing',
              '190x45 or 240x45 floor joists / rafters',
              'Assorted framing pack / take-off schedule',
            ],
          },
        ],
        chatLead:
          'PlaceMakers is New Zealand’s leading timber merchant — we have all your framing sorted under NZS 3604! I’ve popped three quick questions below so I can pinpoint the exact SG8 grade, treatment, and sizes for your build.\n\nCan you tap the options that best match your framing job?',
      };
    }

    // 9. Kitchen Makeover / Cabinets
    if (
      combined.includes('kitchen') ||
      combined.includes('kitchen cabinet') ||
      combined.includes('kitchen makeover') ||
      combined.includes('kitchen renovation')
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'kitchen_layout',
            title: 'What is the layout of your kitchen?',
            options: [
              'L-shaped modular kitchen layout',
              'U-shaped kitchen with breakfast bar',
              'Straight single wall / Galley run',
              'Kitchen island + separate pantry run',
            ],
          },
          {
            id: 'cabinet_finish',
            title: 'What cabinet door and drawer style do you prefer?',
            options: [
              'Modern Gloss White minimalist',
              'Warm Natural Oak Timber Veneer',
              'Architectural Charcoal / Matte Black',
              'Classic Shaker Style Profile',
            ],
          },
          {
            id: 'benchtop_sink',
            title: 'What benchtop material and sink configuration?',
            options: [
              'Engineered quartz stone + undermount sink',
              'Durable laminate benchtop + drop-in sink',
              'Solid timber benchtop + granite composite sink',
              'Cabinetry only (benchtop already sorted)',
            ],
          },
        ],
        chatLead:
          'Planning a kitchen is an exciting project! To help put together the right modular layout, cabinetry, and benchtops for your space, I’ve put a few quick questions below.\n\nCan you tap the options that best match your vision?',
      };
    }

    // 8. General Discovery fallback (if context is wide and lacks specifics)
    // ONLY for broad project remodeling/discovery journeys — never for general questions or policy inquiries
    if (
      intent.intent !== 'general_question' &&
      intent.retrievalType !== 'faq' &&
      intent.space !== 'policy' &&
      intent.stage !== 'faq' &&
      (intent.stage === 'intro' ||
        intent.stage === 'clarify' ||
        !intent.needsRetrieval ||
        (intent.missingInfo && intent.missingInfo.length > 0))
    ) {
      return {
        phase: 'clarify',
        questions: [
          {
            id: 'project_type',
            title: 'What type of project are you working on?',
            options: [
              'DIY home renovation',
              'Licensed building trade / contractor',
              'Quick repair or replacement',
              'Planning & cost estimation',
            ],
          },
          {
            id: 'project_scope',
            title: 'What is your primary area of focus?',
            options: [
              'Bathroom / Plumbing',
              'Building Materials & Timber',
              'Laundry & Storage',
              'Outdoor / Decking',
            ],
          },
          {
            id: 'timing_fulfillment',
            title: 'What is your timeframe and fulfillment preference?',
            options: [
              'Branch pickup (60-minute Click & Collect)',
              'Delivery to site',
              'Just researching options & prices',
            ],
          },
        ],
        chatLead:
          'Kia ora! To make sure I get you the exact right materials and specifications for your project, I’ve put a few quick questions in the conversation.\n\nCan you tap the options that best describe what you need?',
      };
    }

    return null;
  }

  /* DETERMINISTIC COMPLETE-THE-LOOK (cross-sell). For a retail cart brand, the MOMENT
   * a customer adds a piece the stylist should offer 2–3 COMPLEMENTARY pieces (a
   * different category — shirt → pants/shoes, pants → a top/belt) with real cards,
   * not shortcut to checkout. The model skips this proactively even with guidance, so
   * after updateQuote we force ONE more round with an explicit directive. Fires once
   * per new add (keyed on the bag's sku set), and never when the customer signalled
   * they want to check out / are done. No-op for non-cart brands (Caroma/Augusta). */
  private crossSellDirective(commerceMode: string | undefined, lastUserText: string, quote: any, journeyState: any): string | null {
    if (commerceMode !== 'cart') return null;
    const t = (lastUserText || '').toLowerCase();
    // Customer asked to close / declined more → respect it, let them check out.
    if (/\b(check\s?out|checkout|pay|purchase|buy now|that'?s all|thats all|just (this|these|that)|nothing else|no (thanks|more)|i'?m done|im done|ready to (pay|buy|check)|place (the )?order|proceed to)\b/.test(t)) return null;
    const skus = (quote?.lines || []).map((l: any) => String(l.sku || '')).filter(Boolean).sort();
    const sig = skus.join('|');
    if (!sig) return null;
    if (journeyState.crossSellSig === sig) return null;   // already offered for this bag state
    journeyState.crossSellSig = sig;
    const cats = [...new Set((quote?.lines || []).map((l: any) => String(l.category || '').trim()).filter(Boolean))];
    // Stash what's in the bag so the showItems handler can DETERMINISTICALLY drop
    // any "complementary" card that is really the SAME category/product — the model
    // otherwise re-shows the same jeans, which loops (selecting one re-adds a jean).
    journeyState.crossSellFor = sig;
    journeyState.crossSellRetries = 0;
    journeyState.crossSellExcludeCats = cats;
    journeyState.crossSellExcludeNames = (quote?.lines || []).map((l: any) => String(l.name || '').trim().toLowerCase()).filter(Boolean);
    const catHint = cats.length ? ` They just added: ${cats.join(', ')}.` : '';
    return `ITEM ADDED TO THE BAG — now run the COMPLETE-THE-LOOK step before ANY checkout talk.${catHint} ` +
      `You are their stylist. In ONE short warm line affirm what they added, then THIS TURN call searchKnowledge for 2–3 COMPLEMENTARY pieces in a DIFFERENT category that finish the outfit ` +
      `(a top → bottoms / shoes / a jacket; bottoms → a top / belt / shoes; a dress → shoes / a jacket / a bag), and call showItems to put those cards on the panel. ` +
      `Do NOT merely ask "want to complete the look?" and stop — actually SHOW the pieces. Then end with ONE short question: "Want to add any of these, or are you ready to check out?" ` +
      `Keep the complementary pieces the SAME gender as the bag. Never call this a "quote" — it's their bag.`;
  }

  /* Deterministic complete-the-look guard: during a cross-sell turn, drop any
   * showItems card whose category (leaf) or name matches what's already in the
   * bag — those aren't "completing the look", they're the same thing again, and
   * re-adding one loops. Mutates call.function.arguments. Returns true only when
   * filtering removed EVERYTHING (so the caller can force a re-search). */
  private applyCrossSellFilter(call: any, journeyState: any): boolean {
    const leaf = (c: unknown): string =>
      String(c || '').split(/[>\/|,]/).pop()!.trim().toLowerCase().replace(/s\b/g, '').trim();
    let args: any = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return false; }
    const prods = args?.products;
    if (!Array.isArray(prods) || !prods.length) { return false; }
    const badCats = new Set((journeyState.crossSellExcludeCats || []).map(leaf).filter(Boolean));
    const badNames = new Set((journeyState.crossSellExcludeNames || []).map((n: string) => String(n).trim().toLowerCase()));
    const kept = prods.filter((p: any) => {
      const cl = leaf(p?.category);
      const nm = String(p?.name || '').trim().toLowerCase();
      if (cl && badCats.has(cl)) return false;   // same category as the bag
      if (nm && badNames.has(nm)) return false;  // literally the same product
      return true;
    });
    if (kept.length) {
      args.products = kept;
      call.function.arguments = JSON.stringify(args);
      journeyState.crossSellFor = null;          // consumed successfully
      return false;
    }
    return true;                                  // everything was same-category
  }

  /* Resolve the shopper's stated size to a canonical token ("medium" → "M",
   * "32" → "32") from the intent dimensions or anything they typed. Deterministic
   * so a card can pre-select it even when the model forgets recommendedSize. */
  private resolveShopperSize(intent: any, messages: any[]): string | null {
    const WORD: Record<string, string> = {
      xs: 'XS', 'extra small': 'XS', s: 'S', small: 'S', m: 'M', med: 'M', medium: 'M',
      l: 'L', large: 'L', xl: 'XL', 'x-large': 'XL', 'extra large': 'XL',
      xxl: 'XXL', 'xx-large': 'XXL', '2xl': 'XXL', '3xl': 'XXXL', xxxl: 'XXXL',
    };
    const norm = (raw: string): string | null => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s) return null;
      if (WORD[s]) return WORD[s];
      if (/^(x{0,3})[sml]$|^x{1,3}l$/.test(s)) return s.toUpperCase(); // xs/s/m/l/xl/xxl
      const w = s.match(/\b(2[0-9]|3[0-9]|4[0-4])\b/);                 // waist 20–44
      if (w) return w[1];
      return null;
    };
    // Prefer an explicit size/fit dimension the extractor pulled.
    for (const [k, v] of Object.entries(intent?.dimensions || {})) {
      if (/size|fit/i.test(k)) { const n = norm(String(v)); if (n) return n; }
    }
    // Fall back to anything the shopper typed ("I'm usually a medium", "32 waist").
    const text = (messages || []).filter((m) => m?.role === 'user')
      .map((m) => (typeof m?.content === 'string' ? m.content : '')).join(' ');
    const m = text.toLowerCase().match(/\b(xs|s|m|l|xl|xxl|extra small|small|medium|large|x-large|extra large|xx-large|2[0-9]|3[0-9]|4[0-4])\b/);
    return m ? norm(m[1]) : null;
  }

  /* Deterministically pre-select the shopper's size on every card that carries it,
   * so "medium" highlights M without relying on the model to set recommendedSize.
   * Only sets it when the size genuinely exists in that card's own size list. */
  private applySizePreselect(call: any, shopperSize: string | null): void {
    if (!shopperSize || call?.function?.name !== 'showItems') return;
    let args: any = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return; }
    const prods = args?.products;
    if (!Array.isArray(prods) || !prods.length) return;
    const want = shopperSize.toUpperCase();
    let changed = false;
    for (const p of prods) {
      const sizes = Array.isArray(p?.sizes) ? p.sizes : [];
      const match = sizes.find((s: any) => String(s).trim().toUpperCase() === want);
      if (match) { p.recommendedSize = match; changed = true; }
    }
    if (changed) call.function.arguments = JSON.stringify(args);
  }

  private async maybeResearchOrg(
    tenantId: string, projectConfig: any, intent: any,
    journeyState: any, conversation: any[], uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
  ): Promise<boolean> {
    const org = intent?.organization;
    if (!org?.name) return false;
    // Key on the NAME ONLY (normalised). The location gets enriched between turns
    // (turn 1 has none, later turns pick up "Oswego, IL" from context), so a
    // name+location key changed every turn and re-ran research on EVERY message —
    // which re-showed the confirmation card and, because researchedThisTurn was
    // then always true, suppressed the product panel on the confirm turn. Research
    // ONCE per school per journey.
    const key = String(org.name).toLowerCase().replace(/\b(high school|hs|college|university|academy)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) return false;
    // Already researched a school this journey → never re-research. The intent
    // classifier carries the org forward from context (and sometimes mis-reads a
    // product name like "Ladies FreeStyle Volleyball Jersey" as an organisation),
    // so without this a downstream turn re-ran research and blocked the 3D render.
    if (journeyState.researchedOrgKey) return false;
    // Only research when the customer ACTUALLY names the school in THIS message —
    // a distinctive token of the org name must appear in the latest user turn.
    // This is the semantic trigger ("I coach at Neuqua Valley"), not "the context
    // still mentions a school we already handled".
    const lastUser = [...(conversation || [])].reverse().find((m: any) => m.role === 'user');
    const said = String(lastUser?.content || '').toLowerCase();
    const distinctive = key.split(' ').filter((w) => w.length >= 4);
    if (distinctive.length && !distinctive.some((w) => said.includes(w))) return false;

    const research: any = await this.runSchoolResearch(
      tenantId, projectConfig, JSON.stringify({ school: org.name, location: org.location }),
    );
    if (!research || research.error || !(research.colours || []).length) return false;

    journeyState.researchedOrgKey = key;
    const synthetic: any = { id: `research_${Date.now()}`, type: 'function',
      function: { name: 'researchSchool', arguments: '{}' }, __research: research };
    uiToolCalls.push(synthetic);
    if (emit) emit('uiAction', { name: 'researchSchool', arguments: research });

    const cols = (research.colours || []).map((c: any) => c.mappedTo?.name || c.name).filter(Boolean);
    const colourBlock =
      `BRAND RESEARCH (already done for you; the colour card is ON THE PANEL right now) — ${org.name}: ` +
      `team=${research.team || ''}, mascot=${research.mascot || ''}, colours=[${cols.join(', ')}]. ` +
      `We already HAVE the team colours — do NOT ask the customer for them. Use ONLY these palette colour names when you searchKnowledge and render. ` +
      `Never recreate the official logo. `;

    /* Confirming the colours comes FIRST — but only when the colours are the
     * open question.
     *
     * A customer who names a style code, or who is already mid-design, has told
     * us what they want; holding that turn back to ask "are these your colours?"
     * answers a question they did not ask and leaves the panel empty. Research
     * still runs and the card still appears — they simply are not blocked by it. */
    if (!this.alreadyKnowsWhatTheyWant(said, journeyState)) {
      conversation.push({ role: 'system', content: colourBlock +
        `THIS TURN, do ONE thing only: acknowledge the mascot + colours in one warm sentence and invite the customer to confirm they look right. ` +
        `Do NOT call setPhase("clarify"), do NOT search, do NOT render yet — the customer must confirm the colours on the card first.` });
      return true;
    }

    conversation.push({ role: 'system', content: colourBlock +
      `The customer has ALREADY told you which style they want, so answer THAT — search or render as their message asks, ` +
      `in these colours, and mention the colours in passing so they can correct you if they are wrong.` });
    return false;
  }

  /**
   * The style code the customer typed, if they typed one.
   *
   * A code is either six-or-more digits (227130) or a mix of letters and digits
   * (329X3M). Five bare digits is deliberately NOT enough: that is a US ZIP, and
   * "Naperville, IL 60540" is a location, not a style. Short numbers — roster
   * counts, years, budgets — never match.
   */
  private namedStyleCode(said: string): string {
    const m = String(said || '').match(/\b\d{6,8}\b/)
      || String(said || '').match(/\b(?=[a-z0-9]{5,8}\b)(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,8}\b/i);
    return m ? m[0] : '';
  }

  /**
   * Ask for a style by code and you should SEE it.
   *
   * Naming a code is the least ambiguous request a customer can make, yet it
   * was answered with a form: four questions about sport, gender and quantity
   * before anything appeared on the panel. Those questions are worth asking —
   * afterwards, next to the garment, not instead of it. Only fires when the
   * code is real, so a mistyped number still gets a normal conversation.
   */
  private async noteNamedStyle(
    tenantId: string, conversation: any[], journeyState: any, configuratorAvailable: boolean,
  ): Promise<void> {
    if (!configuratorAvailable) return;
    const lastUser = [...(conversation || [])].reverse().find((m: any) => m.role === 'user');
    const code = this.namedStyleCode(String(lastUser?.content || ''));
    if (!code || journeyState?.activeSku === code) return;
    const found = await skusThatExist(tenantId, [code.toUpperCase()]);
    if (!found.includes(code.toUpperCase())) return;  // not a style here — say nothing
    const designable = await designableAlternatives(tenantId, code);
    if (!designable.some((item) => String(item.sku || '').toUpperCase() === code.toUpperCase())) return;
    conversation.push({ role: 'system', content:
      `The customer named style ${code}. Call showConfigurator with sku="${code}" THIS TURN, applying any design ` +
      `line and colours they mentioned. Do not ask for sport, gender or quantity first — show them the garment, ` +
      `then ask whatever is still missing in one short follow-up.` });
  }

  /**
   * Has the customer already named the thing they want?
   *
   * True when the message carries a style code, or when a garment is already on
   * the stage. Either way the next step is theirs to direct, not ours to gate.
   */
  private alreadyKnowsWhatTheyWant(said: string, journeyState: any): boolean {
    if (journeyState?.activeSku) return true;
    return Boolean(this.namedStyleCode(said));
  }

  /**
   * Run live school-brand research for the journey's opening step (AUG-48).
   *
   * Fetches the brand palette so the researched colours map onto real,
   * renderable colour names, then calls the research service with the PROJECT's
   * own LLM key. Shared by both the streaming and non-streaming tool paths so
   * they can never drift (the AUG-38 parity trap).
   */
  private async runSchoolResearch(tenantId: string, projectConfig: any, rawArgs: string): Promise<any> {
    let args: any = {};
    try { args = JSON.parse(rawArgs); } catch { /* tolerate */ }
    const school = String(args.school || '').trim();
    if (!school) return { error: 'A school or team name is required to research.' };

    let palette: { name: string; hex?: string }[] = [];
    try {
      const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
      const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/renderer-config`);
      if (res.ok) {
        const rc: any = await res.json();
        palette = (rc?.palette || []).map((c: any) => (typeof c === 'string' ? { name: c } : { name: c.name || c.display, hex: c.hex || c.render }));
      }
    } catch { /* palette is an enhancement; research still returns without it */ }

    return this.schoolResearch.research({
      tenantId, school, location: args.location, palette,
      provider: projectConfig?.provider, apiKey: projectConfig?.apiKey, baseUrl: projectConfig?.baseUrl,
      model: projectConfig?.researchModel,
    });
  }

  constructor() {
    // No timeout was ever set here — the SDK default is 10 MINUTES with no
    // retry, so an occasionally-stuck completion call (observed tonight,
    // repeatedly, on multi-tool-call turns) hangs the entire customer-facing
    // chat turn instead of failing fast. A legitimate slow-but-progressing
    // gpt-5 generation (multi-tool decision + a long response) completes well
    // inside 60s in measured testing; a call stuck at zero token progress for
    // that long is hung, not slow, and should be retried rather than left to
    // hang toward the 10-minute ceiling.
    this.openai = new OpenAI({ timeout: 60_000, maxRetries: 2 });
    this.intentResolver = new IntentResolver(this.openai, this.model);
    this.configLoader = new ConfigLoader();
    this.sessionStore = new SessionStore();
    this.quoteService = new QuoteService();
    this.orderService = new OrderService();
    this.schoolResearch = new SchoolResearchService();
    // Config-driven platform switching (B3): the adapter registry resolves each
    // tenant's knowledge/commerce platform + credentials from the PUBLISHED project
    // config (integrations.platforms, set in the back office). Standalone remains
    // the safe default when unset or when project-service is unreachable.
    adapterRegistry.setResolver(
      createPublishedConfigResolver(
        process.env.PROJECT_SERVICE_URL_HTTP || process.env.PROJECT_SERVICE_URL || 'http://localhost:8082',
      ),
    );
  }

  // NOTE (Phase A): removed routePostClarify() and mustForceClarify(). They were
  // hardcoded flow heuristics — keyword-matching "my answers"/"build my" and a
  // turn-count rule — that overrode the model's judgement and could not generalize
  // across scenarios or platforms. The flow is now driven by the intent resolver +
  // per-project journeyGuidance config, with the model deciding each turn. Panel
  // INTEGRITY (clarify-needs-questions, showProducts/showGuide render) is still
  // enforced as an outcome guarantee — that is not flow hardcoding.

  /**
   * The UI tool this turn MUST emit so the right 60% panel renders (not just prose):
   * product/design/collection retrieval → showProducts cards; troubleshooting/
   * installation → showGuide checklist. Null when no panel render is expected.
   */
  /**
   * Which panel MUST render this turn.
   *
   * For a business that customises goods per order, a design conversation has to
   * end in a visible garment — so the configurator becomes the required panel
   * rather than a product grid. Driven by the tenant's own business config and
   * enabled capabilities, never by keywords in the message.
   */
  private requiredUiTool(
    intent: IntentResult,
    opts: { configuratorAvailable?: boolean; activeSku?: string } = {},
  ): 'showItems' | 'showGuide' | 'showConfigurator' | null {
    // Customer explicitly said "don't render yet" / "just tell me what to look for" —
    // honour that by keeping the panel blank this turn.
    if (intent.panelRenderBlocked) return null;
    const rt = intent.retrievalType;
    const productish = intent.stage === 'products' || rt === 'product' || rt === 'design' || rt === 'collection';
    // Do not force a configurator before a real, designable SKU is selected.
    // Direct model calls are independently validated before the UI is emitted.
    const canConfigure = opts.configuratorAvailable === true && !!opts.activeSku;
    if (productish && canConfigure) return 'showConfigurator';
    if (productish) return 'showItems';
    if (intent.stage === 'installation' || rt === 'troubleshooting' || rt === 'installation') return 'showGuide';
    return null;
  }

  /**
   * Force the model to emit a UI render tool (showProducts/showGuide) using the
   * data already retrieved this turn, then wire the call into the conversation +
   * stream it. Called once per turn when the model tried to answer in prose only.
   */
  private async forceUiTool(
    tenantId: string,
    conversation: any[],
    activeTools: OpenAI.ChatCompletionTool[],
    toolName: 'showItems' | 'showGuide' | 'showConfigurator',
    uiToolCalls: any[],
    emit: (event: string, data: any) => void,
    model: string,
    llm: OpenAI = this.openai,
    journeyState?: any,
    designFirst = false,
    configuratorType?: string,
  ): Promise<void> {
    const what = toolName === 'showItems' ? 'the recommended items'
      : toolName === 'showConfigurator' ? 'the design'
      : 'the guide steps';
    /* The configurator is fed by what the CUSTOMER described, not by retrieved
     * rows — telling it to use "only retrieved data" makes it refuse when no
     * search ran, which is exactly the case on a pure design turn. */
    const source = toolName === 'showConfigurator'
      ? 'using the style, colours, name and number the customer has given you so far (omit anything they have not said)'
      : 'using ONLY the data you retrieved this turn (real names, prices, imageUrl, specs — do not invent)';
    try {
      const forced = await llm.chat.completions.create({
        model,
        messages: [
          ...conversation,
          {
            role: 'system',
            content: `Before you answer, you MUST call ${toolName} to render ${what} in the conversation, ${source}. Do not answer in text only.`,
          },
        ],
        tools: activeTools,
        tool_choice: { type: 'function', function: { name: toolName } },
      });
      const fmsg = forced.choices[0].message;
      if (!fmsg.tool_calls?.length) {
        // Silent failure here used to look identical to "the model chose not to
        // render" — surface it so a missing panel is diagnosable.
        console.warn(`[AgentService] forced ${toolName} produced no tool call`);
      }
      if (fmsg.tool_calls?.length) {
        conversation.push(fmsg);
        for (const call of fmsg.tool_calls) {
          if (call.type !== 'function' || !UI_TOOL_NAMES.has(call.function.name)) continue;
          await enforceNamedSku(tenantId, conversation, call);   // identity wins over the model
          // Validate BEFORE emitting: the panel must receive the corrected
          // arguments, not the ones the model guessed.
          const verdict = await validateDesign(tenantId, call, configuratorType);
          // showItems may not present stock styles as customisable (AUG-25).
          const itemVerdict = await enforceItemDesignability(tenantId, call, designFirst);
          if (bundleRefused(call, itemVerdict)) { conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemVerdict) }); continue; }
          // ...and the catalogue, not the model, states what each card shows.
          const itemFacts = await groundItemFacts(tenantId, call);
          // Everything dropped (sold out / not real) → no empty card, the model hears why.
          const emptied = emptyShowItemsVerdict(call, itemFacts);
          if (emptied) { conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(emptied) }); continue; }
          // Complete-the-look guard (forced-emit path): never let a same-category
          // card through. If they were ALL same-category, show none rather than loop.
          if (call.function.name === 'showItems' && journeyState.crossSellFor && this.applyCrossSellFilter(call, journeyState)) {
            try { const a = JSON.parse(call.function.arguments); a.products = []; call.function.arguments = JSON.stringify(a); } catch { /* noop */ }
            journeyState.crossSellFor = null;
          }
          let parsedArgs: any = {};
          try { parsedArgs = JSON.parse(call.function.arguments); } catch { /* keep {} */ }
          // Never FORCE an empty configurator. Without a real style SKU (and nothing
          // already on the garment) the panel renders a blank/last mesh — the reason
          // every "sport jersey" looked identical. Withhold and make the model search.
          if (call.function.name === 'showConfigurator' && !parsedArgs.sku && !journeyState?.activeSku) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, needsRetrieval: true,
              message: 'Do NOT render without a real product. searchKnowledge for the specific garment the customer asked for, pick a designable style, and only then showConfigurator with that exact sku.' }) });
            continue;
          }
          // Undesignable styles never reach the panel — see the streaming path.
          if (verdict.designableAlternatives || (call.function.name === 'showConfigurator' && verdict.success === false)) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(verdict) });
            continue;
          }
          uiToolCalls.push(call);
          emit('uiAction', { name: call.function.name, arguments: parsedArgs });
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemVerdict || verdict) });
        }
      }
    } catch {
      /* best-effort — if the forced call fails, fall through to text-only */
    }
  }

  /** Backstop: strip image/link markdown from chat text (cards carry the media). */
  private stripChatMedia(text: string): string {
    if (!text) return text;
    return text
      // ![alt](url) — URL may contain (nested) parens like Group_(1).png
      .replace(/!\[[^\]]*\]\([^)]*(?:\([^)]*\)[^)]*)*\)/g, '')
      .replace(/!\[[^\]]*\]/g, '')                       // dangling ![alt]
      .replace(/https?:\/\/\S+/g, '')                    // bare URLs
      .replace(/\.(?:png|jpe?g|webp|avif|svg|gif)\)?/gi, '') // stray ".png)" fragments
      .replace(/\(\s*\)/g, '')                           // empty ()
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* A plain retail brand (cart, no configurator) customises / designs / 3D-renders
   * NOTHING — that vocabulary belongs to fixtures/sportswear/candy. The model still
   * occasionally leaks "these aren't customisable" or "3D" into chat despite the
   * guidance, so for those brands we DROP any sentence carrying that language before
   * it reaches the shopper. Config-gated: brands that DO personalise (M&M'S candy,
   * Augusta garments) have a configuratorType and are never touched. */
  private stripCartTaboo(text: string, active: boolean): string {
    if (!text || !active) return text;
    const TABOO = /\b(customi[sz]\w*|non-?customi\w*|un-?customi\w*|personali[sz]\w*|design\s+lines?|3-?d\b|configurat\w*)\b|colou?rs?\s+are\s+fixed|fixed\s+colou?rs?/i;
    const parts = text.split(/(?<=[.!?])(\s+)/);   // [sentence, sep, sentence, sep, …]
    let out = '';
    for (let i = 0; i < parts.length; i += 2) {
      const s = parts[i]; const sep = parts[i + 1] ?? '';
      if (s && TABOO.test(s)) continue;            // drop the offending sentence
      out += s + sep;
    }
    // Dropping a sentence can leave the next one starting with a dangling
    // conjunction ("However, each shirt…"). Trim it and re-capitalise.
    let cleaned = out.replace(/[ \t]{2,}/g, ' ').trim()
      .replace(/^(however|but|so|and|also|that said|in addition)[,\s]+/i, '');
    if (cleaned) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    return cleaned;
  }

  /**
   * Reconstruct the working set from server memory + the client's new message.
   * Client-minimal: prefer server-stored transcript + `request.message`. Falls
   * back to a client-sent `messages[]` (older clients) so nothing breaks.
   */
  private hydrate(request: ChatRequest, stored: any): { messages: any[]; journeyState: JourneyState } {
    const journeyState: JourneyState = stored?.journeyState || emptyJourneyState();
    // Self-heal sessions saved before persistableTranscript stripped tool_calls:
    // an assistant message with a dangling tool_calls array (its tool responses
    // long gone) makes OpenAI 400 every turn. Strip it on the way in too.
    const history: any[] = (Array.isArray(stored?.messages) ? stored.messages : []).map((m: any) =>
      m && m.role === 'assistant' && m.tool_calls ? { role: 'assistant', content: m.content } : m,
    );
    if (typeof request.message === 'string' && request.message.trim()) {
      return { messages: [...history, { role: 'user', content: request.message.trim() }], journeyState };
    }
    // Back-compat: client still sent the whole array.
    if (Array.isArray(request.messages) && request.messages.length) {
      return { messages: request.messages, journeyState };
    }
    return { messages: history, journeyState };
  }

  /** Client state is authoritative for the current turn only if it has content. */
  private hasStateContent(s?: ChatRequest['state']): boolean {
    if (!s) return false;
    return Boolean(
      (s.bom && s.bom.length) ||
        (s.recommendedProducts && s.recommendedProducts.length) ||
        (s.phase && s.phase !== 'intro'),
    );
  }

  /**
   * Runs the controlled conversation pipeline for one turn:
   *   intent-resolve → retrieval policy → generate (tool loop) → grounding check.
   * One visible agent, controlled internally (see docs/ARCHITECTURE.md §5).
   */
  async processChat(request: ChatRequest): Promise<ChatResponse> {
    const { tenantId = DEFAULT_TENANT_ID } = request;
    // CDL: design image held server-side for this turn (mirrors processChatStream).
    const turnImage = { imageBase64: request.imageBase64, imageUrl: request.imageUrl };
    const hasDesignImage = !!(turnImage.imageBase64 || turnImage.imageUrl);
    const trace: TraceEntry[] = [];

    // ── Step -1: Server-owned memory — reconstruct transcript + journey state ──
    // The client sends only { sessionId, message }. The server loads the
    // conversation and typed journey state it persisted last turn.
    const sessionId = request.sessionId || randomUUID();
    const stored = await this.sessionStore.load(sessionId, tenantId);
    const { messages, journeyState } = this.hydrate(request, stored);
    const state = stored?.state ?? request.state; // legacy UI-state (analytics only)
    const turnIndex = (stored?.turnCount || 0) + 1; // used to key per-tool-call trace entries (steps[])
    trace.push({
      step: 'session',
      detail: stored
        ? `resumed ${sessionId.slice(0, 8)} (turn ${(stored.turnCount || 0) + 1}, ${messages.length} msg, ledger v${journeyState.version})`
        : `new ${sessionId.slice(0, 8)}`,
    });

    // ── Step 0: Load published project config (model + persona + journey) ──
    const projectConfig = await this.configLoader.loadProjectConfig(tenantId);
    const model = projectConfig.model || this.model;   // per-project reasoning model
    const llm = getChatClient({ provider: projectConfig.provider, apiKey: projectConfig.apiKey, baseUrl: projectConfig.baseUrl }); // per-project provider + key
    console.log(`[JourneyAX] 🚀 Invoking LLM for tenant="${tenantId}" | provider="${projectConfig.provider || 'openai'}" | model="${model}" | url="${projectConfig.baseUrl || 'https://api.openai.com/v1'}"`);
    const configBlock = this.configLoader.renderConfigBlock(projectConfig);
    // High-level orientation so the agent starts knowing who this business is
    // (AUG-14). Cached; never blocks the turn.
    const brandHubProfile = await this.configLoader.loadBrandHub(tenantId);
    const brandHubBlock = this.configLoader.renderBrandHubBlock(brandHubProfile, projectConfig.capabilities, projectConfig);
    // Prefer the published Back Office Business Profile. Brand Hub remains a
    // compatibility fallback for tenants that predate that profile.
    const configuredEntityModel = projectConfig.business?.entityModel || brandHubProfile?.entityModel;
    const { supportsCustomisation, configuratorAvailable } = resolveCustomisationAvailability(projectConfig, brandHubProfile);
    trace.push({ step: 'config', detail: `model=${model} · configV=${projectConfig.configVersion ?? 'draft'}${projectConfig.journeyGuidance ? ' · +journeyGuidance' : ''}` });

    // ── Step 1: Intent detection (config-driven, no keyword routing) ──
    // Pass the project's configured context dimensions so classification (and
    // downstream retrieval scoping) is bounded by what THIS business serves.
    // ai.intentModel: 'project' → classify on this project's own model and
    // provider (a self-hosted tenant spends nothing on OpenAI); a model name →
    // that model on the platform key; unset → the platform classifier.
    const onProject = projectConfig.intentModel === 'project';
    const intent = await this.intentResolver.resolve(messages, state, onProject ? model : (projectConfig.intentModel || this.intentModel), projectConfig.contextDimensions, onProject ? llm : undefined, projectConfig.agentConfig);
    // Everything known about this customer so far (memory + this turn), with
    // derived dimensions filled in code (size from game) — never asked, always filters.
    const knownDims = deriveDimensions(projectConfig.contextDimensions, inferDimensionsFromText(projectConfig.contextDimensions, messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content || '')).join(' \n '), { ...(journeyState.dimensions || {}), ...(intent.dimensions || {}) }));
    intent.dimensions = { ...(intent.dimensions || {}), ...knownDims };
    const dimStr = Object.entries(intent.dimensions || {}).map(([k, v]) => `${k}=${v}`).join(',') || '—';
    trace.push({
      step: 'intent',
      detail: `${intent.intent} · dims=${dimStr} · space=${intent.space} · stage=${intent.stage} · mode=${intent.mode} · confidence=${intent.confidence}`,
      data: intent,
    });

    // ── Consultative Clarification Gate (Early Discovery Interception) ──
    // Consistent across ALL models: broad discovery queries immediately pop the
    // interactive clarification cards in the conversation. Zero wasted GPU loops,
    // instant response, session saved cleanly.
    const lastUserText = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
    // Storage sizing is arithmetic over the config guide, run here before the model speaks.
    const storageFacts = isStorageAsk(lastUserText) ? computeStorageFacts(projectConfig, lastUserText) : null;
    const retrievalCtx = deriveRetrievalContext(messages);
    // The built-in trade diagnostic question bank (wet areas, leaks, linings —
    // NZ building-supply vocabulary) is a per-tenant capability, never a
    // platform default: it surfaced "GIB Aqualine plasterboard" options on a
    // card-sleeve store because the model's prose mentioned "moisture".
    const allowDomainClarify = (projectConfig.capabilities || []).includes('domainClarify');
    // Sample-customer demo: the identity block for the profile the storefront bound to this request.
    const demoBlock = (projectConfig.capabilities || []).includes('customerHistory') ? await demoCustomerContext(projectConfig, request.demoPrincipalId, lastUserText, tenantId) : null;
    const isOpenModel =
      projectConfig.provider === 'placemaker' ||
      projectConfig.provider === 'jax' ||
      projectConfig.provider === 'jax-placemakers' ||
      (projectConfig.baseUrl || '').includes('8085') ||
      (projectConfig.baseUrl || '').includes('jax-placemakers');

    // ── Load back-office business rules (config over code) ──
    const activeRulesResult = await this.configLoader.loadActiveRules(tenantId);
    const activeRules = activeRulesResult.rules;
    if (activeRulesResult.ok && projectConfig.agentConfig) {
      projectConfig.agentConfig.rules.business = activeRules.map((rule) => ({
        name: rule.name,
        scope: rule.scope,
        condition: rule.condition,
        action: rule.action,
      }));
    }
    const skillIds = configuredSkillIds(projectConfig.agentConfig);
    const skillsBlock = skillIndexBlock(tenantId, skillIds, configuredSkills(projectConfig.agentConfig));
    trace.push({
      step: 'config-rules',
      detail: activeRules.length ? `${activeRules.length} active rule(s) loaded` : 'no rules configured',
      data: activeRules.map((r) => r.name),
    });

    // ── Step 3: Retrieval routing (don't fetch PDFs during discovery) ─
    const policy = buildRetrievalPolicy(intent, projectConfig.agentConfig);
    trace.push({
      step: 'retrieval-policy',
      detail: policy.allowRetrieval ? `allow [${policy.allowedTypes.join(', ')}]` : 'no retrieval (discovery — ask first)',
    });
    const searchMemo = new TurnSearchMemo(tenantId);
    if (policy.allowRetrieval && (projectConfig.capabilities || []).includes('products') && intent.intent !== 'general_question' && intent.retrievalType !== 'faq' && !isDetailAsk(lastUserText) && !/^(Add |Remove SKU|Change the quantity|Payment received)/i.test(lastUserText)) {
      searchMemo.prefetch(effectiveSearchQuery('', retrievalCtx));
    }

    // ENFORCEMENT (not advice): when retrieval is disallowed this turn, remove
    // searchKnowledge from the tool set so the model physically cannot call it.
    const projectTools = buildToolset({
      enabledCapabilities: projectConfig.capabilities,
      entityModel: configuredEntityModel,
      closing: projectConfig.commerceMode === 'cart' ? 'bag' : 'quote',
    });
    const policyTools = policy.allowRetrieval
      ? projectTools
      : projectTools.filter((t) => t.type !== 'function' || t.function.name !== 'searchKnowledge');
    const activeTools = configuratorAvailable ? policyTools : withoutConfiguratorTool(policyTools);

    // ── Journey working-memory block (server-owned; the loop guard) ──────────
    // Replaces the thin, client-supplied state string. Tells the model exactly
    // what has been completed/presented so it never re-asks or re-offers.
    const stateContext = renderJourneyStateBlock(journeyState);

    // Transcript is already bounded by the memory layer (recent turns; the
    // journey block carries durable facts). No client-side compaction needed.
    const activeMessages = messages;

    const needsDiagnosticClarification =
      intent.retrievalType === 'troubleshooting' || intent.stage === 'installation';

    const diagnosticGuidance = needsDiagnosticClarification
      ? '\n- DIAGNOSIS FIRST: This is a support or installation issue. Use the configured context dimensions and active business rules to ask only the diagnostic questions needed before recommending a product or next step. Do not output a questionnaire in chat text.'
      : '';

    // Intent + retrieval guidance injected as a system message so the generation
    // step follows the policy (mode + what it may retrieve this turn).
    const intentGuidance =
      `[TURN GUIDANCE]\n- Detected intent: ${intent.intent} (stage: ${intent.stage}, mode: ${intent.mode})\n` +
      `- Missing context: ${intent.missingInfo.length ? intent.missingInfo.join(', ') : '(none)'}\n` +
      `- ${policy.guidance}${diagnosticGuidance}`;

    // ── Build Conversation Array ────────────────────────────────────
    // For open models (e.g. local Gemma 2 9B), provide a concise, high-speed trade persona
    // to prevent local GPU memory bloat and long prefill delays.
    const conversation: any[] = isOpenModel
      ? [
          {
            role: 'system',
            content: this.buildOpenModelTradePrompt(projectConfig),
          },
          ...activeMessages,
        ]
      : [
          { role: 'system', content: assembleSystemPrompt(intent.mode, intent.stage, projectConfig.agentConfig) },
          ...(brandHubBlock ? [{ role: 'system', content: brandHubBlock }] : []),
          ...(configBlock ? [{ role: 'system', content: configBlock }] : []),
          // v3 Card CMS skills (docs/v3-card-cms-architecture.md): name + one-line
          // "not needed when" description only — the full technique loads on
          // demand via the loadSkill tool, so a rarely-needed skill never
          // occupies every turn's context.
          ...(skillsBlock ? [{ role: 'system', content: skillsBlock }] : []),
          ...(stateContext ? [{ role: 'system', content: stateContext }] : []),
          { role: 'system', content: intentGuidance },
          ...configuredCustomisationGuidance(projectConfig, { activeSku: journeyState?.activeSku, hasDesignImage, enabled: configuratorAvailable }),
          ...(demoBlock ? [{ role: 'system', content: demoBlock }] : []),
          // The chips exist for shopping turns only — a complaint, a policy or how-to question, or an unknown ask never carries them.
          ...((() => { if (!/product_recommendation|design_inspiration|quote_order|remodel/.test(String(intent?.intent || ''))) return []; const m = missingAskableDimensions(projectConfig.contextDimensions, knownDims); return m.length ? [{ role: 'system', content: askBesideBlock(m) }] : []; })()),
          ...((isGiftAsk(lastUserText) || isGiftAsk(retrievalCtx?.brief || '')) && (projectConfig.capabilities || []).includes('products') ? [{ role: 'system', content:
            '[GIFT ASK] The customer is buying for someone else and usually cannot name a product. This is the one journey where the questions come FIRST: in a single round, ask the still-unanswered configured questions (game, how into it, budget) with setPhase clarify — no cards yet. Once they have answered, present ONE gift-safe bundle for their budget with presentBundle (real SKUs from retrieval; never a custom / final-sale item; seasonal only when the occasion matches), explain the size choice so the giver can repeat it, and offer checkout. No upsell pressure on a gift.' }] : []),
          ...(isSetAsk(lastUserText) ? [{ role: 'system', content:
            '[SET ASK] The customer wants a coordinated SET (a series, a kit, "the whole …", pieces that match). Retrieve the real members, then present them with presentBundle (heading, why, the SKUs with quantities) — one card, one total, one "Add all" — not as a plain showItems list. Members come from retrieval / the catalogue\'s collections only; never pad a set with a guess.' }] : []),
          ...(storageFacts ? [{ role: 'system', content: storageFactsBlock(storageFacts) }]
            : isStorageAsk(lastUserText) ? [{ role: 'system', content:
            '[STORAGE ASK] The customer is sizing storage for a number of cards or decks. Call recommendStorage(cards, sleeving) FIRST — it returns the families that fit with exact capacities from this business\'s own guide — then searchKnowledge/showItems those families and quote the capacity number you used. Do not narrate capacities from memory.' }] : []),
          ...(isDetailAsk(lastUserText) ? [{ role: 'system', content:
            '[DETAIL ASK] The customer is asking about ONE item they are already looking at (its detail card is on screen). Answer from that item\'s own catalogue facts — searchKnowledge for its exact name or code if you need them — in 2–4 sentences: what it is, what it is for, what to check before buying. Do NOT call showItems with a new list, and do not present alternatives unless they ask.' }] : []),
          ...(isComparisonAsk(lastUserText) ? [{ role: 'system', content:
            '[COMPARISON ASK] The customer is asking how two (or more) named products, ranges or variants differ. Answer it as a comparison, not prose: ' +
            'searchKnowledge for EACH named item, showItems the real matches, then call presentComparison with those SKUs on the dimensions they care about — all in THIS turn. ' +
            'Keep your text to the one-line verdict; the table carries the facts.' }] : []),
          ...((projectConfig.capabilities || []).includes('products') ? [{ role: 'system', content:
            '[CARDS CARRY THE ITEMS] If you call showItems this turn, the customer sees every item as a card (name, image, price, and your per-item `description` as the reason) directly under your text. ' +
            'Your text must NOT list the items — no "1. Name: …" / "2. Name: …", no bullets, no naming each one in turn. Write 2-3 sentences at most: your lead pick and why, how they fit what was asked — then one next-step question.' }] : []),
          ...activeMessages
        ];

    const maxLoops = 6;
    // Backoffice retrieval policy is authoritative; the platform default is the
    // fallback when no tenant value is published.
    const MAX_SEARCHES = Math.max(1, projectConfig.agentConfig?.retrieval?.maxSearchCallsPerTurn ?? 3);
    let loops = 0;
    let searchCount = 0;
    let hadRetrieval = false;        // did any searchKnowledge run this turn? (for grounding check)
    let forceText = false;           // when true, next call must produce text (no tools)
    let forcedUi = false;            // panel-render enforcement fired already?
    let finalMessage: any = null;
    let mustClarifyGender = false;   // gender gate fired → guarantee a clarify panel (post-turn)
    let cdlUseSku: string | null = null;  // CDL: analyzeDesign matched a real template → force the configurator
    let cdlSuggested: any = null;         // CDL: server-built configurator config (colours+text mapped to the palette)
    const uiToolCalls: any[] = [];
    const wantUiTool = this.requiredUiTool(intent, { configuratorAvailable, activeSku: journeyState?.activeSku });

    // Mandatory opening move: research the named org before the model acts.
    // When it researches THIS turn, the colour-confirmation card owns the panel —
    // suppress a same-turn clarify so the model can't bury it under a question form.
    this.noteTeamSize(conversation, journeyState);
    this.noteShownItems(conversation, journeyState);
    await this.noteNamedStyle(tenantId, conversation, journeyState, configuratorAvailable);
    const researchedThisTurn = await this.maybeResearchOrg(tenantId, projectConfig, intent, journeyState, conversation, uiToolCalls);
    await maybeForceSizeRecommendation(tenantId, conversation, activeTools, projectConfig.capabilities, uiToolCalls, () => {}, model, llm);

    const cartCommandApplied = await applyStorefrontCartCommand({ tenantId, sessionId, text: lastUserText, journeyState, projectConfig, uiToolCalls, conversation, quoteService: this.quoteService, fetchPricebookRows, lookupSkuFacts, productMatches, pickNamedProduct });
    await applyOrderPlacedContext({ tenantId, text: lastUserText, conversation, journeyState, orderService: this.orderService, quoteService: this.quoteService });

    // ── Step 5: Generation — controlled tool-calling loop ───────────
    while (loops < maxLoops) {
      loops++;
      if (isOpenModel) {
        const response = await llm.chat.completions.create({
          model,
          messages: conversation,
          max_tokens: openModelMaxTokens(projectConfig),
          ...genParams(model, projectConfig.temperature),
        });
        finalMessage = response.choices[0].message;
        const rawContent = finalMessage?.content || '';
        console.log(`[JourneyAX:ModelResponse] 💬 Model output for tenant="${tenantId}" [model=${model}]:\n${rawContent}`);

        const searchStats = { searched: false };
        let toolExecuted = await this.executeOpenModelToolCalls(tenantId, rawContent, intent, uiToolCalls, undefined, (t) => trace.push(t), retrievalCtx, searchStats, allowDomainClarify, searchMemo);
        if (!cartCommandApplied && await this.ensureRetrievalAfterAnswers(tenantId, retrievalCtx, searchStats, uiToolCalls, undefined, (t) => trace.push(t), { journeyState, intent }, searchMemo)) toolExecuted = true;
        if (!toolExecuted) {
          const modelClarifyAction = this.extractQuestionsFromModelResponse(rawContent, lastUserText, intent, allowDomainClarify);
          if (modelClarifyAction) {
            console.log(`[JourneyAX:ModelClarify] 💡 Extracted diagnostic questions directly from model response:`, modelClarifyAction.arguments.questions.map((q: any) => q.title));
            uiToolCalls.push({
              id: `model_text_clarify_${Date.now()}`,
              type: 'function',
              function: { name: 'setPhase', arguments: JSON.stringify(modelClarifyAction.arguments) },
            });
          } else {
            await this.resolveOpenModelProducts(tenantId, lastUserText, rawContent, intent, uiToolCalls, undefined, (t) => trace.push(t));
          }
        }

        let cleanedContent = rawContent.replace(/TOOL_CALL:\s*[a-zA-Z0-9_]+\s*\([\s\S]*?\)/gi, '').trim();
        cleanedContent = cleanedContent.replace(/(?:oh no,?\s*)?(?:a\s*)?leaking\s+bathroom\s+is\s+never\s+fun!?[.\s]*/gi, '').trim();
        if (cleanedContent && !cleanedContent.startsWith('To figure out') && !cleanedContent.startsWith('Water leaks') && !cleanedContent.startsWith('A leaking')) {
          cleanedContent = cleanedContent.charAt(0).toUpperCase() + cleanedContent.slice(1);
        }
        if (!cleanedContent) {
          cleanedContent = 'Here are the relevant products from our catalogue:';
        }
        finalMessage.content = cleanedContent;
        conversation.push(finalMessage);
        break;
      }
      const response = await llm.chat.completions.create({
        model,
        messages: conversation,
        tools: activeTools,
        // Forced-text pass → no tools. Otherwise the model decides freely (whether
        // to clarify, search, or answer) — guided by config/journeyGuidance, not by
        // hardcoded keyword/turn heuristics.
        tool_choice: forceText ? 'none' : 'auto',
        ...genParams(model, projectConfig.temperature),
      });

      const msg = response.choices[0].message;
      finalMessage = msg;
      conversation.push(msg);

      // Terminal: a forced-text pass, or a normal answer with no tool calls.
      if (forceText || !msg.tool_calls || msg.tool_calls.length === 0) {
        // If retrieval happened but the required panel tool (showProducts/showGuide)
        // never fired, force it once so the right 60% panel renders. No-op emit —
        // the buffered response returns uiToolCalls directly.
        // The configurator needs no retrieved data — it needs the design the
        // customer just described, which is already in the conversation. Gating
        // it on retrieval meant a pure design turn rendered nothing at all.
        // Never force a UI render on the research turn — the colour-confirmation
        // card owns the panel and the customer must confirm first.
        // CDL match forces the configurator regardless of the intent-derived want.
        const effWantUi = cdlUseSku && configuratorAvailable ? 'showConfigurator' : wantUiTool;
        if (!forceText && !researchedThisTurn && (hadRetrieval || effWantUi === 'showConfigurator') && effWantUi && !forcedUi &&
            !intent.panelRenderBlocked &&
            !uiToolCalls.some((c) => c.function?.name === effWantUi)) {
          forcedUi = true;
          trace.push({ step: 'forced-ui', detail: `${effWantUi}${cdlUseSku ? ` (CDL match ${cdlUseSku})` : ''} (model answered in prose)` });
          await this.forceUiTool(tenantId, conversation, activeTools, effWantUi, uiToolCalls, () => {}, model, llm, journeyState, supportsCustomisation, projectConfig.configuratorType);
        }
        break;
      }

      let didSearch = false;
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue;

        // Deterministic relationship lookup. Doesn't consume the search budget
        // (it's an exact index hit, not a vector query) but does count as
        // grounding — its result is real catalogue fact.
        if (call.function.name === 'findRelated' || call.function.name === 'getProductOptions'
            || call.function.name === 'findEntity' || call.function.name === 'registerEntity'
            || call.function.name === 'requestArtwork' || call.function.name === 'checkArtworkApproval'
            || call.function.name === 'readRoster' || call.function.name === 'getTeamColours'
            || call.function.name === 'analyzeDesign' || call.function.name === 'generateDesign'
            || call.function.name === 'generateTeamDesign' || call.function.name === 'submitTeamOrder'
            || call.function.name === 'submitForReview' || call.function.name === 'checkReviewStatus'
            || call.function.name === 'recommendSize' || call.function.name === 'uploadPhotosFor3D'
            || call.function.name === 'buildProjectPlan' || call.function.name === 'checkBranchStock'
            || call.function.name === 'openSpacePlanner' || call.function.name === 'recommendStorage' || DEMO_CUSTOMER_TOOLS.has(call.function.name)) {
          hadRetrieval = true;
          const result = DEMO_CUSTOMER_TOOLS.has(call.function.name)
            ? await runDemoCustomerTool(projectConfig, request.demoPrincipalId, call.function.name, call.function.arguments, tenantId)
            : call.function.name === 'recommendStorage'
            ? recommendStorage(projectConfig, call.function.arguments)
            : call.function.name === 'openSpacePlanner'
            ? { ok: true, roomType: 'laundry', message: 'PlaceMakers Space Planner launched' }
            : call.function.name === 'buildProjectPlan'
            ? handleBuildProjectPlan(call.function.arguments)
            : call.function.name === 'checkBranchStock'
            ? handleCheckBranchStock(call.function.arguments)
            : call.function.name === 'getTeamColours'
            ? await getTeamColours(tenantId, call.function.arguments)
            : call.function.name === 'analyzeDesign'
            ? await analyzeDesign(tenantId, turnImage, call.function.arguments)
            : call.function.name === 'generateDesign'
            ? await generateDesign(tenantId, call.function.arguments)
            : call.function.name === 'generateTeamDesign'
            ? await generateTeamDesign(tenantId, turnImage, call.function.arguments)
            : call.function.name === 'uploadPhotosFor3D'
            ? await uploadPhotosFor3D(call.function.arguments)
            : call.function.name === 'submitTeamOrder'
            ? await submitTeamOrder(tenantId, sessionId, journeyState, call.function.arguments)
            : call.function.name === 'submitForReview'
            ? await submitForReview(tenantId, sessionId, call.function.arguments)
            : call.function.name === 'checkReviewStatus'
            ? await checkReviewStatus(tenantId, sessionId)
            : call.function.name === 'recommendSize'
            ? await recommendSize(tenantId, call.function.arguments)
            : call.function.name === 'readRoster'
            ? await readRoster(tenantId, call.function.arguments)
            : call.function.name === 'findRelated'
            ? await lookupRelated(tenantId, call.function.arguments)
            : call.function.name === 'findEntity'
              ? await lookupEntities(tenantId, call.function.arguments)
              : call.function.name === 'registerEntity'
                ? await saveEntity(tenantId, call.function.arguments)
                : call.function.name === 'requestArtwork'
                  ? await requestArtwork(tenantId, sessionId, call.function.arguments)
                  : call.function.name === 'checkArtworkApproval'
                    ? await checkArtworkApproval(tenantId, sessionId)
                    : await lookupOptions(tenantId, call.function.arguments);
          // CDL: a matched template ('use') must land the customer in the 3D
          // configurator. Render it deterministically now — a CDL data tool sets
          // didSearch=false, so the loop would otherwise speak and exit before the
          // match is ever shown.
          if ((call.function.name === 'analyzeDesign' || call.function.name === 'generateDesign')
              && (result as any)?.decision === 'use' && (result as any)?.template?.sku) {
            cdlUseSku = String((result as any).template.sku);
            if ((result as any).suggestedConfig?.sku) cdlSuggested = (result as any).suggestedConfig;
          }
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          {
            const _s = summarizeToolCall(call.function.name, safeParseArgs(call.function.arguments), result);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
          // PlaceMakers Project Plan: successful calculation pushes to UI
          if (call.function.name === 'buildProjectPlan' && (result as any)?.ok
              && !uiToolCalls.some((c) => c.function?.name === 'buildProjectPlan')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'buildProjectPlan', arguments: JSON.stringify(result) } } as any);
          }
          // PlaceMakers Branch Stock: successful lookup pushes to UI
          if (call.function.name === 'checkBranchStock' && (result as any)?.ok
              && !uiToolCalls.some((c) => c.function?.name === 'checkBranchStock')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'checkBranchStock', arguments: JSON.stringify(result) } } as any);
          }
          // PlaceMakers Space Planner: launches 3D/2D space planner UI
          if (call.function.name === 'openSpacePlanner'
              && !uiToolCalls.some((c) => c.function?.name === 'openSpacePlanner')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'openSpacePlanner', arguments: call.function.arguments || '{}' } } as any);
          }
          // Coach team-order journey: a successful generateTeamDesign must land
          // the coach on the teamDesign panel with the four views — mirrors the
          // cdlUseSku → showConfigurator push just below, but for its OWN tool
          // name (there is no template/decision to resolve here, so no forced
          // showConfigurator).
          if (call.function.name === 'generateTeamDesign' && (result as any)?.ok
              && !uiToolCalls.some((c) => c.function?.name === 'generateTeamDesign')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'generateTeamDesign', arguments: JSON.stringify(result) } } as any);
          }
          // Real-photo 3D match: a successful uploadPhotosFor3D must land the
          // customer on the photo-upload panel — same double-write pattern as
          // generateTeamDesign just above, under its OWN tool name.
          if (call.function.name === 'uploadPhotosFor3D' && (result as any)?.ok
              && !uiToolCalls.some((c) => c.function?.name === 'uploadPhotosFor3D')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'uploadPhotosFor3D', arguments: JSON.stringify(result) } } as any);
          }
          // Fitment guide: a real recommendation (or an honest "no chart yet")
          // renders as a small card — same double-write pattern as
          // generateTeamDesign just above, under recommendSize's own name.
          if (call.function.name === 'recommendSize'
              && !uiToolCalls.some((c) => c.function?.name === 'recommendSize')) {
            uiToolCalls.push({ id: call.id, type: 'function', function: { name: 'recommendSize', arguments: JSON.stringify(result) } } as any);
          }
          if (cdlUseSku && configuratorAvailable && !forcedUi && !intent.panelRenderBlocked &&
              !uiToolCalls.some((c) => c.function?.name === 'showConfigurator')) {
            forcedUi = true;
            if (cdlSuggested?.sku) {
              // Colour fix: server-built config (all analysed colours mapped to the
              // style palette), not model-built — the buffered path returns
              // uiToolCalls directly, so no emit is needed.
              trace.push({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku}, server config)` });
              uiToolCalls.push({ id: `cdl_${cdlUseSku}`, type: 'function', function: { name: 'showConfigurator', arguments: JSON.stringify(cdlSuggested) } } as any);
              conversation.push({ role: 'system', content: `[RENDERED] The customer's design is already shown in the conversation in their colours on style ${cdlUseSku}. Do NOT call showConfigurator again this turn; tell them it's shown and invite tweaks or sending it to the artist.` });
            } else {
              trace.push({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku})` });
              await this.forceUiTool(tenantId, conversation, activeTools, 'showConfigurator', uiToolCalls, () => {}, model, llm, journeyState, supportsCustomisation, projectConfig.configuratorType);
            }
          }
          continue;
        }

        if (call.function.name === 'loadSkill') {
          // v3 Card CMS skills (docs/v3-card-cms-architecture.md): the system
          // prompt only ever carries the name + one-line description; the full
          // technique is fetched here, on demand, so it never occupies context
          // on a turn that doesn't need it.
          let skillArgs: any = {};
          try { skillArgs = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
          const body = loadSkillBody(tenantId, String(skillArgs?.name || ''), skillIds);
          conversation.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify(body ? { found: true, name: skillArgs.name, body } : { found: false, message: `No skill named '${skillArgs?.name}'.` }),
          });
          continue;
        }
        if (call.function.name === 'searchKnowledge') {
          didSearch = true;
          if (searchCount >= MAX_SEARCHES) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                found: false,
                message: 'Search limit reached for this turn. Answer using what you already retrieved, or ask the customer one clarifying question. Do not search again.',
              }),
            });
            continue;
          }
          searchCount++;
          hadRetrieval = true;
          try {
            const args = JSON.parse(call.function.arguments);
            // Retrieval goes through the KnowledgePort — the agent no longer knows
            // the product-service URL. Swap the tenant's knowledge platform in the
            // integration registry and this agent is unchanged.
            // Gender is injected SERVER-SIDE from the resolved intent (not the model) so
            // a "men's" journey never surfaces women's products — hard filter, not a hint.
            const toolResult = await searchMemo.search(
              { query: `${effectiveSearchQuery(args.query, retrievalCtx)} ${dimensionQuerySuffix(projectConfig.contextDimensions, knownDims)}`.trim(), type: args.type, category: args.category, limit: 8, gender: intent?.dimensions?.gender },
            );
            const markedResult = await markDesignable(tenantId, toolResult);
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              // Fencing (docs/v3-card-cms-architecture.md): scraped/ingested
              // prose (a description, a document body) is now clearly labelled
              // as data before it reaches the model — structural fields (sku,
              // price) are untouched, so parsing behaviour is unchanged.
              content: JSON.stringify(fenceSearchResultText(markedResult)),
            });
            {
              const _s = summarizeToolCall('searchKnowledge', args, toolResult);
              void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'searchKnowledge', ..._s, ts: new Date().toISOString() });
            }
          } catch (err) {
            console.error('[AgentService] Knowledge search error:', err);
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ found: false, message: 'Knowledge search failed.' }),
            });
            void this.sessionStore.appendStep(sessionId, tenantId, {
              turnIndex, tool: 'searchKnowledge',
              argsSummary: summarizeToolCall('searchKnowledge', safeParseArgs(call.function.arguments), {}).argsSummary,
              resultSummary: 'search failed',
              ts: new Date().toISOString(),
            });
          }
        } else if (UI_TOOL_NAMES.has(call.function.name)) {
          await enforceNamedSku(tenantId, conversation, call);   // identity wins over the model
          const parsedArgs = JSON.parse(call.function.arguments);
          // GENDER GATE: never show products until we know Men/Women/Kids (config-driven).
          if (call.function.name === 'showItems' && this.needsGenderFirst(intent, projectConfig, messages)) {
            mustClarifyGender = true;
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, clarifyFirst: true,
              message: 'STOP — you do not know whether the shopper wants Men, Women or Kids, and these are different products. Do NOT show products yet. Call setPhase("clarify") NOW with a gender question (id "gender", title "Who are we shopping for?", options ["Men","Women","Kids"]) plus occasion and their usual size if still unknown.' }) });
            didSearch = true;   // loop so the model clarifies instead of presenting
            continue;
          }
          // Just researched a school this turn → the colour-confirmation card owns
          // the panel. Suppress a same-turn clarify so it isn't buried under a form;
          // the model still SPEAKS (acknowledge colours, invite confirmation).
          if (researchedThisTurn && call.function.name === 'setPhase' && parsedArgs.phase === 'clarify') {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, deferred: true,
              message: 'The colour-confirmation card is already on the panel. Do NOT clarify this turn — acknowledge the mascot and colours in one sentence and invite the customer to confirm. You will clarify or present concepts AFTER they confirm.' }) });
            continue;
          }
          // Asked to SEE something and the panel is empty → find it first, ask after.
          if (call.function.name === 'setPhase' && parsedArgs.phase === 'clarify'
              && this.askedToSeeSomething(intent, journeyState, projectConfig?.commerceMode)) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, showFirst: true,
              message: 'The customer asked to SEE a product and the panel is empty. searchKnowledge for what they named and call showItems THIS TURN. Then ask what is still missing — team, sizes, quantity — in one short sentence beside the items. Never open with a questionnaire.' }) });
            didSearch = true;   // keep looping so the model searches instead of speaking
            continue;
          }
          // ENFORCE: clarify must carry questions (see streaming path). Reject and retry.
          if (
            call.function.name === 'setPhase' &&
            parsedArgs.phase === 'clarify' &&
            (!Array.isArray(parsedArgs.questions) || parsedArgs.questions.length === 0)
          ) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ success: false, error: 'setPhase("clarify") REQUIRES a non-empty "questions" array of 3-5 items, each with { id, title, options[2-5] }. Re-call setPhase now with the questions populated.' }),
            });
            didSearch = true; // keep looping so the model corrects it (don't force text yet)
            continue;
          }
          // Live school research (AUG-48) — retrieve the brand AND surface a
          // confirmation card. The emitted uiAction carries the SERVER research,
          // never the model's guess; the tool result tells the model which
          // palette colours to use next.
          if (call.function.name === 'researchSchool') {
            const research = await this.runSchoolResearch(tenantId, projectConfig, call.function.arguments);
            (call as any).__research = research;
            uiToolCalls.push(call);
            const cols = (research.colours || []).map((c: any) => `${c.name}${c.mappedTo ? ` → our ${c.mappedTo.name}` : ''}`).join(', ');
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
              success: !research.error, ...(research.error ? { error: research.error } : {}),
              team: research.team, mascot: research.mascot, colours: cols, confidence: research.confidence,
              note: 'This is shown to the customer for confirmation. Once they confirm, use the mapped palette colour names (the "our X" ones) for searchKnowledge and rendering — do not invent colours. Never recreate the logo.',
            }) });
            {
              const _s = summarizeToolCall('researchSchool', safeParseArgs(call.function.arguments), research);
              void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'researchSchool', ..._s, ts: new Date().toISOString() });
            }
            continue;
          }
                    // P0-04: updateQuote is SERVER-AUTHORITATIVE and is NOT loop-guarded —
          // the model proposes only { sku, quantity }; we rehydrate real prices
          // and compute totals here. The emitted uiAction carries the SERVER quote,
          // never the model's numbers.
          if (call.function.name === 'updateQuote') {
            const _size = Number(journeyState.teamSize) || 0;
            const _items = Array.isArray(parsedArgs.items) ? parsedArgs.items : [];

            // P0 GUARD: Refuse to build an empty quote or quote without valid items!
            if ((!_items.length || _items.every((it: any) => !String(it?.sku || '').trim())) && !(projectConfig.commerceMode === 'cart' && Array.isArray(parsedArgs.remove) && parsedArgs.remove.length)) {
              conversation.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({
                  success: false,
                  emptyItems: true,
                  message: 'You called updateQuote with NO products (0 items). You cannot create an empty quote or use updateQuote for an assessment summary or diagnostic report. A quote is strictly for ordering real products with SKUs. If you are diagnosing or troubleshooting a leak or repair, use showGuide to present step-by-step diagnostic/inspection instructions. If recommending replacement fixtures/mixers/parts, search the catalogue with searchKnowledge and call showItems. Do NOT call updateQuote without real products.'
                })
              });
              didSearch = true;
              continue;
            }

            if (projectConfig.commerceMode === 'cart') {
              // BAG TENANT: the model proposes, the bag path disposes — one
              // deterministic add / change / remove per line, so limits, sold-out
              // and the grounded "[BAG UPDATED]" note apply exactly as for a tap.
              // A quote-style full replace lost every line the model forgot.
              const bag = journeyState?.quoteId ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null) : null;
              const have = new Map<string, number>((bag?.lines || []).map((l: any) => [String(l.sku).toUpperCase(), Number(l.quantity) || 1]));
              const adds: string[] = []; const cmds: string[] = [];
              for (const it of _items) {
                const k = String(it?.sku || '').trim().toUpperCase(); if (!k) continue;
                const want = Math.max(1, Math.floor(Number(it.quantity) || 1)); const cur = have.get(k);
                if (cur == null) adds.push(`${k} (qty ${want})`);
                else if (it.quantity != null && cur !== want) cmds.push(`Change the quantity of SKU ${k} to ${want}.`);
              }
              for (const r of (Array.isArray(parsedArgs.remove) ? parsedArgs.remove : [])) { const k = String(r || '').trim().toUpperCase(); if (k && have.has(k)) cmds.push(`Remove SKU ${k} from my bag.`); }
              if (adds.length) cmds.unshift(`Add SKUs ${adds.join(', ')} to my bag.`);
              // The tool result must directly follow the assistant's tool call — the bag
              // path's own system notes are collected and appended after it.
              let applied = false;
              const notes: any[] = [];
              for (const c of cmds) if (await applyStorefrontCartCommand({ tenantId, sessionId, text: c, journeyState, projectConfig, uiToolCalls, conversation: notes, quoteService: this.quoteService, fetchPricebookRows, lookupSkuFacts, productMatches, pickNamedProduct })) applied = true;
              const bagNow = journeyState?.quoteId ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null) : null;
              conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(applied
                ? { success: true, applied: true, bagNow: (bagNow?.lines || []).map((l: any) => ({ sku: l.sku, name: l.name, quantity: l.quantity })), total: bagNow?.total, note: 'Applied by the server. bagNow is the complete bag after this change — confirm ONLY what changed this turn, by product name, in one sentence; never say something was removed if it is still in bagNow.' }
                : { success: false, note: 'Nothing changed: those items are already in the bag at that quantity, or no real SKU was given. Say what is in the bag; do not claim to have added anything.' }) });
              conversation.push(...notes);
              {
                const _s = summarizeToolCall('updateQuote', parsedArgs, { applied, commands: cmds });
                void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'updateQuote', ..._s, ts: new Date().toISOString() });
              }
              continue;
            }
            if (_size > 1 && _items.length && _items.every((it: any) => (Number(it.quantity) || 1) <= 1)) {
              conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
                success: false, quantityMissing: true,
                message: `The customer needs ${_size} pieces, but every line is quantity 1 — that quotes a team order as a single garment. Re-call updateQuote with quantity=${_size} on each per-player garment.` }) });
              didSearch = true;
              continue;
            }

            const quote = await buildAuthoritativeQuote({ quoteService: this.quoteService, tenantId, sessionId, args: parsedArgs, pricing: projectConfig.pricing });

            // P0 GUARD: If no quoted items could be priced from the catalogue, do not emit an empty quote!
            if (!quote.lines || quote.lines.length === 0) {
              conversation.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({
                  success: false,
                  emptyItems: true,
                  message: 'None of the quoted items could be found in the catalogue (0 priced lines). An empty quote cannot be created. Please search the catalogue with searchKnowledge for real products/mixers/fixtures and call showItems, or call showGuide if this is a diagnostic/troubleshooting issue.'
                })
              });
              didSearch = true;
              continue;
            }

            journeyState.quoteId = quote.quoteId;
            (call as any).__quote = quote;
            uiToolCalls.push(call);
            conversation.push({
              role: 'tool', tool_call_id: call.id,
              content: JSON.stringify({
                success: true, quoteId: quote.quoteId, currency: quote.currency,
                subtotal: quote.subtotal, discount: quote.discount, tax: quote.tax, total: quote.total,
                lineCount: quote.lines.length, validation: quote.validation,
                note: 'Totals are authoritative (server-computed from the catalogue + tenant pricing). Quote these exact figures; never state different numbers.',
              }),
            });
            {
              const _s = summarizeToolCall('updateQuote', parsedArgs, quote);
              void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'updateQuote', ..._s, ts: new Date().toISOString() });
            }
            {
              const _lu = [...conversation].reverse().find((m: any) => m?.role === 'user');
              const _xsell = this.crossSellDirective(projectConfig?.commerceMode, String(_lu?.content || ''), quote, journeyState);
              if (_xsell) { conversation.push({ role: 'system', content: _xsell }); didSearch = true; }
            }
            continue;
          }
          // NEVER render an empty configurator. A showConfigurator with no real
          // style SKU (and nothing already on the garment) means the model skipped
          // retrieval — so every "sport jersey" renders the same blank/last mesh.
          // Force it to search for the actual garment and pick a real style first.
          if (call.function.name === 'showConfigurator' && !parsedArgs.sku && !journeyState.activeSku) {
            conversation.push({
              role: 'tool', tool_call_id: call.id,
              content: JSON.stringify({ success: false, needsRetrieval: true,
                message: 'You tried to open the designer without a real product. Do NOT render a garment you have not retrieved. First call searchKnowledge for the SPECIFIC garment the customer asked for (e.g. the sport + "jersey"), pick ONE designable style from the results, then call showConfigurator again with that exact sku. Different sports must resolve to different styles.' }),
            });
            didSearch = true; // loop so the model searches, then renders the real style
            continue;
          }
          // LOOP GUARD (idempotency): if this exact presentation was already made
          // earlier in the journey, suppress it and tell the model it's done — the
          // structural fix for the accessory/step loop.
          if (alreadyPresented(journeyState, call.function.name, parsedArgs)) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                success: false,
                alreadyDone: true,
                message: `You ALREADY presented this ${call.function.name} earlier in this conversation (it is in the conversation). Do NOT present it again. Acknowledge it briefly if relevant and move to the next unmet goal in the journey memory.`,
              }),
            });
            didSearch = true; // let the model react (move on), don't force text yet
            continue;
          }
          // UI tools carry no data dependency, but a design still has to be
          // PRODUCIBLE. Answering "success" regardless is how the model came to
          // confirm colours the brand does not stock on a style that cannot be
          // printed at all.
          const verdict = await validateDesign(tenantId, call, projectConfig.configuratorType);
          const itemVerdict = await enforceItemDesignability(
            tenantId, call, supportsCustomisation);
          // A bundle the catalogue cannot back (fewer than two real, in-stock,
          // priced members) is withheld — the model hears why and searches.
          if (bundleRefused(call, itemVerdict)) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemVerdict) });
            didSearch = true;
            continue;
          }
          const itemFacts = await groundItemFacts(tenantId, call);
          const hardDropped = applyDimensionHardFilter(call, projectConfig.contextDimensions, knownDims);
          // Everything dropped (sold out / not real / wrong variant) → no empty
          // card; the model is told why and searches again.
          const emptied = emptyShowItemsVerdict(call, itemFacts, hardDropped);
          if (emptied) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(emptied) });
            didSearch = true;
            continue;
          }
          this.applySizePreselect(call, this.resolveShopperSize(intent, messages));
          // Complete-the-look: drop same-category cards. If nothing complementary
          // survives, reject once and make the model search a DIFFERENT category —
          // this is what stops the "keeps showing the same jeans" loop.
          if (call.function.name === 'showItems' && journeyState.crossSellFor && this.applyCrossSellFilter(call, journeyState)) {
            const canRetry = (journeyState.crossSellRetries || 0) < 1;
            journeyState.crossSellRetries = (journeyState.crossSellRetries || 0) + 1;
            if (!canRetry) journeyState.crossSellFor = null;
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(canRetry
              ? { success: false, sameCategoryOnly: true, message: 'Those are the SAME category as what is already in the bag — that does not complete the look. Do NOT show that category again. searchKnowledge for a COMPLEMENTARY, DIFFERENT category for the same gender (bottoms/jeans → a top: shirt/tee/sweater, or shoes; a top → bottoms or shoes; a dress → shoes/a jacket) and showItems those.' }
              : { success: true, note: 'No complementary items found — ask what they would like to add, or invite checkout. Do not re-show the same category.' }) });
            if (canRetry) didSearch = true;
            continue;
          }
          // Undesignable styles never reach the panel — see the streaming path.
          if (call.function.name !== 'showConfigurator' || verdict.success !== false) uiToolCalls.push(call);
          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(itemFacts.soldOut.length ? { ...(itemVerdict || verdict), soldOut: itemFacts.soldOut, note: 'These were dropped as SOLD OUT and are not on screen — say so if the customer asked for one by name.' } : (itemVerdict || verdict)),
          });
          {
            const _s = summarizeToolCall(call.function.name, parsedArgs, itemVerdict || verdict);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
        }
      }

      // If this turn emitted ONLY UI tools (no searchKnowledge), there is no new
      // data to reason over — the model must now produce its text answer. Forcing
      // text next prevents the UI-tool loop that previously burned all iterations
      // and returned an empty, tool-only message.
      if (!didSearch) {
        forceText = true;
      }
    }

    // After the customer answered the chips, cards must follow — gpt-4o said
    // "let's take a look at this binder" and showed nothing. Same guarantee
    // the open-model path has, answers-only (never show-first) on this path.
    if (!cartCommandApplied && (projectConfig.capabilities || []).includes('products')) {
      const shownStats = { searched: uiToolCalls.some((c: any) => ['showItems', 'presentBundle', 'presentComparison'].includes(c?.function?.name)) };
      if (await this.ensureRetrievalAfterAnswers(tenantId, retrievalCtx, shownStats, uiToolCalls, undefined, (t) => trace.push(t), { journeyState, intent, answersOnly: true }, searchMemo)) {
        conversation.push({ role: 'system', content: '[CARDS SHOWN] Cards matching their answers are now on screen under your text. Do not list them; give your pick and one next step.' });
      }
    }
    await this.ensureStorageCards(tenantId, storageFacts, uiToolCalls, conversation);
    // Safety net: never return a tool-only message with no text to the user.
    // No tools/tool_choice → pure text (OpenAI rejects tool_choice without tools).
    if (finalMessage && finalMessage.tool_calls && finalMessage.tool_calls.length > 0 && !finalMessage.content) {
      const textPass = await llm.chat.completions.create({
        model,
        messages: conversation,
        ...genParams(model, projectConfig.temperature),
      });
      finalMessage = textPass.choices[0].message;
      conversation.push(finalMessage);
    }

    // ── Step 6: Grounding validation (technical mode) ───────────────
    const verdict = validateGrounding(finalMessage?.content || '', intent.mode, hadRetrieval);
    trace.push({ step: 'grounding', detail: verdict.ok ? 'ok' : verdict.reason || 'flagged' });
    trace.push({ step: 'generate', detail: `${loops} loop(s), ${searchCount} search(es), ${uiToolCalls.length} ui action(s)` });

    if (finalMessage?.content) {
      const plainRetail = projectConfig?.commerceMode === 'cart' && !projectConfig?.configuratorType;
      finalMessage.content = this.stripCartTaboo(this.stripChatMedia(finalMessage.content), plainRetail);
      if (plainRetail && !String(finalMessage.content || '').trim()) {
        finalMessage.content = 'Here are a few great options — let me know which one catches your eye, or head to checkout any time.';
      }
    }

    // ── Step 7: Reduce this turn's actions into journey memory, then persist ──
    // updateQuote emits the SERVER quote (P0-04), not the model's raw arguments.
    const uiActions = uiToolCalls.map((call) => ({
      name: call.function.name,
      arguments: (call as any).__quote ? (call as any).__quote
        : (call as any).__research ? (call as any).__research
        : JSON.parse(call.function.arguments),
    }));
    // Same compaction as the streamed path: the card lists the items, the text does not.
    if (!isOpenModel && finalMessage?.content) {
      const names = shownItemNames(uiToolCalls);
      if (names.length >= 2) finalMessage = { ...finalMessage, content: compactItemListing(String(finalMessage.content), names) };
    }
    // SAFETY NET: the gender gate fired but the model didn't render a clarify → synthesize
    // it so the buttoned panel ALWAYS appears (deterministic, no model dependence).
    if (mustClarifyGender && !uiActions.some((a) => a.name === 'setPhase' && (a.arguments as any)?.phase === 'clarify')) {
      uiActions.push(this.synthGenderClarify(intent));
      if (!finalMessage?.content) finalMessage = { role: 'assistant', content: 'Happy to help! First — who are we shopping for, and what’s the occasion?' };
    }
    // SAFETY NET: Clarify synthesis when no UI action or products were rendered
    if (allowDomainClarify && !uiActions.some((a) => a.name === 'setPhase') && uiActions.length === 0 && !intent.panelRenderBlocked) {
      const userText = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
      const synthClarify = this.buildDomainClarify(userText, intent, finalMessage?.content || '');
      if (synthClarify) {
        uiActions.push({ name: 'setPhase', arguments: { phase: 'clarify', questions: synthClarify.questions } });
        if (synthClarify.chatLead) {
          finalMessage = { role: 'assistant', content: synthClarify.chatLead };
        }
      }
    }
    const nextState = reduceActions(journeyState, uiActions, intent);
    // Append the assistant's spoken reply to the transcript, then persist the
    // bounded transcript + updated journey memory. The client stores nothing.
    if (finalMessage?.content) conversation.push({ role: 'assistant', content: finalMessage.content });
    await this.sessionStore.save({
      sessionId,
      tenantId,
      customerId: request.customerId,
      messages: persistableTranscript(conversation),
      journeyState: nextState,
      state,
      lastIntent: { intent: intent.intent, stage: intent.stage, mode: intent.mode },
    });

    return {
      message: finalMessage,
      sessionId,
      intent,
      trace,
      conversation: conversation.filter((m) => m.role !== 'system'),
      uiActions,
    };
  }

  /**
   * Streaming variant of processChat. Runs the SAME controlled pipeline, but:
   *   - emits `trace` events as pipeline steps complete,
   *   - resolves tool rounds (search + UI actions) non-streamed, emitting
   *     `uiAction` events as they occur,
   *   - streams the FINAL spoken answer token-by-token via `token` events,
   *   - emits a final `done` event with the same shape as the buffered response.
   *
   * The buffered processChat() above is left untouched so the storefront always
   * has a working fallback if streaming fails.
   */
  async processChatStream(
    request: ChatRequest,
    emit: (event: string, data: any) => void,
  ): Promise<void> {
    const { tenantId = DEFAULT_TENANT_ID } = request;
    // CDL: a design image attached this turn is held server-side (never in the
    // prompt) and read by analyzeDesign. A note in the conversation tells the
    // model to call that tool.
    const turnImage = { imageBase64: request.imageBase64, imageUrl: request.imageUrl };
    const hasDesignImage = !!(turnImage.imageBase64 || turnImage.imageUrl);
    const trace: TraceEntry[] = [];
    const pushTrace = (t: TraceEntry) => { trace.push(t); emit('trace', t); };

    // Server-owned memory — reconstruct transcript + journey state (client sends
    // only { sessionId, message }).
    const sessionId = request.sessionId || randomUUID();
    const stored = await this.sessionStore.load(sessionId, tenantId);
    const { messages, journeyState } = this.hydrate(request, stored);
    const state = stored?.state ?? request.state;
    const turnIndex = (stored?.turnCount || 0) + 1; // used to key per-tool-call trace entries (steps[])
    pushTrace({ step: 'session', detail: stored ? `resumed ${sessionId.slice(0, 8)} (turn ${(stored.turnCount || 0) + 1}, ${messages.length} msg, ledger v${journeyState.version})` : `new ${sessionId.slice(0, 8)}` });
    emit('session', { sessionId });

    // Published project config (model + persona + journey guidance)
    const projectConfig = await this.configLoader.loadProjectConfig(tenantId);
    const model = projectConfig.model || this.model;
    const llm = getChatClient({ provider: projectConfig.provider, apiKey: projectConfig.apiKey, baseUrl: projectConfig.baseUrl }); // per-project provider + key
    console.log(`[JourneyAX:Stream] 🚀 Invoking LLM for tenant="${tenantId}" | provider="${projectConfig.provider || 'openai'}" | model="${model}" | url="${projectConfig.baseUrl || 'https://api.openai.com/v1'}"`);
    const configBlock = this.configLoader.renderConfigBlock(projectConfig);
    // High-level orientation so the agent starts knowing who this business is
    // (AUG-14). Cached; never blocks the turn.
    const brandHubProfile = await this.configLoader.loadBrandHub(tenantId);
    const brandHubBlock = this.configLoader.renderBrandHubBlock(brandHubProfile, projectConfig.capabilities, projectConfig);
    // Prefer the published Back Office Business Profile. Brand Hub remains a
    // compatibility fallback for tenants that predate that profile.
    const configuredEntityModel = projectConfig.business?.entityModel || brandHubProfile?.entityModel;
    const { supportsCustomisation, configuratorAvailable } = resolveCustomisationAvailability(projectConfig, brandHubProfile);
    pushTrace({ step: 'config', detail: `model=${model} · configV=${projectConfig.configVersion ?? 'draft'}${projectConfig.journeyGuidance ? ' · +journeyGuidance' : ''}` });

    // Intent (config-driven) — bounded by the project's configured context dimensions
    // ai.intentModel: 'project' → classify on this project's own model and
    // provider (a self-hosted tenant spends nothing on OpenAI); a model name →
    // that model on the platform key; unset → the platform classifier.
    const onProject = projectConfig.intentModel === 'project';
    const intent = await this.intentResolver.resolve(messages, state, onProject ? model : (projectConfig.intentModel || this.intentModel), projectConfig.contextDimensions, onProject ? llm : undefined, projectConfig.agentConfig);
    const knownDims = deriveDimensions(projectConfig.contextDimensions, inferDimensionsFromText(projectConfig.contextDimensions, messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content || '')).join(' \n '), { ...(journeyState.dimensions || {}), ...(intent.dimensions || {}) }));
    intent.dimensions = { ...(intent.dimensions || {}), ...knownDims };
    const dimStr = Object.entries(intent.dimensions || {}).map(([k, v]) => `${k}=${v}`).join(',') || '—';
    pushTrace({ step: 'intent', detail: `${intent.intent} · dims=${dimStr} · space=${intent.space} · stage=${intent.stage} · mode=${intent.mode}`, data: intent });

    // ── Consultative Clarification Gate (Early Discovery Interception - Streaming) ──
    const lastUserText = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
    // Storage sizing is arithmetic over the config guide, run here before the model speaks.
    const storageFacts = isStorageAsk(lastUserText) ? computeStorageFacts(projectConfig, lastUserText) : null;
    const retrievalCtx = deriveRetrievalContext(messages);
    // The built-in trade diagnostic question bank (wet areas, leaks, linings —
    // NZ building-supply vocabulary) is a per-tenant capability, never a
    // platform default: it surfaced "GIB Aqualine plasterboard" options on a
    // card-sleeve store because the model's prose mentioned "moisture".
    const allowDomainClarify = (projectConfig.capabilities || []).includes('domainClarify');
    // Sample-customer demo: the identity block for the profile the storefront bound to this request.
    const demoBlock = (projectConfig.capabilities || []).includes('customerHistory') ? await demoCustomerContext(projectConfig, request.demoPrincipalId, lastUserText, tenantId) : null;
    const isOpenModel =
      projectConfig.provider === 'placemaker' ||
      projectConfig.provider === 'jax' ||
      projectConfig.provider === 'jax-placemakers' ||
      (projectConfig.baseUrl || '').includes('8085') ||
      (projectConfig.baseUrl || '').includes('jax-placemakers');

    // Config rules
    const activeRulesResult = await this.configLoader.loadActiveRules(tenantId);
    const activeRules = activeRulesResult.rules;
    if (activeRulesResult.ok && projectConfig.agentConfig) {
      projectConfig.agentConfig.rules.business = activeRules.map((rule) => ({
        name: rule.name,
        scope: rule.scope,
        condition: rule.condition,
        action: rule.action,
      }));
    }
    const skillIds = configuredSkillIds(projectConfig.agentConfig);
    const skillsBlock = skillIndexBlock(tenantId, skillIds, configuredSkills(projectConfig.agentConfig));
    pushTrace({ step: 'config-rules', detail: activeRules.length ? `${activeRules.length} active rule(s) loaded` : 'no rules configured' });

    // Retrieval policy + enforcement
    const policy = buildRetrievalPolicy(intent, projectConfig.agentConfig);
    pushTrace({ step: 'retrieval-policy', detail: policy.allowRetrieval ? `allow [${policy.allowedTypes.join(', ')}]` : 'no retrieval (discovery — ask first)' });
    // The turn's likely search starts NOW, while the model is still thinking —
    // when it asks questions, the cards beside them cost no extra wait.
    const searchMemo = new TurnSearchMemo(tenantId);
    if (policy.allowRetrieval && (projectConfig.capabilities || []).includes('products') && intent.intent !== 'general_question' && intent.retrievalType !== 'faq' && !isDetailAsk(lastUserText) && !/^(Add |Remove SKU|Change the quantity|Payment received)/i.test(lastUserText)) {
      searchMemo.prefetch(effectiveSearchQuery('', retrievalCtx));
    }
    const projectTools = buildToolset({
      enabledCapabilities: projectConfig.capabilities,
      entityModel: configuredEntityModel,
      closing: projectConfig.commerceMode === 'cart' ? 'bag' : 'quote',
    });
    const policyTools = policy.allowRetrieval
      ? projectTools
      : projectTools.filter((t) => t.type !== 'function' || t.function.name !== 'searchKnowledge');
    const activeTools = configuratorAvailable ? policyTools : withoutConfiguratorTool(policyTools);

    // Prompt assembly (mirrors processChat) — journey working-memory block.
    const stateContext = renderJourneyStateBlock(journeyState);

    const needsDiagnosticClarification =
      intent.retrievalType === 'troubleshooting' || intent.stage === 'installation';

    const diagnosticGuidance = needsDiagnosticClarification
      ? '\n- DIAGNOSIS FIRST: This is a support or installation issue. Use the configured context dimensions and active business rules to ask only the diagnostic questions needed before recommending a product or next step. Do not output a questionnaire in chat text.'
      : '';

    const intentGuidance =
      `[TURN GUIDANCE]\n- Detected intent: ${intent.intent} (stage: ${intent.stage}, mode: ${intent.mode})\n` +
      `- Missing context: ${intent.missingInfo.length ? intent.missingInfo.join(', ') : '(none)'}\n` +
      `- ${policy.guidance}${diagnosticGuidance}`;

    const conversation: any[] = isOpenModel
      ? [
          {
            role: 'system',
            content: this.buildOpenModelTradePrompt(projectConfig),
          },
          ...messages,
        ]
      : [
          { role: 'system', content: assembleSystemPrompt(intent.mode, intent.stage, projectConfig.agentConfig) },
          ...(brandHubBlock ? [{ role: 'system', content: brandHubBlock }] : []),
          ...(configBlock ? [{ role: 'system', content: configBlock }] : []),
          // v3 Card CMS skills (docs/v3-card-cms-architecture.md): name + one-line
          // "not needed when" description only — the full technique loads on
          // demand via the loadSkill tool, so a rarely-needed skill never
          // occupies every turn's context.
          ...(skillsBlock ? [{ role: 'system', content: skillsBlock }] : []),
          ...(stateContext ? [{ role: 'system', content: stateContext }] : []),
          { role: 'system', content: intentGuidance },
          ...configuredCustomisationGuidance(projectConfig, { activeSku: journeyState?.activeSku, hasDesignImage, enabled: configuratorAvailable }),
          ...(demoBlock ? [{ role: 'system', content: demoBlock }] : []),
          // The chips exist for shopping turns only — a complaint, a policy or how-to question, or an unknown ask never carries them.
          ...((() => { if (!/product_recommendation|design_inspiration|quote_order|remodel/.test(String(intent?.intent || ''))) return []; const m = missingAskableDimensions(projectConfig.contextDimensions, knownDims); return m.length ? [{ role: 'system', content: askBesideBlock(m) }] : []; })()),
          ...((isGiftAsk(lastUserText) || isGiftAsk(retrievalCtx?.brief || '')) && (projectConfig.capabilities || []).includes('products') ? [{ role: 'system', content:
            '[GIFT ASK] The customer is buying for someone else and usually cannot name a product. This is the one journey where the questions come FIRST: in a single round, ask the still-unanswered configured questions (game, how into it, budget) with setPhase clarify — no cards yet. Once they have answered, present ONE gift-safe bundle for their budget with presentBundle (real SKUs from retrieval; never a custom / final-sale item; seasonal only when the occasion matches), explain the size choice so the giver can repeat it, and offer checkout. No upsell pressure on a gift.' }] : []),
          ...(isSetAsk(lastUserText) ? [{ role: 'system', content:
            '[SET ASK] The customer wants a coordinated SET (a series, a kit, "the whole …", pieces that match). Retrieve the real members, then present them with presentBundle (heading, why, the SKUs with quantities) — one card, one total, one "Add all" — not as a plain showItems list. Members come from retrieval / the catalogue\'s collections only; never pad a set with a guess.' }] : []),
          ...(storageFacts ? [{ role: 'system', content: storageFactsBlock(storageFacts) }]
            : isStorageAsk(lastUserText) ? [{ role: 'system', content:
            '[STORAGE ASK] The customer is sizing storage for a number of cards or decks. Call recommendStorage(cards, sleeving) FIRST — it returns the families that fit with exact capacities from this business\'s own guide — then searchKnowledge/showItems those families and quote the capacity number you used. Do not narrate capacities from memory.' }] : []),
          ...(isDetailAsk(lastUserText) ? [{ role: 'system', content:
            '[DETAIL ASK] The customer is asking about ONE item they are already looking at (its detail card is on screen). Answer from that item\'s own catalogue facts — searchKnowledge for its exact name or code if you need them — in 2–4 sentences: what it is, what it is for, what to check before buying. Do NOT call showItems with a new list, and do not present alternatives unless they ask.' }] : []),
          ...(isComparisonAsk(lastUserText) ? [{ role: 'system', content:
            '[COMPARISON ASK] The customer is asking how two (or more) named products, ranges or variants differ. Answer it as a comparison, not prose: ' +
            'searchKnowledge for EACH named item, showItems the real matches, then call presentComparison with those SKUs on the dimensions they care about — all in THIS turn. ' +
            'Keep your text to the one-line verdict; the table carries the facts.' }] : []),
          ...((projectConfig.capabilities || []).includes('products') ? [{ role: 'system', content:
            '[CARDS CARRY THE ITEMS] If you call showItems this turn, the customer sees every item as a card (name, image, price, and your per-item `description` as the reason) directly under your text. ' +
            'Your text must NOT list the items — no "1. Name: …" / "2. Name: …", no bullets, no naming each one in turn. Write 2-3 sentences at most: your lead pick and why, how they fit what was asked — then one next-step question.' }] : []),
          ...messages,
        ];

    // ── Tool rounds (non-streamed) — resolve searches + UI actions ──
    const maxLoops = 6;
    // Keep the streamed path on the same effective Backoffice retrieval policy.
    const MAX_SEARCHES = Math.max(1, projectConfig.agentConfig?.retrieval?.maxSearchCallsPerTurn ?? 3);
    let loops = 0;
    let searchCount = 0;
    let hadRetrieval = false;
    let readyToSpeak = false;
    let cartCommandApplied = false;   // storefront Add/Remove tap already executed server-side
    let forcedUi = false;               // panel-render enforcement fired already?
    let forcedSearch = false;           // post-clarify "don't defer, search now" nudge fired already? (ANF-10)
    let mustClarifyGender = false;      // gender gate fired → guarantee a clarify panel (post-turn)
    let cdlUseSku: string | null = null;  // CDL: analyzeDesign matched a real template → force the configurator
    let cdlSuggested: any = null;         // CDL: server-built configurator config (colours+text mapped to the palette)
    const uiToolCalls: any[] = [];
    const wantUiTool = this.requiredUiTool(intent, { configuratorAvailable, activeSku: journeyState?.activeSku });

    // Mandatory opening move (streaming): research the named org before the model acts.
    // Same guard as the buffered path — a same-turn clarify would bury the card.
    this.noteTeamSize(conversation, journeyState);
    this.noteShownItems(conversation, journeyState);
    await this.noteNamedStyle(tenantId, conversation, journeyState, configuratorAvailable);
    const researchedThisTurn = await this.maybeResearchOrg(tenantId, projectConfig, intent, journeyState, conversation, uiToolCalls, emit);
    await maybeForceSizeRecommendation(tenantId, conversation, activeTools, projectConfig.capabilities, uiToolCalls, emit, model, llm);
    // A storefront cart tap is executed here, not interpreted by the model;
    // when it was one, skip the tool rounds — the model only confirms.
    cartCommandApplied = await applyStorefrontCartCommand({ tenantId, sessionId, text: lastUserText, journeyState, projectConfig, uiToolCalls, conversation, emit, quoteService: this.quoteService, fetchPricebookRows, lookupSkuFacts, productMatches, pickNamedProduct });
    if (cartCommandApplied) readyToSpeak = true;
    await applyOrderPlacedContext({ tenantId, text: lastUserText, conversation, journeyState, orderService: this.orderService, quoteService: this.quoteService });

    // Open model retrieval accelerator (Gemma 2 / MLX Metal):
    if (isOpenModel) {
      readyToSpeak = true;
    }

    while (loops < maxLoops && !readyToSpeak) {
      loops++;
      const response = await llm.chat.completions.create({
        model,
        messages: conversation,
        tools: activeTools,
        // Model decides freely (clarify / search / answer) — guided by config +
        // journeyGuidance, not by hardcoded keyword/turn heuristics.
        tool_choice: 'auto',
        ...genParams(model, projectConfig.temperature),
      });
      const msg = response.choices[0].message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Model finished searching and wants to speak. If it retrieved data but
        // never rendered the panel (product cards / guide checklist), FORCE the
        // required UI tool once — otherwise the right 60% panel stays empty.
        //
        // showConfigurator is exempt from the retrieval gate, exactly as in the
        // non-streaming path: a design turn needs no lookup, because what to
        // render is what the customer just described. Requiring retrieval here
        // is why "show me 329X3M in serpentine, red and royal, North View 25" —
        // a request carrying every argument the tool needs — produced a
        // clarifying form and an empty panel instead of a garment. This path is
        // the one the storefront uses; the fix had only ever been applied to the
        // other one.
        // CDL: a matched template ('use') forces the configurator even though the
        // intent-derived want isn't showConfigurator (an uploaded design isn't a
        // catalogue search).
        const effWantUi = cdlUseSku && configuratorAvailable ? 'showConfigurator' : wantUiTool;
        pushTrace({ step: 'forced-ui?', detail: `cdlUseSku=${cdlUseSku ?? '—'} effWantUi=${effWantUi ?? '—'} forcedUi=${forcedUi} blocked=${intent.panelRenderBlocked} already=${uiToolCalls.some((c) => c.function?.name === effWantUi)}` });
        if (!researchedThisTurn && (hadRetrieval || effWantUi === 'showConfigurator') && effWantUi && !forcedUi &&
            !intent.panelRenderBlocked &&
            !uiToolCalls.some((c) => c.function?.name === effWantUi)) {
          forcedUi = true;
          pushTrace({ step: 'forced-ui', detail: `${effWantUi}${cdlUseSku ? ` (CDL ${cdlUseSku})` : ''}` });
          await this.forceUiTool(tenantId, conversation, activeTools, effWantUi, uiToolCalls, emit, model, llm, journeyState, supportsCustomisation, projectConfig.configuratorType);
        }
        // ANF-10: the model DEFERRED — it returned prose only ("let me find some
        // options… give me a moment!") with NO search this turn, while a product
        // panel is expected and still empty. Ending the turn here leaves the 60%
        // panel stuck on the "Searching catalog" spinner until the customer sends
        // another message. Instead re-loop ONCE with a hard instruction to search
        // + show THIS turn. Same "act, don't defer" contract as the show-first
        // guard (AUG-38 / AUG-80). Only fires when a product list is what's owed
        // (wantUiTool === 'showItems') and nothing has been retrieved or shown.
        // Does NOT fire when the customer explicitly opted out of a render this turn.
        if (!researchedThisTurn && !hadRetrieval && !forcedSearch
            && wantUiTool === 'showItems'
            && !intent.panelRenderBlocked
            && !uiToolCalls.length
            && !((journeyState?.lastShown || []).length)) {
          forcedSearch = true;
          conversation.push({ role: 'system', content:
            'The customer is waiting and the conversation is EMPTY. Do NOT defer, do NOT reply with "give me a moment" or "let me look" — this turn you MUST call searchKnowledge for their brief and then showItems with the real results. Act now, in this same turn.' });
          continue;   // re-loop; do not speak yet
        }
        readyToSpeak = true;
        break;
      }
      conversation.push(msg);

      let didSearch = false;
      const fnCalls = msg.tool_calls.filter((c) => c.type === 'function');
      const searchCalls = fnCalls.filter((c) => c.function.name === 'searchKnowledge');
      // These return DATA, so they must be excluded from the UI bucket —
      // otherCalls results never re-enter the conversation.
      const DATA_TOOLS = new Set([...DEMO_CUSTOMER_TOOLS, 'recommendStorage', 'findRelated', 'getProductOptions', 'findEntity', 'registerEntity', 'requestArtwork', 'checkArtworkApproval', 'analyzeDesign', 'generateDesign', 'generateTeamDesign', 'submitTeamOrder', 'submitForReview', 'checkReviewStatus', 'recommendSize', 'uploadPhotosFor3D', 'buildProjectPlan', 'checkBranchStock']);
      const dataCalls = fnCalls.filter((c) => DATA_TOOLS.has(c.function.name));
      const otherCalls = fnCalls.filter((c) => c.function.name !== 'searchKnowledge' && !DATA_TOOLS.has(c.function.name));

      if (dataCalls.length) {
        hadRetrieval = true;
        const results = await Promise.all(
          dataCalls.map(async (call) => ({
            id: call.id,
            name: call.function.name,
            value: DEMO_CUSTOMER_TOOLS.has(call.function.name)
              ? await runDemoCustomerTool(projectConfig, request.demoPrincipalId, call.function.name, call.function.arguments, tenantId)
              : call.function.name === 'recommendStorage'
              ? recommendStorage(projectConfig, call.function.arguments)
              : call.function.name === 'findRelated'
              ? await lookupRelated(tenantId, call.function.arguments)
              : call.function.name === 'analyzeDesign'
                ? await analyzeDesign(tenantId, turnImage, call.function.arguments)
              : call.function.name === 'generateDesign'
                ? await generateDesign(tenantId, call.function.arguments)
              : call.function.name === 'generateTeamDesign'
                ? await generateTeamDesign(tenantId, turnImage, call.function.arguments)
              : call.function.name === 'uploadPhotosFor3D'
                ? await uploadPhotosFor3D(call.function.arguments)
              : call.function.name === 'submitTeamOrder'
                ? await submitTeamOrder(tenantId, sessionId, journeyState, call.function.arguments)
              : call.function.name === 'submitForReview'
                ? await submitForReview(tenantId, sessionId, call.function.arguments)
              : call.function.name === 'checkReviewStatus'
                ? await checkReviewStatus(tenantId, sessionId)
              : call.function.name === 'recommendSize'
                ? await recommendSize(tenantId, call.function.arguments)
              : call.function.name === 'findEntity'
                ? await lookupEntities(tenantId, call.function.arguments)
                : call.function.name === 'registerEntity'
                  ? await saveEntity(tenantId, call.function.arguments)
                  : call.function.name === 'requestArtwork'
                    ? await requestArtwork(tenantId, sessionId, call.function.arguments)
                    : call.function.name === 'checkArtworkApproval'
                      ? await checkArtworkApproval(tenantId, sessionId)
                      : call.function.name === 'buildProjectPlan'
                        ? handleBuildProjectPlan(call.function.arguments)
                        : call.function.name === 'checkBranchStock'
                          ? handleCheckBranchStock(call.function.arguments)
                          : await lookupOptions(tenantId, call.function.arguments),
          })),
        );
        for (const r of results) {
          // CDL: matched template ('use') → force the configurator downstream.
          if ((r.name === 'analyzeDesign' || r.name === 'generateDesign')
              && (r.value as any)?.decision === 'use' && (r.value as any)?.template?.sku) {
            cdlUseSku = String((r.value as any).template.sku);
            if ((r.value as any).suggestedConfig?.sku) cdlSuggested = (r.value as any).suggestedConfig;
          }
          // Door A: a generated concept image → show it in the panel (fetched by
          // id). Emitted live over SSE only; it is not a journey-state action, so
          // it does not go through the reducer/UI enforcement.
          if (r.name === 'generateDesign' && (r.value as any)?.conceptId) {
            emit('uiAction', { name: 'showConcept', arguments: { conceptId: (r.value as any).conceptId } });
          }
          // Door B: the FAITHFUL proof (their artwork on our garment) — the hero
          // image for artwork-heavy uploads that colour zones can't reproduce.
          if (r.name === 'analyzeDesign' && (r.value as any)?.proofId) {
            emit('uiAction', { name: 'showProof', arguments: { proofId: (r.value as any).proofId } });
          }
          // Coach team-order journey: a successful generateTeamDesign lands the
          // coach on the teamDesign panel with the four views — same "emit +
          // uiToolCalls" double-write the cdlUseSku → showConfigurator push uses
          // just below, but under its OWN tool name (no template/decision here).
          if (r.name === 'generateTeamDesign' && (r.value as any)?.ok) {
            emit('uiAction', { name: 'generateTeamDesign', arguments: r.value });
            if (!uiToolCalls.some((c) => c.function?.name === 'generateTeamDesign')) {
              uiToolCalls.push({ id: r.id, type: 'function', function: { name: 'generateTeamDesign', arguments: JSON.stringify(r.value) } } as any);
            }
          }
          // Real-photo 3D match: a successful uploadPhotosFor3D opens the
          // photo-upload panel — same double-write as generateTeamDesign above.
          if (r.name === 'uploadPhotosFor3D' && (r.value as any)?.ok) {
            emit('uiAction', { name: 'uploadPhotosFor3D', arguments: r.value });
            if (!uiToolCalls.some((c) => c.function?.name === 'uploadPhotosFor3D')) {
              uiToolCalls.push({ id: r.id, type: 'function', function: { name: 'uploadPhotosFor3D', arguments: JSON.stringify(r.value) } } as any);
            }
          }
          // Fitment guide: emit the recommendation (or the honest "no chart
          // yet" result) as its own small card — same double-write as
          // generateTeamDesign just above, under recommendSize's own name.
          if (r.name === 'recommendSize') {
            emit('uiAction', { name: 'recommendSize', arguments: r.value });
            if (!uiToolCalls.some((c) => c.function?.name === 'recommendSize')) {
              uiToolCalls.push({ id: r.id, type: 'function', function: { name: 'recommendSize', arguments: JSON.stringify(r.value) } } as any);
            }
          }
          // PlaceMakers project/materials plan and branch stock: these used to
          // fall through to the generic otherCalls path below, which only ever
          // ran validateDesign() (a no-op stub for anything but showConfigurator)
          // and emitted the customer's raw request args as if they were the
          // answer — so the panel got no bill-of-materials/stock data at all,
          // while the model still narrated "I've generated your plan" because a
          // bare `{success:true}` is all it was ever told. Same double-write as
          // generateTeamDesign/recommendSize above, now with the REAL computed
          // result (materials list, totals; branch stock counts).
          if ((r.name === 'buildProjectPlan' || r.name === 'checkBranchStock') && (r.value as any)?.ok) {
            emit('uiAction', { name: r.name, arguments: r.value });
            if (!uiToolCalls.some((c) => c.function?.name === r.name)) {
              uiToolCalls.push({ id: r.id, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.value) } } as any);
            }
          }
          conversation.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.value) });
          {
            const origCall = dataCalls.find((c) => c.id === r.id);
            const _s = summarizeToolCall(r.name, safeParseArgs(origCall?.function.arguments), r.value);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: r.name, ..._s, ts: new Date().toISOString() });
          }
        }
        // A CDL data tool sets didSearch=false, so the loop would set readyToSpeak
        // and exit before the model ever renders the match. Render it here, now,
        // deterministically — the matched style is producible by definition.
        if (cdlUseSku && configuratorAvailable && !forcedUi && !intent.panelRenderBlocked &&
            !uiToolCalls.some((c) => c.function?.name === 'showConfigurator')) {
          forcedUi = true;
          if (cdlSuggested?.sku) {
            // Colour fix: the SERVER decides the configurator config (all analysed
            // colours mapped to the style's palette + any read-off name/number),
            // instead of the model — which was dropping colours and rendering a
            // single accent. The render service picks the design line when none is
            // named and cycles the colours across every zone.
            pushTrace({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku}, server config)` });
            uiToolCalls.push({ id: `cdl_${cdlUseSku}`, type: 'function', function: { name: 'showConfigurator', arguments: JSON.stringify(cdlSuggested) } } as any);
            emit('uiAction', { name: 'showConfigurator', arguments: cdlSuggested });
            // Tell the model it's already rendered (a plain system note — NOT a tool
            // result, which would be an orphaned tool_call and 400 the next turn) so
            // it speaks instead of re-emitting showConfigurator with worse colours.
            conversation.push({ role: 'system', content: `[RENDERED] The customer's design is already shown in the conversation in their colours (${(cdlSuggested.colours || []).join(', ') || 'their palette'}) on style ${cdlUseSku}. Do NOT call showConfigurator again this turn. Tell them their design is shown, invite tweaks to colours/name/number, or offer to send it to the artist for review.` });
          } else {
            pushTrace({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku})` });
            await this.forceUiTool(tenantId, conversation, activeTools, 'showConfigurator', uiToolCalls, emit, model, llm, journeyState, supportsCustomisation, projectConfig.configuratorType);
          }
        }
      }

      // Searches run in PARALLEL (the big latency win for multi-fixture builds:
      // toilet + basin + shower no longer wait on each other). Respect the per-turn
      // cap and preserve tool_call_id ↔ result pairing.
      if (searchCalls.length) {
        didSearch = true;
        hadRetrieval = true;
        const room = Math.max(0, MAX_SEARCHES - searchCount);
        const run = searchCalls.slice(0, room);
        const capped = searchCalls.slice(run.length);
        searchCount += run.length;
        const results = await Promise.all(
          run.map(async (call) => {
            try {
              const args = JSON.parse(call.function.arguments);
              const r = await searchMemo.search({ query: `${args.query || ''} ${dimensionQuerySuffix(projectConfig.contextDimensions, knownDims)}`.trim(), type: args.type, category: args.category, limit: 8, gender: intent?.dimensions?.gender });
              // Same annotation as the non-streaming path — this is the one the
              // storefront actually uses, so an omission here is invisible in
              // tests and total in production (the AUG-38 failure, repeated).
              const marked = await markDesignable(tenantId, r);
              // Fencing — see the buffered path's identical comment.
              return { id: call.id, content: JSON.stringify(fenceSearchResultText(marked)), args, result: marked };
            } catch {
              return { id: call.id, content: JSON.stringify({ found: false, message: 'Knowledge search failed.' }), args: safeParseArgs(call.function.arguments), result: { found: false } };
            }
          }),
        );
        for (const r of results) {
          conversation.push({ role: 'tool', tool_call_id: r.id, content: r.content });
          const _s = summarizeToolCall('searchKnowledge', (r as any).args, (r as any).result);
          void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'searchKnowledge', ..._s, ts: new Date().toISOString() });
        }
        for (const call of capped) conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ found: false, message: 'Search limit reached for this turn.' }) });
      }

      // UI tool calls — sequential (fast) with the clarify integrity enforcement.
      for (const call of otherCalls) {
        if (call.function.name === 'loadSkill') {
          // v3 Card CMS skills — see the buffered path's identical branch for
          // why the body is fetched here rather than always sitting in the
          // prompt. Not a SKU-bearing tool, so it skips enforceNamedSku.
          let skillArgs: any = {};
          try { skillArgs = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
          const body = loadSkillBody(tenantId, String(skillArgs?.name || ''), skillIds);
          conversation.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify(body ? { found: true, name: skillArgs.name, body } : { found: false, message: `No skill named '${skillArgs?.name}'.` }),
          });
          continue;
        }
        await enforceNamedSku(tenantId, conversation, call);     // identity wins over the model
        const parsedArgs = (() => { try { return JSON.parse(call.function.arguments); } catch { return {}; } })();
        if (!UI_TOOL_NAMES.has(call.function.name)) {
          // Unknown tool → still ack so OpenAI doesn't 400 on the next call.
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, error: 'unknown tool' }) });
          continue;
        }
        // GENDER GATE (streaming parity): never show products until Men/Women/Kids is known.
        if (call.function.name === 'showItems' && this.needsGenderFirst(intent, projectConfig, messages)) {
          mustClarifyGender = true;
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, clarifyFirst: true,
            message: 'STOP — you do not know whether the shopper wants Men, Women or Kids, and these are different products. Do NOT show products yet. Call setPhase("clarify") NOW with a gender question (id "gender", title "Who are we shopping for?", options ["Men","Women","Kids"]) plus occasion and their usual size if still unknown.' }) });
          didSearch = true;
          continue;
        }
        // Just researched a school this turn → the colour-confirmation card owns the
        // panel. Suppress a same-turn clarify so it isn't buried under a form.
        if (researchedThisTurn && call.function.name === 'setPhase' && parsedArgs.phase === 'clarify') {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, deferred: true,
            message: 'The colour-confirmation card is already on the panel. Do NOT clarify this turn — acknowledge the mascot and colours in one sentence and invite the customer to confirm. You will clarify or present concepts AFTER they confirm.' }) });
          continue;
        }
        // Same rule on the streaming path — the AUG-38 parity trap.
        if (call.function.name === 'setPhase' && parsedArgs.phase === 'clarify'
            && this.askedToSeeSomething(intent, journeyState, projectConfig?.commerceMode)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, showFirst: true,
            message: 'The customer asked to SEE a product and the panel is empty. searchKnowledge for what they named and call showItems THIS TURN. Then ask what is still missing — team, sizes, quantity — in one short sentence beside the items. Never open with a questionnaire.' }) });
          didSearch = true;
          continue;
        }
        // ENFORCE: a clarify phase is useless without questions — reject and loop.
        if (call.function.name === 'setPhase' && parsedArgs.phase === 'clarify' &&
            (!Array.isArray(parsedArgs.questions) || parsedArgs.questions.length === 0)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, error: 'setPhase("clarify") REQUIRES a non-empty "questions" array of 3-5 items, each with { id, title, options[2-5] }. Re-call setPhase now with the questions populated.' }) });
          didSearch = true; // not ready to speak — loop again so the model corrects it
          continue;
        }
        // Live school research (AUG-48) — same as the non-streaming path, plus a
        // streamed uiAction so the panel shows the research card immediately.
        if (call.function.name === 'researchSchool') {
          const research = await this.runSchoolResearch(tenantId, projectConfig, call.function.arguments);
          (call as any).__research = research;
          uiToolCalls.push(call);
          emit('uiAction', { name: 'researchSchool', arguments: research });
          const cols = (research.colours || []).map((c: any) => `${c.name}${c.mappedTo ? ` → our ${c.mappedTo.name}` : ''}`).join(', ');
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
            success: !research.error, ...(research.error ? { error: research.error } : {}),
            team: research.team, mascot: research.mascot, colours: cols, confidence: research.confidence,
            note: 'Shown to the customer for confirmation. Once confirmed, use the mapped palette colour names for searchKnowledge and rendering — never invent colours or recreate the logo.',
          }) });
          {
            const _s = summarizeToolCall('researchSchool', safeParseArgs(call.function.arguments), research);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'researchSchool', ..._s, ts: new Date().toISOString() });
          }
          continue;
        }
                // P0-04: updateQuote is SERVER-AUTHORITATIVE (not loop-guarded). Rehydrate
        // real prices + compute totals; emit the SERVER quote, not the model's args.
        if (call.function.name === 'updateQuote') {
          const qSize = Number(journeyState.teamSize) || 0;
          const qItems = Array.isArray(parsedArgs.items) ? parsedArgs.items : [];

          // P0 GUARD: Refuse to build an empty quote or quote without valid items!
          if ((!qItems.length || qItems.every((it: any) => !String(it?.sku || '').trim())) && !(projectConfig.commerceMode === 'cart' && Array.isArray(parsedArgs.remove) && parsedArgs.remove.length)) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                success: false,
                emptyItems: true,
                message: 'You called updateQuote with NO products (0 items). You cannot create an empty quote or use updateQuote for an assessment summary or diagnostic report. A quote is strictly for ordering real products with SKUs. If you are diagnosing or troubleshooting a leak or repair, use showGuide to present step-by-step diagnostic/inspection instructions. If recommending replacement fixtures/mixers/parts, search the catalogue with searchKnowledge and call showItems. Do NOT call updateQuote without real products.'
              })
            });
            didSearch = true;
            continue;
          }

          if (projectConfig.commerceMode === 'cart') {
            // BAG TENANT: the model proposes, the bag path disposes — one
            // deterministic add / change / remove per line, so limits, sold-out
            // and the grounded "[BAG UPDATED]" note apply exactly as for a tap.
            // A quote-style full replace lost every line the model forgot.
            const bag = journeyState?.quoteId ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null) : null;
            const have = new Map<string, number>((bag?.lines || []).map((l: any) => [String(l.sku).toUpperCase(), Number(l.quantity) || 1]));
            const adds: string[] = []; const cmds: string[] = [];
            for (const it of qItems) {
              const k = String(it?.sku || '').trim().toUpperCase(); if (!k) continue;
              const want = Math.max(1, Math.floor(Number(it.quantity) || 1)); const cur = have.get(k);
              if (cur == null) adds.push(`${k} (qty ${want})`);
              else if (it.quantity != null && cur !== want) cmds.push(`Change the quantity of SKU ${k} to ${want}.`);
            }
            for (const r of (Array.isArray(parsedArgs.remove) ? parsedArgs.remove : [])) { const k = String(r || '').trim().toUpperCase(); if (k && have.has(k)) cmds.push(`Remove SKU ${k} from my bag.`); }
            if (adds.length) cmds.unshift(`Add SKUs ${adds.join(', ')} to my bag.`);
            // The tool result must directly follow the assistant's tool call — the bag
            // path's own system notes are collected and appended after it.
            let applied = false;
            const notes: any[] = [];
            for (const c of cmds) if (await applyStorefrontCartCommand({ tenantId, sessionId, text: c, journeyState, projectConfig, uiToolCalls, conversation: notes, emit, quoteService: this.quoteService, fetchPricebookRows, lookupSkuFacts, productMatches, pickNamedProduct })) applied = true;
            const bagNow = journeyState?.quoteId ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null) : null;
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(applied
              ? { success: true, applied: true, bagNow: (bagNow?.lines || []).map((l: any) => ({ sku: l.sku, name: l.name, quantity: l.quantity })), total: bagNow?.total, note: 'Applied by the server. bagNow is the complete bag after this change — confirm ONLY what changed this turn, by product name, in one sentence; never say something was removed if it is still in bagNow.' }
              : { success: false, note: 'Nothing changed: those items are already in the bag at that quantity, or no real SKU was given. Say what is in the bag; do not claim to have added anything.' }) });
            conversation.push(...notes);
            {
              const _s = summarizeToolCall('updateQuote', parsedArgs, { applied, commands: cmds });
              void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'updateQuote', ..._s, ts: new Date().toISOString() });
            }
            continue;
          }
          if (qSize > 1 && qItems.length && qItems.every((it: any) => (Number(it.quantity) || 1) <= 1)) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
              success: false, quantityMissing: true,
              message: `The customer needs ${qSize} pieces, but every line is quantity 1 — that quotes a team order as a single garment. Re-call updateQuote with quantity=${qSize} on each per-player garment.` }) });
            didSearch = true;
            continue;
          }
          const quote = await buildAuthoritativeQuote({ quoteService: this.quoteService, tenantId, sessionId, args: parsedArgs, pricing: projectConfig.pricing });

          // P0 GUARD: If no quoted items could be priced from the catalogue, do not emit an empty quote!
          if (!quote.lines || quote.lines.length === 0) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                success: false,
                emptyItems: true,
                message: 'None of the quoted items could be found in the catalogue (0 priced lines). An empty quote cannot be created. Please search the catalogue with searchKnowledge for real products/mixers/fixtures and call showItems, or call showGuide if this is a diagnostic/troubleshooting issue.'
              })
            });
            didSearch = true;
            continue;
          }

          journeyState.quoteId = quote.quoteId;
          (call as any).__quote = quote;
          uiToolCalls.push(call);
          emit('uiAction', { name: 'updateQuote', arguments: quote });
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
            success: true, quoteId: quote.quoteId, currency: quote.currency,
            subtotal: quote.subtotal, discount: quote.discount, tax: quote.tax, total: quote.total,
            lineCount: quote.lines.length, validation: quote.validation,
            note: 'Totals are authoritative (server-computed). Quote these exact figures; never state different numbers.',
          }) });
          {
            const _s = summarizeToolCall('updateQuote', parsedArgs, quote);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: 'updateQuote', ..._s, ts: new Date().toISOString() });
          }
          {
            const _lu = [...conversation].reverse().find((m: any) => m?.role === 'user');
            const _xsell = this.crossSellDirective(projectConfig?.commerceMode, String(_lu?.content || ''), quote, journeyState);
            if (_xsell) { conversation.push({ role: 'system', content: _xsell }); didSearch = true; }
          }
          continue;
        }
        // NEVER render an empty configurator (see buffered path). No real SKU and
        // nothing already on the garment → force retrieval so sports don't all
        // render the same blank/last mesh.
        if (call.function.name === 'showConfigurator' && !parsedArgs.sku && !journeyState.activeSku) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, needsRetrieval: true,
            message: 'You tried to open the designer without a real product. Do NOT render a garment you have not retrieved. First call searchKnowledge for the SPECIFIC garment the customer asked for (e.g. the sport + "jersey"), pick ONE designable style from the results, then call showConfigurator again with that exact sku. Different sports must resolve to different styles.' }) });
          didSearch = true;
          continue;
        }
        // LOOP GUARD (idempotency): suppress a presentation already made this journey.
        if (alreadyPresented(journeyState, call.function.name, parsedArgs)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
            success: false, alreadyDone: true,
            message: `You ALREADY presented this ${call.function.name} earlier in this conversation (it is in the conversation). Do NOT present it again. Move to the next unmet goal in the journey memory.`,
          }) });
          didSearch = true;
          continue;
        }
        // Validate before emitting so the panel gets the CORRECTED design, and
        // the model is told what could not be applied instead of a bare success.
        const verdict = await validateDesign(tenantId, call, projectConfig.configuratorType);
        // showItems may not present stock styles as customisable (AUG-25).
        const itemVerdict = await enforceItemDesignability(
            tenantId, call, supportsCustomisation);
        // A bundle the catalogue cannot back (fewer than two real, in-stock,
        // priced members) is withheld — the model hears why and searches.
        if (bundleRefused(call, itemVerdict)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemVerdict) });
          {
            const _s = summarizeToolCall(call.function.name, parsedArgs, itemVerdict);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
          didSearch = true;
          continue;
        }
        // Card facts come from the catalogue, never the model (AUG-82).
        const itemFacts = await groundItemFacts(tenantId, call);
        const hardDropped = applyDimensionHardFilter(call, projectConfig.contextDimensions, knownDims);
        // Everything dropped (sold out / not real / wrong variant) → no empty
        // card; the model is told why and searches again.
        const emptied = emptyShowItemsVerdict(call, itemFacts, hardDropped);
        if (emptied) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(emptied) });
          {
            const _s = summarizeToolCall(call.function.name, parsedArgs, emptied);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
          didSearch = true;
          continue;
        }
        this.applySizePreselect(call, this.resolveShopperSize(intent, messages));
        // Complete-the-look: drop same-category cards; if nothing complementary
        // survives, reject once and force a DIFFERENT-category search. Stops the
        // "keeps recommending the same jeans" loop (this is the live storefront path).
        if (call.function.name === 'showItems' && journeyState.crossSellFor && this.applyCrossSellFilter(call, journeyState)) {
          const canRetry = (journeyState.crossSellRetries || 0) < 1;
          journeyState.crossSellRetries = (journeyState.crossSellRetries || 0) + 1;
          if (!canRetry) journeyState.crossSellFor = null;
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(canRetry
            ? { success: false, sameCategoryOnly: true, message: 'Those are the SAME category as what is already in the bag — that does not complete the look. Do NOT show that category again. searchKnowledge for a COMPLEMENTARY, DIFFERENT category for the same gender (bottoms/jeans → a top: shirt/tee/sweater, or shoes; a top → bottoms or shoes; a dress → shoes/a jacket) and showItems those.' }
            : { success: true, note: 'No complementary items found — ask what they would like to add, or invite checkout. Do not re-show the same category.' }) });
          if (canRetry) didSearch = true;
          continue;
        }
        // validateDesign may have rewritten the arguments; re-read so the panel
        // receives the corrected design rather than the model's original.
        let emitArgs: any = parsedArgs;
        try { emitArgs = JSON.parse(call.function.arguments); } catch { /* keep parsed */ }

        /* A style that cannot be custom-designed must not reach the panel at all
         * (AUG-25). The model is told the truth and reliably says it — "this one
         * isn't available for custom design, here are two that are" — but the
         * panel would still open on the stock garment underneath that sentence,
         * so the customer reads one thing and looks at another. The verdict
         * already carries real alternatives; withholding the action lets the
         * model's question stand until they pick one. */
        if (verdict.designableAlternatives || (call.function.name === 'showConfigurator' && verdict.success === false)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(verdict) });
          {
            const _s = summarizeToolCall(call.function.name, parsedArgs, verdict);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
          continue;
        }

        uiToolCalls.push(call);
        emit('uiAction', { name: call.function.name, arguments: emitArgs });
        conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemFacts.soldOut.length ? { ...(itemVerdict || verdict), soldOut: itemFacts.soldOut, note: 'These were dropped as SOLD OUT and are not on screen — say so if the customer asked for one by name.' } : (itemVerdict || verdict)) });
        {
          const _s = summarizeToolCall(call.function.name, parsedArgs, itemVerdict || verdict);
          void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
        }
      }
      if (!didSearch) readyToSpeak = true; // UI-only round → speak next
    }

    if (!cartCommandApplied && (projectConfig.capabilities || []).includes('products')) {
      const shownStats = { searched: uiToolCalls.some((c: any) => ['showItems', 'presentBundle', 'presentComparison'].includes(c?.function?.name)) };
      if (await this.ensureRetrievalAfterAnswers(tenantId, retrievalCtx, shownStats, uiToolCalls, emit, pushTrace, { journeyState, intent, answersOnly: true }, searchMemo)) {
        conversation.push({ role: 'system', content: '[CARDS SHOWN] Cards matching their answers are now on screen under your text. Do not list them; give your pick and one next step.' });
      }
    }
    await this.ensureStorageCards(tenantId, storageFacts, uiToolCalls, conversation, emit);
    // ── Final answer — streamed token by token ──────────────────────
    // For a plain retail brand we can't stream raw tokens: a leaked "not
    // customisable" sentence would already be on screen before a post-strip runs.
    // So we buffer per-sentence and only emit sentences that pass the taboo filter.
    const plainRetail = projectConfig?.commerceMode === 'cart' && !projectConfig?.configuratorType;
    let finalText = '';
    let pending = '';   // holds an in-progress sentence (plainRetail only)
    let openModelBuffer = '';
    let openModelSuppressingToolCall = false;
    // A card is rendering the items this turn (showItems ran in a tool round
    // above) → hold the spoken answer instead of streaming it token by token,
    // compact away any line-by-line re-listing of those items, then emit it in
    // one go. The working strip covers the pause; the customer gets the
    // consultant's framing and the card, not the card twice.
    const shownNames = isOpenModel ? [] : shownItemNames(uiToolCalls);
    const holdForCard = shownNames.length >= 2;

    try {
      // No tools/tool_choice here → the model can only produce text (OpenAI rejects
      // tool_choice when tools are absent). This IS the final spoken answer.
      const stream = await llm.chat.completions.create({
        model,
        messages: conversation,
        stream: true,
        ...(isOpenModel ? { max_tokens: openModelMaxTokens(projectConfig) } : {}),
        ...genParams(model, projectConfig.temperature),
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (!delta) continue;
        finalText += delta;
        if (holdForCard) continue;   // emitted once, compacted, after the stream

        if (isOpenModel) {
          openModelBuffer += delta;
          const tcPrefix = 'TOOL_CALL:';

          if (!openModelSuppressingToolCall) {
            // A TOOL_CALL can arrive ANYWHERE in the answer, not only at its very
            // start — the model happily writes a paragraph of prose and then
            // emits one (seen live: a full clarify explanation followed by
            // `TOOL_CALL: setPhase(...)`, which the old start-of-buffer check let
            // stream straight into the chat as text). Hold everything from the
            // first occurrence; flush only the prose before it.
            const at = openModelBuffer.indexOf(tcPrefix);
            if (at >= 0) {
              const before = openModelBuffer.slice(0, at);
              if (before) emit('token', { delta: before });
              openModelBuffer = openModelBuffer.slice(at);
              openModelSuppressingToolCall = true;
            } else {
              // Flush all but a possible partial "TOOL_CALL:" prefix at the tail,
              // so a marker split across two deltas is still caught.
              let hold = 0;
              for (let n = Math.min(tcPrefix.length - 1, openModelBuffer.length); n > 0; n--) {
                if (tcPrefix.startsWith(openModelBuffer.slice(-n))) { hold = n; break; }
              }
              const flush = hold ? openModelBuffer.slice(0, -hold) : openModelBuffer;
              if (flush) emit('token', { delta: flush });
              openModelBuffer = hold ? openModelBuffer.slice(-hold) : '';
              continue;
            }
          }

          if (openModelSuppressingToolCall) {
            // Check if the TOOL_CALL has concluded (balanced parenthesis). The
            // remainder stays in the buffer — it may be prose, or another call —
            // and is re-evaluated on the next delta / at end of stream.
            const tool = findBalancedToolCall(openModelBuffer);
            if (tool) {
              openModelBuffer = openModelBuffer.slice(tool.endIndex).replace(/^\s*\n?/, '');
              openModelSuppressingToolCall = false;
            }
          }
          continue;
        }

        if (!plainRetail) { emit('token', { delta }); continue; }
        pending += delta;
        // Emit each COMPLETE sentence once it's terminated, stripping taboo ones.
        let m: RegExpMatchArray | null;
        while ((m = pending.match(/^([\s\S]*?[.!?]["')\]]?)(\s+)([\s\S]*)$/))) {
          const sentence = m[1]; const sep = m[2]; pending = m[3];
          const clean = this.stripCartTaboo(sentence, true);
          if (clean) emit('token', { delta: clean + sep });
        }
      }
    } catch (err) {
      emit('error', { message: `generation failed: ${(err as Error).message}` });
    }

    if (isOpenModel) {
      if (openModelBuffer) {
        let cleanRemainder = openModelBuffer;
        while (true) {
          const tool = findBalancedToolCall(cleanRemainder);
          if (!tool) break;
          cleanRemainder = cleanRemainder.replace(tool.fullMatch, '');
        }
        // An UNTERMINATED call — the model hit max_tokens mid-JSON — has no
        // balanced close to find. Drop from the marker on, rather than flush
        // half a JSON blob into the chat (seen live).
        const dangling = cleanRemainder.indexOf('TOOL_CALL:');
        if (dangling >= 0) cleanRemainder = cleanRemainder.slice(0, dangling);
        cleanRemainder = cleanRemainder.trim();
        if (cleanRemainder) {
          emit('token', { delta: cleanRemainder });
        }
        openModelBuffer = '';
      }

      console.log(`[JourneyAX:ModelResponse] 💬 Streamed model output for tenant="${tenantId}" [model=${model}]:\n${finalText}`);
      const searchStats = { searched: false };
      let toolExecuted = await this.executeOpenModelToolCalls(tenantId, finalText, intent, uiToolCalls, emit, pushTrace, retrievalCtx, searchStats, allowDomainClarify, searchMemo);
      if (!cartCommandApplied && await this.ensureRetrievalAfterAnswers(tenantId, retrievalCtx, searchStats, uiToolCalls, emit, pushTrace, { journeyState, intent }, searchMemo)) toolExecuted = true;
      if (!toolExecuted) {
        const modelClarifyAction = this.extractQuestionsFromModelResponse(finalText, lastUserText, intent, allowDomainClarify);
        if (modelClarifyAction) {
          console.log(`[JourneyAX:ModelClarify] 💡 Extracted diagnostic questions directly from model response:`, modelClarifyAction.arguments.questions.map((q: any) => q.title));
          uiToolCalls.push({
            id: `model_text_clarify_${Date.now()}`,
            type: 'function',
            function: { name: 'setPhase', arguments: JSON.stringify(modelClarifyAction.arguments) },
          });
          if (emit) emit('uiAction', modelClarifyAction);
        } else {
          await this.resolveOpenModelProducts(tenantId, lastUserText, finalText, intent, uiToolCalls, emit, pushTrace);
        }
      }
    }

    // Flush the trailing (unterminated) sentence.
    if (plainRetail && pending) {
      const clean = this.stripCartTaboo(pending, true);
      if (clean) emit('token', { delta: clean });
    }
    if (holdForCard) {
      const before = finalText;
      finalText = compactItemListing(finalText, shownNames);
      if (finalText !== before) {
        console.log(`[agent] compacted item re-listing beside the card (${before.length} → ${finalText.length} chars)`);
        pushTrace({ step: 'compact', detail: `dropped the text re-listing of ${shownNames.length} shown item(s)` });
      }
      const spoken = this.stripCartTaboo(this.stripChatMedia(finalText), plainRetail).trim();
      if (spoken) emit('token', { delta: spoken });
    }
    finalText = this.stripCartTaboo(this.stripChatMedia(finalText), plainRetail);
    finalText = finalText.replace(/(?:oh no,?\s*)?(?:a\s*)?leaking\s+bathroom\s+is\s+never\s+fun!?[.\s]*/gi, '').trim();
    if (finalText && !finalText.startsWith('To figure out') && !finalText.startsWith('Water leaks') && !finalText.startsWith('A leaking')) {
      finalText = finalText.charAt(0).toUpperCase() + finalText.slice(1);
    }
    if (isOpenModel) {
      let cleaned = finalText;
      while (true) {
        const tool = findBalancedToolCall(cleaned);
        if (!tool) break;
        cleaned = cleaned.replace(tool.fullMatch, '');
      }
      // Same as the stream: a truncated, unbalanced TOOL_CALL must not land in
      // the persisted transcript either.
      const dangling = cleaned.indexOf('TOOL_CALL:');
      if (dangling >= 0) cleaned = cleaned.slice(0, dangling);
      finalText = cleaned.trim();
    }
    if (!finalText.trim()) {
      finalText = plainRetail
        ? 'Here are a few great options — let me know which one catches your eye, or head to checkout any time.'
        : 'Here are the matching products from our catalogue:';
      emit('token', { delta: finalText });
    }
    conversation.push({ role: 'assistant', content: finalText });

    // Grounding + reduce actions into journey memory, then persist server-side.
    const verdict = validateGrounding(finalText, intent.mode, hadRetrieval);
    pushTrace({ step: 'grounding', detail: verdict.ok ? 'ok' : verdict.reason || 'flagged' });
    const uiActions = uiToolCalls.map((call) => ({ name: call.function.name, arguments: (call as any).__quote ? (call as any).__quote : (call as any).__research ? (call as any).__research : JSON.parse(call.function.arguments) }));
    // SAFETY NET (streaming): gender gate fired but no clarify rendered → synthesize + emit it.
    if (mustClarifyGender && !uiActions.some((a) => a.name === 'setPhase' && (a.arguments as any)?.phase === 'clarify')) {
      const synth = this.synthGenderClarify(intent);
      uiActions.push(synth);
      emit('uiAction', synth);
      if (!finalText || !finalText.trim()) { finalText = 'Happy to help! First — who are we shopping for, and what’s the occasion?'; emit('token', { delta: finalText }); }
    }
    // SAFETY NET (streaming): Clarify synthesis when no UI action was rendered
    if (allowDomainClarify && !uiActions.some((a) => a.name === 'setPhase') && uiActions.length === 0 && !intent.panelRenderBlocked && !lastUserText.toLowerCase().includes('my answers:')) {
      const userText = String([...messages].reverse().find((m) => m.role === 'user')?.content || '');
      const synthClarify = this.buildDomainClarify(userText, intent, finalText);
      if (synthClarify) {
        const synthAction = { name: 'setPhase', arguments: { phase: 'clarify', questions: synthClarify.questions } };
        uiActions.push(synthAction);
        emit('uiAction', synthAction);
        pushTrace({ step: 'synth-clarify', detail: `${synthClarify.questions.length} domain question(s) synthesized in the thread` });
        if (synthClarify.chatLead) {
          finalText = synthClarify.chatLead;
        }
      }
    }
    const nextState = reduceActions(journeyState, uiActions, intent);
    await this.sessionStore.save({
      sessionId,
      tenantId,
      customerId: request.customerId,
      messages: persistableTranscript(conversation),
      journeyState: nextState,
      state,
      lastIntent: { intent: intent.intent, stage: intent.stage, mode: intent.mode },
    });

    emit('done', {
      sessionId,
      intent,
      trace,
      message: { role: 'assistant', content: finalText },
      conversation: conversation.filter((m) => m.role !== 'system'),
      uiActions,
    });
  }
}
