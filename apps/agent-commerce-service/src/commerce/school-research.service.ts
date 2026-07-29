/**
 * SchoolResearchService — the journey's "understand the goal" step (AUG-48).
 *
 * When a customer names their school ("Neuqua Valley", "Duke"), we research its
 * OFFICIAL brand LIVE with GPT web search instead of leaning on a static
 * directory — so any school works, colours are current, and we can cite the
 * sources back to the customer for trust. Proven in testing: 10/10 schools
 * returned clean structured data with real sources; gpt-5-mini lands in ~9s.
 *
 * Three principles carried from that test:
 *  1. FACTS AND DIRECTION ONLY, never the logo. Trademarked marks are the
 *     customer's to supply (AUG-16) — research captures where the official
 *     artwork lives and its usage rules, never a recreated mark.
 *  2. RESEARCH IS A PROPOSAL, not applied. Colours come back for the customer
 *     to confirm before any product renders — same contract as AUG-27's
 *     proposeTeamColours ("propose, never apply").
 *  3. CACHE ONCE, REUSE. Each school is researched once per project and stored;
 *     over time this builds a real, cited dataset rather than a static dump.
 *
 * Money/authority note: this calls the project's OWN key (resolveLlm), so a
 * white-label tenant's research bills to them.
 */
import { Injectable } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import { resolveLlm } from '../llm/provider';

const DB_NAME = 'journeyx';
const CACHE = 'school_research';
/** Small, fast, and — proven in testing — as accurate as gpt-5 for this lookup. */
const DEFAULT_MODEL = 'gpt-5-mini';

export interface ResearchColour {
  name: string;
  hex?: string;
  pantone?: string;
  role?: 'primary' | 'secondary' | 'accent';
  /** Nearest colour in THIS brand's palette, so the render has something real. */
  mappedTo?: { name: string; hex?: string };
}

export interface SchoolResearch {
  school: string;
  location?: string;
  team?: string;
  mascot?: string;
  typeface?: string;
  colours: ResearchColour[];
  logo?: { description?: string; officialArtworkSource?: string; usageRestrictions?: string };
  /** Free-form design cues the model surfaced (stripes, two-button, etc.). */
  styleWords?: string[];
  sources: { title?: string; url: string }[];
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
  researchedAt: string;
  model: string;
  /** True when served from cache rather than a fresh search. */
  cached?: boolean;
}

export interface ResearchArgs {
  tenantId: string;
  school: string;
  location?: string;
  /** Colours to map the research against (the brand palette), name+hex. */
  palette?: { name: string; hex?: string }[];
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  force?: boolean;
}

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

@Injectable()
export class SchoolResearchService {
  private col: Collection<SchoolResearch & { projectId: string; key: string }> | null = null;

  private async getCol() {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    const { db }: { db: Db } = await connectToDatabase(uri, DB_NAME);
    this.col = db.collection(CACHE);
    await this.col.createIndex({ projectId: 1, key: 1 }, { unique: true }).catch(() => {});
    return this.col;
  }

  /** Research a school, from cache when we already have it. */
  async research(args: ResearchArgs): Promise<SchoolResearch | { error: string }> {
    const key = norm(`${args.school}|${args.location || ''}`);
    const col = await this.getCol();

    if (col && !args.force) {
      const hit: any = await col.findOne({ projectId: args.tenantId, key });
      if (hit) {
        delete hit._id;
        /* Re-map onto the CURRENT palette every time.
         *
         * What a school's colours are is a research finding and worth caching.
         * Which of our shades they become is DERIVED, and it was being frozen
         * alongside them — so when the palette grew from 14 seeded colours to
         * the 111 real ones, every school researched before that kept its old
         * answer, including "no match at all" for a plain blue. Cached research
         * would have gone on rendering one-colour kits indefinitely. */
        if (args.palette?.length && Array.isArray(hit.colours)) {
          for (const c of hit.colours) c.mappedTo = nearestInPalette(c, args.palette);
          await this.paintSwatches(args.tenantId, hit.colours);
        }
        return { ...hit, cached: true };
      }
    }

    const fresh = await this.callModel(args);
    if ('error' in fresh) return fresh;

    // Map researched colours onto the brand's real palette so the render has a
    // concrete colour to use — the customer's "navy" becomes our nearest navy.
    if (args.palette?.length) {
      for (const c of fresh.colours) c.mappedTo = nearestInPalette(c, args.palette);
      await this.paintSwatches(args.tenantId, fresh.colours);
    }

    if (col) {
      await col.updateOne(
        { projectId: args.tenantId, key },
        { $set: { ...fresh, projectId: args.tenantId, key } },
        { upsert: true },
      ).catch(() => {});
    }
    return fresh;
  }

