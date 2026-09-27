import { adapterRegistry } from '@journeyax/integration';

export async function getTeamColours(tenantId: string, rawArgs: string): Promise<unknown> {
  let slug = '';
  try { slug = String(JSON.parse(rawArgs || '{}').slug || '').trim(); } catch { /* ignore */ }
  if (!slug) return { status: 'unknown', guidance: 'No programme confirmed yet — confirm which one first.' };
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/teams/colours`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { status: 'unknown', guidance: 'Could not look those up — ask the customer.' };
    return await res.json();
  } catch {
    return { status: 'unknown', guidance: 'Could not look those up — ask the customer.' };
  }
}

/**
 * Read a pasted roster (AUG-32).
 *
 * Delegated to the roster endpoint so the model never parses the list itself —
 * an LLM reading 24 rows of names and sizes will quietly normalise a typo or
 * drop a row, and nobody finds out until the box arrives. The parser is
 * deterministic and reports its own guesses.
 */

export async function readRoster(tenantId: string, rawArgs: string): Promise<unknown> {
  let text = ''; let garments: string[] = ['jersey'];
  try {
    const a = JSON.parse(rawArgs || '{}');
    text = String(a.text || '');
    if (Array.isArray(a.garments) && a.garments.length) garments = a.garments.map(String);
  } catch { /* fall through */ }
  if (!text.trim()) return { playerCount: 0, guidance: 'No roster supplied — ask the customer to paste their player list.' };

  try {
    const base = process.env.AGENT_SELF_URL || 'http://localhost:3004';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/commerce/roster/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, garments }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: 'Could not read the roster.' };
    const r: any = await res.json();
    return {
      ...r,
      guidance: r.needsConfirmation || r.needsReview?.length
        ? 'Show the customer the columns you read and every flagged row, and ASK THEM TO CONFIRM before ordering anything. Do not fix issues on their behalf.'
        : 'Columns were unambiguous and every row is clean. Summarise the player count and sizes, then confirm before pricing.',
    };
  } catch {
    return { error: 'Could not read the roster.' };
  }
}

/** Resolve a findEntity call through the BUSINESS port. Always returns the
 *  confirm-with-the-customer guidance, so a directory match — or its colours —
 *  is never treated as settled fact. */

export async function lookupEntities(tenantId: string, rawArgs: string): Promise<unknown> {
  let query = ''; let where: Record<string, string> = {};
  try {
    const a = JSON.parse(rawArgs || '{}');
    query = String(a.query || '').trim();
    if (a.state) where.state = a.state;
    if (a.city) where.city = a.city;
  } catch { /* fall through */ }
  if (!query) return { matches: [], guidance: 'No name supplied — ask the customer.' };
  try {
    const business = await adapterRegistry.getBusiness(tenantId);
    if (typeof business.findEntities !== 'function') {
      return { matches: [], guidance: 'No directory for this business — ask the customer directly and record what they tell you.' };
    }
    const r = await business.findEntities({ tenantId }, query, where);
    if (!r.matches?.length) {
      return { query, matches: [], guidance:
        `Nothing matching "${query}" is on file. If your query combined a name with a place ` +
        `(e.g. "IIT Chicago"), retry with the distinctive part alone ("IIT") — directories store the ` +
        `official name, not how people say it. Otherwise ask the customer to confirm the exact name ` +
        `and details — do NOT guess — and offer to save it so it is there next time.` };
    }
    return r;
  } catch (err) {
    console.error('[AgentService] findEntity error:', err);
    return { query, matches: [], guidance: 'Lookup failed — ask the customer directly.' };
  }
}

/** Resolve a getProductOptions call through the KnowledgePort. Shared by both
 *  dispatch paths. An unknown SKU returns an explicit "not recorded" so the
 *  model states that instead of offering a colour the catalogue doesn't carry. */
/**
 * Resolve a product NAME to its real style code.
 *
 * Customers (and the model) refer to products by the NAME we just showed them —
 * "the FreeStyle Sublimated Turbo Full-Button Baseball Jersey" — not by "227130".
 * The options/related lookups key on the style code, so a name came back
 * `found: false` and the agent told the customer it "couldn't retrieve the
 * colour and size options" for a style whose options are fully populated, then
 * dead-ended them to customer service. Search the catalogue and take the best
 * match's code. Returns '' when nothing convincing is found — the caller then
 * reports honestly rather than guessing a code.
 */
/**
 * Resolve a positional reference against the cards on screen.
 *
 * "product 2", "the first one", "option 3", "#2", "the 2nd" — all map to an
 * index into what the panel is showing. Returns '' when the text carries no
 * position, so a genuine style code or product name falls through untouched.
 */

export async function skusThatExist(tenantId: string, tokens: string[]): Promise<string[]> {
  if (!tokens.length) return [];
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/skus/exists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus: tokens }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    return ((await res.json())?.found || []).map((x: string) => String(x).toUpperCase());
  } catch {
    return [];
  }
}

/**
 * Quote lines must carry real style CODES, never product names.
 *
 * The model quotes what it sees on screen — "Youth FreeStyle Sublimated
 * Two-Button Baseball Jersey" — but the quote engine prices by code, so an
 * unresolved name yields unitPrice null and a $0 line. A zero total is worse
 * than a missing quote: it looks authoritative. A style code never contains
 * whitespace, so anything that does is a name to resolve.
 */
/**
 * CDL: read a customer's attached design image and match it to the template
 * library. The image never touches the LLM prompt — it's held server-side for
 * the turn and passed here. Delegates the vision + match to product-service's
 * /cdl/analyze (same engine as the standalone CDL studio), then trims the
 * response to what the model needs to drive the next step (decision + the style
 * code to design on + the colours it read).
 */

/**
 * CDL "design it in chat" (Door A): generate a jersey concept from the
 * customer's brief (nano-banana via product-service), then analyse + match it to
 * a make-able template — the same use/create decision as an upload. The concept
 * image itself never enters the LLM prompt (it's ~1–2MB); we return a short
 * conceptId the panel fetches, plus the decision/design/template the model needs.
 */

/**
 * Coach Team-Order Journey (Step 3): generate up to four FLAT 2D team-jersey
 * views (front/back/left/right) from the accumulated brief, via
 * product-service's `/cdl/flat-views` (same base URL pattern as generateDesign
 * → `/cdl/design`). Unlike generateDesign/analyzeDesign there is no
 * decision/template matching here — this stays 2D-only, no 3D bake, and no
 * catalogue-template lookup. An uploaded team logo attached this turn is
 * threaded through the same way analyzeDesign receives it (`turnImage`),
 * becoming the seed artwork the four views are generated from.
 */

/** CDL: submit the current design for artist review (the production-authority
 *  gate). The artist signs off before anything prints; the agent can never
 *  approve for them. */

/**
 * Coach Team-Order Journey (Step 6): submit the team's finished design +
 * roster for artist review — the same lifecycle as submitForReview
 * (POST :projectId/cdl/review, kind 'use'), sourcing sku the same way
 * submitForReview does (a model-supplied or journeyState-known style code).
 *
 * HONEST LIMITATION: the roster and four flat-view ids only ever exist in the
 * BROWSER's journey state — the server-side `journeyState` this function
 * receives (unlike the client's React JourneyState) never accumulates them,
 * so a chat-triggered submit here goes through WITHOUT roster/flatViews on
 * the review record. The reliable, fully-populated path is the "Submit team
 * order" button in ConfiguratorPanel (teamPreview phase), which posts the
 * browser's actual roster + views directly. This tool exists so a coach who
 * says "submit it" in chat still gets a real jobId rather than silence.
 */


/* An explicit sizing question ("what size should I get", "I don't know my
 * size, my waist is 35 inches") does not reliably make the model call
 * recommendSize on its own — live-tested 2026-08-24: it consistently answers
 * through the normal clarify/showItems path instead, even with a concrete
 * measurement stated. Same lesson as enforceNamedSku/enforceItemDesignability:
 * wording does not hold, so it is settled in code. Conservative regex (only
 * fires on an unmistakable sizing ask); the forced call still lets the MODEL
 * extract category/measurement from free text, since that generalises far
 * better than hand-parsing arbitrary phrasing. */
const SIZE_QUESTION_RE = /\b(what|which)('?s| is| are)?\s+size\b|\bsize\s+should\s+i\b|\bwhat\s+size\s+am\s+i\b|\bdon'?t\s+know\s+(my|what)\s+size\b|\bwaist\s+(is|measurement)\b|\b\d{2,3}\s*(inch|in|cm)\s*waist\b|\bwaist\s+of\s+\d{2,3}\b/i;