  /**
   * Give each matched colour its real value (AUG-81).
   *
   * Research almost never publishes a hex — schools state "Silver and Blue" and
   * nothing more — and our own palette stores only names and render codes. The
   * card was therefore drawing a swatch from the colour WORD via CSS, which is
   * right for "Blue" and blank for "Bright Blue". Ask the catalogue what the
   * matched ink actually looks like instead; it derives the value from the
   * brand's own renderer. Deliberately NOT persisted with the research: the
   * value belongs to the palette, not to the school, and re-deriving it keeps a
   * re-inked palette honest. A colour that cannot be resolved keeps no hex at
   * all, so the card shows a neutral chip rather than a confident wrong one.
   */
  private async paintSwatches(tenantId: string, colours: any[]): Promise<void> {
    const names = colours.map((c) => c?.mappedTo?.name).filter(Boolean);
    if (!names.length) return;
    try {
      const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
      const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/colours/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                   'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({ names }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const map: Record<string, string> = (await res.json())?.colours || {};
      for (const c of colours) {
        const hex = c?.mappedTo?.name ? map[c.mappedTo.name] : undefined;
        if (hex) c.mappedTo.hex = hex;
      }
    } catch {
      /* no swatch beats a wrong swatch */
    }
  }

  /** One live web-search call to the Responses API, parsed to our shape. */
  private async callModel(args: ResearchArgs): Promise<SchoolResearch | { error: string }> {
    const llm = resolveLlm({ provider: args.provider, apiKey: args.apiKey, baseUrl: args.baseUrl });
    if (!llm.ok) return { error: 'No LLM API key resolved for this project.' };
    if (llm.provider !== 'openai') {
      // web_search is an OpenAI Responses-API tool; other providers would need a
      // different mechanism. Fail loudly rather than silently returning nothing.
      return { error: `School research needs the OpenAI web_search tool; project provider is "${llm.provider}".` };
    }
    const model = args.model || DEFAULT_MODEL;

    const shape = `{
  "team": "official athletics/team name",
  "mascot": "e.g. Wildcat",
  "typeface": "official athletics typeface if published, else null",
  "colours": [ { "name": "Navy", "hex": "#0C2340", "pantone": "PMS 289", "role": "primary" } ],
  "logo": { "description": "the primary mark", "officialArtworkSource": "URL of the official logo/brand page (never invent)", "usageRestrictions": "trademark/vendor rules if stated, else null" },
  "styleWords": [ "any uniform design cues found: stripes, two-button, piping, etc." ],
  "sources": [ { "title": "...", "url": "https://..." } ],
  "confidence": "high | medium | low",
  "notes": "anything uncertain or needing customer confirmation"
}`;
    const prompt =
      `Research the OFFICIAL brand identity of "${args.school}"${args.location ? ` in ${args.location}` : ''} for designing a custom team jersey/cap. `
      + `Use web search for the official athletics colours (Pantone + hex where published), mascot, official typeface, and the official logo/brand page. `
      + `Do NOT reproduce or recreate the logo — only cite where the official artwork lives and any usage restrictions. Prefer official school/athletics sources. `
      + `Reply with ONLY a JSON object (no markdown) matching this shape exactly:\n${shape}`;

    let body: any;
    try {
      const res = await fetch(`${llm.baseURL}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({ model, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' }, input: prompt }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: `research HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      body = await res.json();
    } catch (e) {
      return { error: `research call failed: ${(e as Error).message}` };
    }

    const items: any[] = body.output || [];
    let text = body.output_text || '';
    if (!text) {
      const msg = items.find((i) => i.type === 'message');
      text = (msg?.content || []).map((c: any) => c.text || '').join('');
    }
    let parsed: any;
    try { parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, '').trim()); }
    catch { return { error: `research returned unparseable output: ${String(text).slice(0, 160)}` }; }

    const colours: ResearchColour[] = (Array.isArray(parsed.colours) ? parsed.colours : [])
      .filter((c: any) => c && c.name)
      .map((c: any) => ({
        name: String(c.name).trim(),
        hex: typeof c.hex === 'string' && /^#?[0-9a-f]{6}$/i.test(c.hex) ? ('#' + c.hex.replace(/^#/, '')).toLowerCase() : undefined,
        pantone: c.pantone || undefined,
        role: ['primary', 'secondary', 'accent'].includes(c.role) ? c.role : undefined,
      }));

    return {
      school: args.school,
      location: args.location,
      team: parsed.team || undefined,
      mascot: parsed.mascot || undefined,
      typeface: parsed.typeface || undefined,
      colours,
      logo: parsed.logo && typeof parsed.logo === 'object' ? {
        description: parsed.logo.description || undefined,
        officialArtworkSource: parsed.logo.officialArtworkSource || undefined,
        usageRestrictions: parsed.logo.usageRestrictions || undefined,
      } : undefined,
      styleWords: Array.isArray(parsed.styleWords) ? parsed.styleWords.filter(Boolean).slice(0, 12) : undefined,
      sources: (Array.isArray(parsed.sources) ? parsed.sources : [])
        .filter((s: any) => s && typeof s.url === 'string')
        .map((s: any) => ({ title: s.title || undefined, url: s.url })),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : undefined,
      notes: parsed.notes || undefined,
      researchedAt: new Date().toISOString(),
      model,
    };
  }
}

/* ── colour mapping ─────────────────────────────────────────────────────── */

function hexToRgb(hex?: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Nearest palette colour to a researched one.
 *
 * Prefers a hex distance when the research gave a hex; otherwise falls back to a
 * name-token match ("Navy" → the palette's navy). Returns undefined rather than
 * a bad guess when neither is available — an unmapped colour is surfaced to the
 * customer to choose, never silently substituted.
 */
export function nearestInPalette(
  colour: ResearchColour,
  palette: { name: string; hex?: string }[],
): { name: string; hex?: string } | undefined {
  if (!palette.length) return undefined;

  // Best case: a true colour distance, when the palette carries real hex. Our
  // current palette does not (it stores render codes), so this is skipped — but
  // it takes over automatically once palette hex is captured.
  const target = hexToRgb(colour.hex);
  if (target && palette.some((p) => hexToRgb(p.hex))) {
    let best: { name: string; hex?: string } | undefined;
    let bestD = Infinity;
    for (const p of palette) {
      const rgb = hexToRgb(p.hex);
      if (!rgb) continue;
      const d = (rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2;
      if (d < bestD) { bestD = d; best = { name: p.name, hex: p.hex }; }
    }
    if (best) return best;
  }

  /* No hex → match on colour WORDS, but in priority order so a school's "Gold"
   * lands on plain "Gold" or "Vegas Gold" rather than the first entry that
   * merely contains "yellow" ("Laser Yellow"). The palette holds a dozen golds
   * and yellows; picking the wrong shade is what made a jersey colour read as
   * "not available" downstream.
   *
   * Tiers, most specific first:
   *   1. the whole research name equals a palette name exactly
   *   2. a research token (PRIMARY word first) equals a palette name exactly
   *   3. a research token appears as a whole word in a palette name — and among
   *      those, the SHORTEST palette name wins (the least-modified shade, e.g.
   *      "Gold" over "Light Old Gold").
   * Primary-word order matters: "Gold/Yellow" tries "gold" before "yellow", so
   * the athletic gold is chosen over a bright yellow. */
  const norm = (s: string) => s.trim().toLowerCase();
  const full = norm(colour.name);
  const byExactFull = palette.find((p) => norm(p.name) === full);
  if (byExactFull) return { name: byExactFull.name, hex: byExactFull.hex };

  const tokens = colour.name.split(/[^A-Za-z]+/).map(norm).filter((w) => w.length > 2);
  for (const tok of tokens) {
    const exact = palette.find((p) => norm(p.name) === tok);
    if (exact) return { name: exact.name, hex: exact.hex };
    const word = new RegExp(`\\b${tok}\\b`, 'i');
    const cands = palette.filter((p) => word.test(p.name));
    if (cands.length) {
      /* Shortest wins, but a name carrying a SECOND colour word is a blend, not
       * a shade of the one asked for. "Blue Grey" is the shortest palette entry
       * containing "blue" and is a grey — picking it put a muddy grey on a team
       * whose colour is blue. Blends are pushed behind true shades; among
       * equals the least-modified name still wins. */
      const BASIC = ['black', 'white', 'grey', 'gray', 'silver', 'red', 'orange', 'yellow',
                     'gold', 'green', 'blue', 'purple', 'pink', 'brown', 'maroon', 'navy'];
      const blend = (name: string) =>
        BASIC.some((b) => b !== tok && new RegExp(`\\b${b}\\b`, 'i').test(name));
      cands.sort((a, b) =>
        (blend(a.name) ? 1 : 0) - (blend(b.name) ? 1 : 0) || a.name.length - b.name.length);
      return { name: cands[0].name, hex: cands[0].hex };
    }
  }
  return undefined;
}
