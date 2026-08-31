import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { adapterRegistry, createPublishedConfigResolver } from '@journeyax/integration';
import { getChatClient } from './llm/provider';
import { QuoteService } from './commerce/quote.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { ProjectCalculatorService } from './commerce/project-calculator.service';
import { BranchStockService } from './commerce/branch-stock.service';
import {
  JourneyState, emptyJourneyState, reduceActions, alreadyPresented,
  renderJourneyStateBlock,
} from './pipeline/journey-memory';

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

/** Apply the project's configured temperature — but only where the model supports it. */
function genParams(model: string, temperature?: number): { temperature?: number } {
  if (typeof temperature === 'number' && !isReasoningModel(model)) return { temperature };
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

// ── Tool Definitions ──────────────────────────────────────────────────
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'researchSchool',
      description:
        "FIRST STEP whenever the customer names a school, college, university or club team (e.g. \"Neuqua Valley\", \"Duke\", \"our high school\"). Research its OFFICIAL brand LIVE: team name, mascot, official colours (mapped to this brand's real palette), typeface, uniform design cues, and where the official logo lives. This shows a research card on the panel for the customer to CONFIRM before anything is designed. After they confirm, use the returned palette colour names when you searchKnowledge and render the garment. NEVER recreate the official logo — the customer supplies their approved artwork. Call this ONCE per school; results are cached.",
      parameters: {
        type: 'object',
        properties: {
          school: { type: 'string', description: 'The school / college / team name exactly as the customer gave it' },
          location: { type: 'string', description: 'City and state if known — sharpens accuracy (e.g. "Naperville, Illinois")' },
        },
        required: ['school'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchKnowledge',
      description: "Search this business's knowledge base for items, troubleshooting guides, inspiration, collections, installation/how-to info, warranty/policy, or any other content relevant to the customer's request.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          type: {
            type: 'string',
            enum: ['product', 'troubleshooting', 'design', 'collection', 'installation', 'faq', 'sizing', 'general'],
            description:
              "Pick the type that matches the CUSTOMER'S INTENT — this is critical for accurate results, each type carries different data:\n" +
              "• 'product' — they want to choose/compare specific fixtures (basin, toilet, tapware, shower). Carries real images, prices, specs, finishes.\n" +
              "• 'design' — they're building new / renovating / want inspiration or a room concept ('modern bathroom', 'Hamptons style', 'small ensuite ideas'). Carries curated looks & concepts.\n" +
              "• 'collection' — they want a coordinated matching range across fixtures (e.g. do the whole bathroom in one look). Carries collection groupings.\n" +
              "• 'troubleshooting' — something is broken/leaking/running/not working. Carries diagnostic fix steps.\n" +
              "• 'installation' — how to fit/install/rough-in a product. Carries install guides.\n" +
              "• 'faq' — warranty, policy, care/cleaning questions.\n" +
              "• 'sizing' — fit & size questions (size charts, 'what size am I', 'does it run small', how to measure, which fit/cut suits, fabric care, occasion styling). Carries fit guides & size charts. Use this for apparel/footwear whenever fit or sizing is in play.\n" +
              "Classify each turn from what the customer actually said; do not default to 'product'. For a full bathroom build, lead with 'design' or 'collection', then search 'product' for the individual fixtures. Omit only if genuinely ambiguous.",
          },
          category: { type: 'string', description: 'Optional filter by category (Basins, Showers, Tapware, Toilet Suites, Baths, Accessories)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'registerEntity',
      description:
        "Save a {ENTITY} that is NOT already in the directory — call this once the customer has given you its name and details. " +
        "Many {ENTITY_PLURAL} are in no public directory, so recording what the customer tells you is the ONLY way to have it, and it makes their next reorder instant. " +
        "Record what the customer stated, exactly; do not look anything up or embellish. Confirm the details back before saving.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name as the customer says it.' },
          kind: { type: 'string', enum: ['club', 'school', 'league', 'business'], description: 'What kind of organisation this is.' },
          city: { type: 'string' },
          state: { type: 'string', description: 'State/province code.' },
          sport: { type: 'string' },
          colours: {
            type: 'array',
            description: 'Colours the CUSTOMER stated. Hex only if they gave one.',
            items: { type: 'object', properties: { name: { type: 'string' }, hex: { type: 'string' } } },
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'requestArtwork',
      description:
        "Ask the customer to supply their own logo/artwork, and show what is already on file for this order. " +
        "Use this ONLY when the customer actually wants a logo, crest or photo on the product — NEVER for a text-only personalization (a name, initials, a message prints fine without any uploaded artwork). " +
        "IMPORTANT: this business NEVER supplies or recreates a school, club or league mark — those are trademarked and licensed, and only the customer is entitled to provide theirs. " +
        "Never describe, generate or source a crest yourself. If the customer asks you to find their logo, explain that they need to upload it (or confirm artwork already held on their account).",
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why artwork is needed now, in one line for the customer.' },
          placement: { type: 'string', description: "Where it will be decorated, if known (e.g. 'left chest')." },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkArtworkApproval',
      description:
        "Check whether customer-supplied ARTWORK for this order has been approved. " +
        "Call this ONLY when the design includes the customer's OWN uploaded artwork — a logo, crest, or photo. " +
        "A TEXT-ONLY personalization (a name, initials, a number, a short message) is NOT customer artwork and needs NO approval: go straight to the quote, never ask for a photo or artwork approval. " +
        "When uploaded artwork IS involved and approval is not clear, tell the customer what is outstanding — nothing goes to production on unapproved artwork, and you CANNOT approve it on their behalf.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readRoster',
      description:
        'Read a list of players the customer pasted (from a spreadsheet, a CSV, or typed out) and work out which column is the name, the number and each size. ' +
        'Use this the moment a customer supplies players — do NOT try to read the list yourself, and never retype it into another tool. ' +
        'It returns the columns it identified AND WHY, plus any rows with problems (duplicate numbers, sizes this brand does not stock, missing names). ' +
        'NOTHING IS ORDERED BY THIS TOOL. If needsConfirmation is true, or any row has issues, show the customer what you read and ask them to confirm before going further — a misread column prints the wrong name on a shirt.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The roster exactly as the customer supplied it. Paste it through verbatim — do not clean it up, reorder it, or fix what look like typos.' },
          garments: {
            type: 'array', items: { type: 'string' },
            description: "Which kit items are being sized, in order, e.g. ['jersey','pants']. Use the items actually being ordered so a two-size sheet maps to the right two garments.",
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductOptions',
      description:
        "Look up the EXACT choices available on a specific item code: which colours and sizes can actually be ordered, the item's fixed characteristics (fabric, closure, fit), and items that coordinate with it. " +
        "Use this before confirming any colour or size to a customer, and when they ask 'what colours does it come in?' or 'does it come in XL?'. " +
        "Only what is returned is orderable — if a colour or size is absent it does NOT exist, so say so rather than offering it. " +
        "`preview3D` is the ONLY authority on whether this platform can show the item in 3D: 'yes' means show it, " +
        "'no' means offer the catalogue photo instead, and 'unknown' means WE HAVE NOT CHECKED — in that case just try showConfigurator. " +
        "NEVER tell a customer an item cannot be customised or previewed unless preview3D is explicitly 'no'; supplier data contains stale flags that claim otherwise.",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'The item/style code (must be a real code from a previous search result).' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyzeDesign',
      description:
        "Read a CUSTOM DESIGN IMAGE the customer attached this turn and match it to our make-able template library. " +
        "Call this the moment you are told a design image was attached — before saying anything else. " +
        "It runs vision on the image (reads the garment type, sport, colours, and whether it has a team name / number / logo) and returns a decision: " +
        "`decision:'use'` means we ALREADY make this exact style — a real template with all the needed sizes exists, and `match.best.parentSku` is the style code to design on; " +
        "`decision:'create'` means NO existing template matches, so this is a brand-new design whose cut pieces must be generated and finalised by an artist. " +
        "On 'use', follow up by calling showConfigurator with `match.best.parentSku` and the analysed colours so the customer sees THEIR design on our real template in 3D. " +
        "On 'create', do NOT invent a style code — tell the customer warmly it is a fresh design that we will pattern and an artist will finalise. " +
        "You do not pass the image yourself; it is already attached server-side. Only pass `sizes` if the customer named the sizes they need.",
      parameters: {
        type: 'object',
        properties: {
          sizes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sizes the customer explicitly needs (e.g. ["YM","YL","AS","AM","AL","AXL"]). Omit if not stated — matching still works.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generateDesign',
      description:
        "DESIGN a brand-new jersey concept FOR the customer from their description — you are their designer, so they never have to go to another tool to make an image. " +
        "Call this whenever the customer describes a look they want (colours, team name, number, style, vibe) rather than uploading one, e.g. 'design me a navy and orange baseball jersey for the Cougars, number 30, aggressive'. " +
        "It generates a concept image, then reads and matches it to our make-able template library, returning the same decision as analyzeDesign: " +
        "`decision:'use'` (we already make this style — `template.sku` is the code, and the configurator will open) or `decision:'create'` (a brand-new pattern our artist will finalise). " +
        "After it returns on 'use', tell the customer you've designed their concept and it's shown on the right; invite them to tweak colours, name or number. " +
        "If they then say 'make the sleeves brighter' or similar, call generateDesign again with the refined brief to iterate.",
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: "The customer's design description in your own words — capture sport, garment (jersey/top), colours, team name, number and any style/vibe they mentioned." },
          sizes: { type: 'array', items: { type: 'string' }, description: 'Sizes the customer needs, if stated. Optional.' },
        },
        required: ['brief'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generateTeamDesign',
      description:
        "DESIGN a WHOLE TEAM's look, not one customer's garment — use when a coach/dealer describes a roster/team order rather than a single design: multiple players, a team name, 'coach', 'our team', 'need N jerseys', etc. " +
        "Produces four FLAT 2D views (front/back/left sleeve/right sleeve) from the accumulated brief — a fast 2D preview, not a 3D bake. If the coach attached a team logo this turn, it is used automatically as the base artwork; you do not pass image bytes yourself. " +
        "After it returns, tell the coach their team's design is shown (four views) and invite them to approve or ask for changes; the panel itself offers 'Approve — let's do the roster' once they're happy — you do not need a separate tool for that step. " +
        "If they ask for a change ('make the body black, orange shoulders'), call generateTeamDesign again with the FULL accumulated brief (not just the delta) — this regenerates all four views from scratch, it does not surgically edit one. " +
        "IMPORTANT: before the coach's FIRST design generation, confirm which real style/garment they want using getProductOptions (grounded in our actual catalogue) and pass its code as `sku` — the roster step that follows needs a real style to price against.",
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: "The running, accumulated design description in your own words — sport, garment, colours, lettering, style. Re-send the whole thing on every edit, not just what changed." },
          sourceId: { type: 'string', description: 'Optional — a previously generated concept/design id to use as the base artwork instead of a fresh description.' },
          sku: { type: 'string', description: 'The confirmed style/template code (from getProductOptions) the team order is being priced against. Pass it every time it is known, even on a re-generation.' },
        },
        required: ['brief'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'uploadPhotosFor3D',
      description:
        "Switch the customer into the REAL-PHOTO 3D match flow — use when they say they have actual photos of a garment they want matched/baked in 3D ('I have real photos of the jersey I want to match', 'can you show my actual jersey in 3D', 'I'll upload pictures of it'), as opposed to describing a look for us to design (use generateDesign/generateTeamDesign for that). " +
        "This tool does NOT do the baking itself — it only opens the upload panel where the customer picks up to 4 real photos (front required; back/left sleeve/right sleeve optional) and the bake happens client-side once they submit. " +
        "Confirm which real style/garment the photos should be matched to using getProductOptions first if not already known, and pass its code as `sku` — the bake needs a real style's 3D mesh. " +
        "After calling this, tell the customer briefly that the upload panel is open and to add their photos (front is required).",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'The confirmed style/template code (from getProductOptions) the real-photo bake will be matched against, if already known.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitForReview',
      description:
        "Send the customer's finished design to our ARTIST for review — the artist is the production authority and every custom design is checked before it can print. " +
        "Call this once the customer is happy with how their design looks (after the configurator, colours, name and number are set), or immediately when the design is a brand-new one we don't yet have a pattern for (kind 'create'). " +
        "kind 'use' = the design sits on an existing style we make; kind 'create' = a new design whose cut pieces the artist must generate at all sizes first. " +
        "After submitting, tell the customer it's with our artist and you'll confirm once it's approved — do NOT tell them it is production-ready yourself.",
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['use', 'create'], description: "'use' if the design is on an existing style code; 'create' if it is a brand-new design needing new cut pieces." },
          sku: { type: 'string', description: 'The style code the design sits on (for kind "use").' },
          summary: { type: 'string', description: 'A one-line human summary of the design (garment, colours, team, number) for the artist.' },
          sizes: { type: 'array', items: { type: 'string' }, description: 'Sizes required, if known.' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkReviewStatus',
      description:
        "Check where the customer's design is in artist review (pending with the artist, changes requested, artist-approved, or ready to print). " +
        "Use it when the customer asks 'is it ready?' or after they've submitted a design. " +
        "If it is 'artist_approved', invite the customer to AGREE to the proof so it can go to print — you cannot agree for them. If 'ready_for_print', proceed to quote/checkout. If still pending, say so honestly.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitTeamOrder',
      description:
        "Send the coach's finished team order — design + roster — to our ARTIST for review, the same production-authority gate as submitForReview but for a whole team. " +
        "Call this when the coach says the design and roster both look good and wants to proceed ('submit', 'looks good, order it', 'send it in'). " +
        "Prefer letting the coach use the on-screen 'Submit team order' button once they reach the 3D preview — only call this tool if they ask verbally instead of clicking it. " +
        "After submitting, tell the coach it is with our artist and you will confirm once approved — do NOT tell them it is production-ready yourself.",
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'A one-line human summary of the team order (team name, sport, colours, player count) for the artist.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommendSize',
      description:
        "Recommend a size for an item, GROUNDED in this store's real size chart — never invent or guess a size. " +
        "Ask at most 2-4 targeted sizing questions first, varying by category: for jeans/shorts, ask their usual WAIST size (a number); " +
        "for tops/tees/hoodies/dresses/jerseys, ask their usual letter size (XS/S/M/L/XL…) at a similar brand, or a chest/bust measurement if they don't know it; " +
        "for teamwear (a coach/team order), ask their usual size and whether it's for an adult or youth player. " +
        "Call this ONLY once you have at least one concrete answer (a waist number, a usual letter size, or a measurement) — do not call it speculatively. " +
        "If the response comes back with ok:false or no recommendedSize, that means we genuinely do not have real size data for this category yet — " +
        "tell the customer honestly that we can't confirm a size for that item rather than guessing one.",
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'The kind of item, in the customer\'s words, e.g. "jeans", "shorts", "t-shirt", "jersey", "dress".' },
          usualSize: { type: 'string', description: 'The size they say they usually wear (e.g. "32", "Medium", "L"). Optional.' },
          waistIn: { type: 'number', description: 'Waist measurement in inches, if given directly. Optional.' },
          chestIn: { type: 'number', description: 'Chest/bust measurement in inches, if given directly. Optional.' },
          division: { type: 'string', enum: ['adult', 'youth'], description: 'Teamwear only — adult or youth player. Optional.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findRelated',
      description:
        "Look up EXACT catalogue relationships for a specific item code you already have: other items in the same collection, coordinated pieces that complete the look, and the matching adult / youth / ladies versions of the same garment. " +
        "Use this instead of guessing whenever the customer asks 'what matches this?', 'is there a youth size?', 'what else is in this range?', or you are assembling a coordinated team/uniform set. " +
        "Returns only relationships that genuinely exist — if a field comes back empty, that version does NOT exist and you must say so rather than inventing an item code.",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'The item/style code to find relationships for (must be a real code from a previous search result).' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setPhase',
      description: 'Update the UI phase. When transitioning to "clarify", you MUST provide dynamic questions tailored to the user\'s context. These questions will render on the right panel.',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['intro', 'clarify', 'validating', 'products', 'quote', 'ordered'] },
          questions: {
            type: 'array',
            description: 'Dynamic clarification questions to show on the right panel. Required when phase is "clarify".',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique ID for this question (e.g. "scope", "finish", "shower_type")' },
                title: { type: 'string', description: 'The question text shown to the user' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'The selectable answer options (2-5 options)'
                }
              },
              required: ['id', 'title', 'options']
            }
          }
        },
        required: ['phase']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateQuote',
      description: 'Assemble the final quote (Bill of Materials). You propose ONLY the SKUs and quantities — the server looks up the real price, stock and totals from the catalogue and the tenant\'s pricing config. NEVER provide prices or totals yourself; they are computed authoritatively server-side. Include only real SKUs returned by searchKnowledge.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the quote (e.g. "Your Quote")' },
          installationSummary: { type: 'string', description: 'Narrative installation notes (what to remove, sealants needed, etc.). NOT priced.' },
          warrantySummary: { type: 'string', description: 'Narrative warranty/guarantee/compliance notes. NOT priced.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', description: 'The product SKU (must be a real SKU from searchKnowledge)' },
                quantity: { type: 'number', default: 1 },
                reason: { type: 'string', description: 'Why this item is included' },
                required: { type: 'boolean', default: false, description: 'Whether this is a mandatory component' }
              },
              required: ['sku']
            }
          }
        },
        required: ['items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'showItems',
      description: 'Show recommendation cards (items — products, services or options) on the right panel. Use AFTER searchKnowledge to present items for review BEFORE building the final quote. Use only real data returned by searchKnowledge — never invent.',
      parameters: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Product name' },
                sku: { type: 'string', description: 'Product SKU' },
                price: { type: 'number', description: 'Price as a number, in the store\'s own currency (do NOT convert or assume a currency).' },
                imageUrl: { type: 'string', description: 'Product image URL, exactly as returned by retrieval.' },
                category: { type: 'string', description: 'Product category, as it appears in the catalogue for THIS business (e.g. the retrieved breadcrumb/category).' },
                collection: { type: 'string', description: 'Collection or range name, if the item belongs to one' },
                description: { type: 'string', description: 'A 1-2 sentence explanation of WHY this product fits the user\'s brief' },
                features: { type: 'array', items: { type: 'string' }, description: '2-3 key features or benefits' },
                finishes: { type: 'array', items: { type: 'string' }, description: 'Available finishes / colours, if the item has them' },
                recommendedSize: { type: 'string', description: 'The single size you recommend for THIS shopper based on the occasion, their stated size and this garment\'s fit (e.g. "M"). Set this once the shopper has given their size so the card can pre-select it. Must be one of the item\'s available sizes.' },
                specs: {
                  type: 'object',
                  description: 'Key product specifications as key-value pairs — include ONLY specs that are EXPLICITLY present in the retrieved data for THIS item, using whatever fields that business actually publishes (e.g. material/fit/care for apparel; dimensions/rating for fixtures). CRITICAL: never invent or carry over a spec that is not in the retrieved data — in particular do NOT add a Warranty, rating, or installation field unless the retrieval explicitly states one. Omit anything not stated.',
                  additionalProperties: { type: 'string' }
                },
                url: { type: 'string', description: 'Item page URL from the catalogue' },
                accessories: {
                  type: 'array',
                  description: 'Optional matching add-ons — ONLY REAL items that retrieval returned for THIS business (e.g. a coordinating piece the catalogue actually carries). NEVER invent an accessory, SKU, or price to fill this in. If retrieval surfaced no genuine related items, leave this empty.',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      sku: { type: 'string' },
                      price: { type: 'number' }
                    },
                    required: ['name']
                  }
                },
                installationParts: {
                  type: 'array',
                  description: 'Mandatory parts required for installation (e.g. In-wall body, Connector). You MUST proactively suggest at least 1 installation part if applicable.',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      sku: { type: 'string' },
                      price: { type: 'number' },
                      required: { type: 'boolean', description: 'True if this part is mandatory for installation' }
                    },
                    required: ['name']
                  }
                }
              },
              required: ['name', 'description']
            }
          }
        },
        required: ['products']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'showGuide',
      description: 'Show an interactive troubleshooting or installation guide on the right panel. Use this for step-by-step instructions (e.g. diagnosing a leak, installing a product).',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique identifier for the step (e.g., "step-1")' },
                title: { type: 'string', description: 'Short title for the step (e.g., "Turn Off Water Supply")' },
                description: { type: 'string', description: 'Detailed explanation of what to do.' }
              },
              required: ['id', 'title', 'description']
            }
          }
        },
        required: ['steps']
      }
    }
  },
  // ── Phase B capabilities (generic building blocks, business-agnostic) ──
  {
    type: 'function',
    function: {
      name: 'showAddons',
      description: 'Show recommended accessories / add-on parts for the selected product(s) on the right panel, grouped by necessity. Use AFTER the customer has chosen their main products. Use only real items from searchKnowledge — do NOT invent SKUs, prices, or images.',
      parameters: {
        type: 'object',
        properties: {
          accessories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sku: { type: 'string' },
                price: { type: 'number' },
                imageUrl: { type: 'string' },
                category: { type: 'string' },
                group: { type: 'string', enum: ['required', 'recommended', 'optional'], description: 'required = needed to install/use; recommended = strongly suggested; optional = nice-to-have' },
                reason: { type: 'string', description: 'Why this accessory (1 short sentence)' },
              },
              required: ['name', 'group'],
            },
          },
        },
        required: ['accessories'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'presentChoice',
      description: 'Present a decision to the customer as selectable options on the right panel (e.g. "DIY vs professional installation", "which finish"). Generic — use whenever the journey needs the customer to pick a path before continuing.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The question (e.g. "How would you like to install this?")' },
          key: { type: 'string', description: 'A short key for this choice (e.g. "install_path")' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string', description: 'What choosing this means' },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['title', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showDocuments',
      description: 'Show official installation / troubleshooting guide documents (PDFs) for a product on the right panel, with view + download links. Use the documents returned by searchKnowledge — NEVER invent URLs. If a product has multiple guides, include all relevant ones.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          summary: { type: 'string', description: 'Customer-friendly high-level summary of the install, based ONLY on the official documents' },
          guides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string', description: 'The real PDF/document URL from the knowledge base' },
                kind: { type: 'string', description: 'install | spec | warranty | cad | troubleshooting' },
              },
              required: ['title', 'url'],
            },
          },
        },
        required: ['guides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showInfo',
      description: 'Show warranty & guarantee information for the selected product(s) on the right panel, BEFORE building the quote. Use ONLY warranty facts found in the knowledge base. If product-specific warranty is not in the data, say so honestly (do not invent terms). Optionally offer an extended warranty / service package if one is configured.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          standardWarranty: { type: 'string', description: 'e.g. "10 years on the ceramic, 5 years on the mechanism" — or state that product-specific warranty was not found' },
          conditions: { type: 'string', description: 'Key warranty conditions, if known' },
          installationNote: { type: 'string', description: 'How DIY vs licensed-plumber installation affects the warranty, if known' },
          documentUrl: { type: 'string', description: 'Link to the official warranty document, if available' },
          extendedPackage: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              price: { type: 'number' },
              summary: { type: 'string' },
            },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'showConfigurator',
      description:
        'CALL THIS — do not describe the design in words instead. If you find yourself about to write "let us visualise", "here is how it would look" or "let me show you", call this tool in the SAME turn: the customer sees nothing until you do. '
        + 'It opens the interactive 3D configurator AND pre-fills it with what they have already told you, so they never re-enter it. ' +
        "If they said \"navy with white trim, number 23, name SANCHEZ\", pass those here and the 3D preview opens already showing it. " +
        'Pass `sku` whenever you know the item, so the configurator offers that product\'s REAL orderable colours instead of generic ones. ' +
        'Call this again on any later change (\"make it maroon\", \"number 7 instead\") — it updates the live preview rather than reopening. ' +
        'Only pass colours you have verified with getProductOptions; if unsure, pass the sku alone and let the customer pick.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: "Item code being configured. If the customer NAMED a style or item code, pass exactly that one — never substitute a different code you found while searching, or the customer is shown the wrong garment. Only use a retrieved code when they have not named one." },
          baseColor: { type: 'string', description: 'Main garment colour, by NAME as the catalogue lists it (e.g. "Navy") or hex.' },
          accentColor: { type: 'string', description: 'Trim/secondary colour, by catalogue name or hex.' },
          name: { type: 'string', description: 'Player or team name to show on the garment.' },
          number: { type: 'string', description: 'Player number to show.' },
          designLine: { type: 'string', description: "The design line / pattern, e.g. 'serpentine', 'all-over pattern', 'center field'. REQUIRED for a sublimated garment: without it the pattern layer stays off and the garment renders blank no matter which colours are chosen. Design lines differ PER STYLE — use getProductOptions for the style and pass one it actually offers, never one you remember from another item." },
          textColour: { type: 'string', description: 'Colour of the lettering itself, by catalogue name. Pass explicitly rather than assuming it follows the body or trim.' },
          outlineColour: { type: 'string', description: 'Outline/stroke colour of the lettering, by catalogue name.' },
          note: { type: 'string', description: 'One line telling the customer what they are looking at.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buildProjectPlan',
      description:
        "CALCULATE a complete authoritative bill-of-materials and project plan for DIY and trade building projects (Decking, Fencing, Wall Lining, Retaining, Cladding). " +
        "Call this whenever a customer asks to plan, size, estimate, or calculate materials for a project (e.g. 'help me plan a 4x3m deck', 'estimate materials for a 20m fence', 'how much GIB board for 40m2 wall'). " +
        "It deterministically computes structural bearers, joists, palings/boards, fasteners, concrete, tools needed, and NZ Building Code compliance notes, and opens the interactive Project Plan on the right panel.",
      parameters: {
        type: 'object',
        properties: {
          projectType: {
            type: 'string',
            enum: ['decking', 'fencing', 'lining', 'retaining', 'cladding'],
            description: 'The type of building project.',
          },
          lengthM: { type: 'number', description: 'Length of the deck, fence, or room in metres.' },
          widthM: { type: 'number', description: 'Width of the deck or room in metres.' },
          heightM: { type: 'number', description: 'Height of the fence, deck, or wall in metres (optional).' },
          areaM2: { type: 'number', description: 'Total wall surface area in square metres (for wall lining).' },
          material: { type: 'string', description: 'Material preference if stated (e.g. "Kwila", "Radiata Pine H3.2", "Composite", "GIB Aqualine").' },
        },
        required: ['projectType'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkBranchStock',
      description:
        "Check real-time stock availability, inventory counts, and Click & Collect pickup readiness across PlaceMakers NZ branches (Mount Wellington, Cook Street, Albany, Riccarton, Te Rapa, Petone). " +
        "Use when a customer asks about stock at a branch or where they can collect materials today (e.g. 'Can I collect this from Mt Wellington?', 'Do you have stock in Cook St?').",
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'The product SKU code or identifier.' },
          productTitle: { type: 'string', description: 'Product title or description.' },
          branch: { type: 'string', description: 'Preferred branch name or region (e.g. "Mt Wellington", "Cook St", "Albany").' },
        },
        required: [],
      },
    },
  },
];

// ── UI Tool Names ─────────────────────────────────────────────────────
const UI_TOOL_NAMES = new Set(['setPhase', 'updateQuote', 'researchSchool', 'showItems', 'showGuide', 'showAddons', 'presentChoice', 'showDocuments', 'showInfo', 'showConfigurator', 'generateTeamDesign', 'recommendSize', 'uploadPhotosFor3D', 'buildProjectPlan', 'checkBranchStock']);

// ── Capability registry: project-configurable toolset ─────────────────
const UNIVERSAL_TOOL_NAMES = new Set(['searchKnowledge', 'findRelated', 'getProductOptions', 'findEntity', 'registerEntity', 'requestArtwork', 'checkArtworkApproval', 'setPhase', 'buildProjectPlan', 'checkBranchStock']);

/** Persist a customer-named entity through the BUSINESS port. Provenance is
 *  recorded as customer-stated so nothing here is mistaken for verified fact. */
async function saveEntity(tenantId: string, rawArgs: string): Promise<unknown> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  if (!args?.name) return { ok: false, message: 'A name is required — ask the customer.' };
  try {
    const business = await adapterRegistry.getBusiness(tenantId);
    if (typeof business.registerEntity !== 'function') {
      return { ok: false, message: 'This business cannot save records; carry the details in the conversation instead.' };
    }
    return await business.registerEntity({ tenantId }, args);
  } catch (err) {
    console.error('[AgentService] registerEntity error:', err);
    return { ok: false, message: 'Could not save right now.' };
  }
}

/** Artwork helpers (AUG-16). The agent may ASK for artwork and CHECK approval;
 *  it can never grant approval — that gate belongs to the customer, because it
 *  authorises irreversible printing. */
async function artworkCall(tenantId: string, path: string, body: unknown): Promise<any> {
  const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
  const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenantId,
      'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function requestArtwork(tenantId: string, sessionId: string, rawArgs: string): Promise<unknown> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  const policy =
    'This business does not supply or recreate school, club or league marks — they are trademarked. ' +
    'Ask the customer to upload their own artwork, and to confirm they are entitled to use it.';
  try {
    const onFile = await artworkCall(tenantId, 'artwork/list', { sessionId });
    return {
      uploadRequired: true,
      reason: args.reason || 'Artwork is needed before this order can be proofed.',
      placement: args.placement,
      onFile: onFile.items || [],
      approvedCount: onFile.approvedCount || 0,
      policy,
    };
  } catch {
    return { uploadRequired: true, onFile: [], approvedCount: 0, policy };
  }
}

async function checkArtworkApproval(tenantId: string, sessionId: string): Promise<unknown> {
  try {
    const gate = await artworkCall(tenantId, 'artwork/gate', { sessionId });
    return {
      ...gate,
      instruction: gate.clear
        ? 'Artwork is approved. It is safe to proceed to a final quote.'
        : 'Do NOT present this as production-ready. Tell the customer exactly what is outstanding and ask them to approve the proof. You cannot approve it for them.',
    };
  } catch {
    return { clear: false, reason: 'Could not verify artwork approval — treat as NOT approved and say so.' };
  }
}

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
async function enforceItemDesignability(
  tenantId: string, call: any, designFirst = false,
): Promise<Record<string, unknown> | null> {
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
/** The closest REAL catalogue product for a fabricated card, matched by text
 *  (the name/category the model was trying to show). Lets grounding replace an
 *  invented card with a genuine product instead of dropping it to an empty panel. */
async function findCatalogueMatch(tenantId: string, query: string): Promise<any | null> {
  if (!query || !query.trim()) return null;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ query, limit: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const arr = j?.results || j?.items || (Array.isArray(j) ? j : []);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch { return null; }
}

async function groundItemFacts(tenantId: string, call: any): Promise<void> {
  if (call?.function?.name !== 'showItems') return;
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return; }
  const products = args?.products;
  if (!Array.isArray(products) || !products.length) return;

  const skus = [...new Set(products.map((p: any) => String(p?.sku || '').trim()).filter(Boolean))];
  if (!skus.length) return;

  let payload: any = null;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;   // lookup failed → keep cards untouched (best-effort, never block)
    payload = await res.json();
  } catch {
    return;
  }
  if (!payload) return;

  const items: any[] = payload.items || [];
  const bySku = new Map(items.map((i: any) => [String(i.sku).trim().toUpperCase(), i]));
  /* HALLUCINATION GATE: the pricebook tells us which SKUs the catalogue does NOT
     have (`missing`). A card carrying such a SKU is a fabricated product — e.g.
     the model invented "LN-12345" for a linen shirt even though real linen
     shirts were retrieved — and it must NEVER reach the customer. Drop it. Only
     SKUs the catalogue AUTHORITATIVELY reports missing are dropped (a real SKU
     resolves as `found` even when its price row is thin), so this can't remove a
     genuine item. Prompt rules alone did not hold; this makes it structural. */
  const missing = new Set((payload.missing || []).map((s: any) => String(s).trim().toUpperCase()));
  const usedSkus = new Set<string>();
  let grounded = 0, dropped = 0, substituted = 0;
  const kept: any[] = [];
  for (const p of products as any[]) {
    const key = String(p?.sku || '').trim().toUpperCase();
    if (key && missing.has(key)) {
      // FABRICATED SKU (the catalogue does not have it). Instead of a fake card
      // OR an empty panel (which makes the model wrongly claim "we don't carry
      // it"), swap in the closest REAL product for what the model meant to show.
      const match = await findCatalogueMatch(tenantId, String(p?.name || p?.category || '').trim());
      const mkey = match ? String(match.sku || '').trim().toUpperCase() : '';
      if (match && mkey && !usedSkus.has(mkey)) {
        usedSkus.add(mkey);
        substituted++;
        kept.push({ ...p,
          sku: match.sku,
          name: match.name || p.name,
          price: typeof match.price === 'number' ? match.price : p.price,
          imageUrl: match.imageUrl || match.mainImage || p.imageUrl,
          url: match.url || p.url,
          category: match.category || p.category,
        });
      } else {
        dropped++;   // no real match (or dup) → drop rather than ever show a fake
      }
      continue;
    }
    if (key) usedSkus.add(key);
    const row: any = key ? bySku.get(key) : null;
    if (!row) { kept.push(p); continue; }                      // real (not flagged missing) but thin row → keep
    const g = { ...p };
    if (row.imageUrl) g.imageUrl = row.imageUrl;
    if (typeof row.price === 'number') g.price = row.price;
    if (row.name) g.name = row.name;
    if (row.url) g.url = row.url;
    // ANF-98: the authoritative variant axis rides on the pricebook row now —
    // attach real colour swatches + size pills + rating so the card renders them
    // (the model can't be trusted to carry structured colours through showItems).
    if (Array.isArray(row.colors) && row.colors.length) g.colors = row.colors;
    if (Array.isArray(row.sizes) && row.sizes.length) g.sizes = row.sizes;
    if (row.rating) g.rating = row.rating;
    // ANF-99: real "Wear It With" complete-the-look strip, code-attached (never LLM-authored).
    if (Array.isArray(row.completeTheLook) && row.completeTheLook.length) g.completeTheLook = row.completeTheLook.slice(0, 12);
    if (typeof row.originalPrice === 'number' && row.originalPrice > (row.price || 0)) g.originalPrice = row.originalPrice;
    if (g.imageUrl !== p.imageUrl || g.price !== p.price) grounded++;
    kept.push(g);
  }
  // The live catalogue has many same-named variants; showing two visually identical
  // cards (same name + price + image) reads as broken. Drop exact visual duplicates,
  // keeping the first. Different image/price = a genuinely different variant, kept.
  const seenSig = new Set<string>();
  const deduped = kept.filter((p: any) => {
    // Two cards with the same NAME + PRICE read as a duplicate to a shopper even if
    // their SKU/image differ (the live catalogue lists many same-named variants).
    const sig = `${String(p?.name || '').trim().toLowerCase()}|${p?.price ?? ''}`;
    if (seenSig.has(sig)) return false;
    seenSig.add(sig);
    return true;
  });
  args.products = deduped;
  call.function.arguments = JSON.stringify(args);
  if (grounded || dropped || substituted || deduped.length !== kept.length) {
    console.warn(`[AgentService] showItems: grounded ${grounded}, substituted ${substituted} fabricated→real, dropped ${dropped}, deduped ${kept.length - deduped.length}; ${deduped.length} real card(s)`);
  }
}

async function designableAlternatives(
  tenantId: string, sku: string, limit = 4, likeName?: string,
): Promise<{ sku: string; name?: string; price?: number; image?: string }[]> {
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const headers = { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                      'X-Internal-Key': process.env.INTERNAL_API_KEY || '' };

    // The failed style's own name describes what was wanted; product-service
    // resolves it from the sku so the name never has to travel through here.
    // Except when it CANNOT: an item offered from a text chunk has no product
    // row, so its code resolves to nothing and the lookup came back empty —
    // which sent the caller down the "keep the unprovable items" path. The
    // item's display name is the fallback description of what was wanted.
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/designable`, {
      method: 'POST', headers,
      body: JSON.stringify(sku ? { likeSku: sku, limit } : { like: likeName || '', limit }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return ((await res.json())?.items || [])
      .map((i: any) => ({ sku: i.sku, name: i.name, price: i.price, image: i.image }));
  } catch {
    return [];
  }
}

async function validateDesign(tenantId: string, call: any, configuratorType?: string): Promise<Record<string, unknown>> {
  if (call?.function?.name !== 'showConfigurator') return { success: true };
  // A candy configurator has no server-side mesh to render — the disc is
  // composited client-side from config. Running the garment renderer here would
  // return not-renderable and make the agent apologise over a panel that opened
  // fine. The design step itself enforces the print rules (shells, 2×9 text),
  // so the open IS the success.
  if (configuratorType === 'candy') {
    return { success: true, note: 'The candy designer is open — the customer is personalising it now. Do NOT say there was a problem; invite them to pick colours and a message, then build the quote.' };
  }
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { success: true }; }
  if (!args.sku) return { success: true, note: 'No style specified.' };

  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId },
      body: JSON.stringify({
        style: args.sku,
        designLine: args.designLine,
        colours: [args.baseColor, args.accentColor].filter(Boolean),
        text: { teamName: args.name, number: args.number },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { success: true };
    const r: any = await res.json();

    const available: string[] = (r.designLines || []).map((d: any) => d.slug);
    const rejected: string[] = r.rejectedColours || [];
    const out: Record<string, unknown> = { success: !!r.renderable };
    let corrected = false;

    // A design line the style does not offer leaves its layer hidden, so the
    // garment renders blank. Substituting silently would be its own lie, so the
    // correction is reported back and the model must mention it.
    if (args.designLine && available.length
        && !available.includes(String(args.designLine).toLowerCase())) {
      out.designLineRejected = args.designLine;
      out.availableDesignLines = available;
      delete args.designLine;
      corrected = true;
    }
    if (!args.designLine && available.length) {
      /* The renderer no longer ships a blank garment when no design line is
       * named — it applies the style's widest one so the customer's colours are
       * actually visible. Telling the model "no design line was applied" while
       * the panel shows one produces a description that contradicts the screen,
       * which is the failure this whole validation exists to prevent. */
      if (r.appliedDesignLine) {
        out.designLineDefaulted = r.appliedDesignLine;
        out.availableDesignLines = available;
      } else {
        out.designLineMissing = true;
        out.availableDesignLines = available;
      }
    }
    /* Zones that reused a colour because the design has more zones than the
     * customer named. Not an error — but they should be told, so they can pick
     * a distinct colour for each rather than discover the repeat on delivery. */
    if (r.zonesFilledByRepeat) out.zonesReusingAColour = r.zonesFilledByRepeat;

    if (rejected.length) {
      out.coloursNotStocked = rejected;
      // Drop them rather than let Scene7 substitute — an unknown colour renders
      // black, which the customer never asked for.
      for (const key of ['baseColor', 'accentColor']) {
        if (rejected.some((c) => String(args[key] || '').toUpperCase() === c.toUpperCase())) {
          delete args[key]; corrected = true;
        }
      }
    }

    if (!r.renderable) {
      out.previewUnavailable = true;
      out.showingInstead = r.catalogueImage ? 'catalogue photograph' : 'nothing';

      /* Saying "this one cannot be previewed" is honest and useless. The style
       * was almost certainly a STOCK garment — retrieval ranks on text, which
       * cannot tell a made-to-order jersey from a fixed-colourway one, so a
       * custom team request lands on a style that can never wear the team's
       * colours. Offer styles proven designable instead, so the customer is
       * steered to something that works rather than left at a dead end. */
      const alternatives = await designableAlternatives(tenantId, args.sku);
      if (alternatives.length) out.designableAlternatives = alternatives;
    }

    if (corrected) {
      // The note was written BEFORE validation, so it still describes the design
      // the model intended — "in maroon and gold with the center field design".
      // Left alone it becomes the panel's caption and contradicts the garment
      // actually shown, which is the same lie in a different place.
      args.note = 'Some of what you asked for is not available on this style — see the note below.';
      call.function.arguments = JSON.stringify(args);
    }

    out.instruction =
      out.designableAlternatives
        ? 'This style CANNOT be custom-designed — it is a stock garment, so the team colours can never '
          + 'be applied to it. Do not offer to proceed with it and do not apologise for a technical '
          + 'fault. Name one or two of the designable styles listed above and ask which they want.'
        : (out.designLineRejected || out.coloursNotStocked || out.previewUnavailable || out.designLineMissing)
          ? 'Do NOT tell the customer this design is ready. Say plainly what could not be applied and '
            + 'offer them a real alternative from the lists above, then wait for their choice.'
          : out.designLineDefaulted
            ? `The garment on screen is wearing the "${out.designLineDefaulted}" design line, chosen `
              + 'because none was named. Say which design line they are looking at and offer the '
              + 'alternatives above — do NOT say a design line was not applied, because one was.'
            : 'The design rendered as described.';
    return out;
  } catch {
    // Best-effort: a validation hiccup must not block the render.
    return { success: true };
  }
}

/**
 * A confirmed programme's colours (AUG-27).
 *
 * Delegated so the model never states colours from memory: the service decides
 * whether they are confirmed, merely proposed, or unknown, and maps them onto
 * what the brand can actually print.
 */
async function getTeamColours(tenantId: string, rawArgs: string): Promise<unknown> {
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
async function readRoster(tenantId: string, rawArgs: string): Promise<unknown> {
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
async function lookupEntities(tenantId: string, rawArgs: string): Promise<unknown> {
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
async function skusThatExist(tenantId: string, tokens: string[]): Promise<string[]> {
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

async function resolveSkuByName(tenantId: string, nameOrSku: string): Promise<string> {
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    const r: any = await port.search({ tenantId }, { query: nameOrSku, type: 'product', limit: 3 });
    const hit = (r?.results || []).find((p: any) => p?.sku);
    return hit?.sku ? String(hit.sku) : '';
  } catch {
    return '';
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
async function resolveQuoteItemSkus(tenantId: string, items: any[]): Promise<any[]> {
  return Promise.all((items || []).map(async (it: any) => {
    const sku = String(it?.sku || '').trim();
    if (!sku || !/\s/.test(sku)) return it;           // already a code
    const resolved = await resolveSkuByName(tenantId, sku);
    return resolved ? { ...it, sku: resolved, quotedAs: sku } : it;
  }));
}

/**
 * CDL: read a customer's attached design image and match it to the template
 * library. The image never touches the LLM prompt — it's held server-side for
 * the turn and passed here. Delegates the vision + match to product-service's
 * /cdl/analyze (same engine as the standalone CDL studio), then trims the
 * response to what the model needs to drive the next step (decision + the style
 * code to design on + the colours it read).
 */
async function analyzeDesign(
  tenantId: string,
  image: { imageBase64?: string; imageUrl?: string },
  rawArgs: string,
): Promise<unknown> {
  if (!image?.imageBase64 && !image?.imageUrl) {
    return { ok: false, message: 'No design image is attached to this turn. Ask the customer to upload their design, or describe it so we can generate one.' };
  }
  let sizes: string[] | undefined;
  try { const a = JSON.parse(rawArgs || '{}'); if (Array.isArray(a?.sizes)) sizes = a.sizes; } catch { /* optional */ }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId,
                 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ imageBase64: image.imageBase64, imageUrl: image.imageUrl, sizes }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, message: 'The design analyser is unavailable right now. Try again in a moment.' };
    const j: any = await res.json();
    const a = j?.analysis || {};
    const m = j?.match || {};
    // The matcher wraps each hit as { score, template: {...} } — the style code
    // lives on best.template, not best directly.
    const bestT = m?.best?.template || m?.best;
    // FAITHFUL PROOF (Path A): parametric colour zones cannot reproduce an all-
    // over artwork / logo (Rink Rippers renders as muddy stripes). So when the
    // customer UPLOADED a design and it matched a make-able style, composite their
    // actual artwork onto that style's garment via image-gen — the proof then
    // looks like their design. Best-effort: a failure just omits the proof.
    let proofId: string | null = null;
    if (m?.decision === 'use' && bestT?.parentSku && (image.imageBase64 || image.imageUrl)) {
      try {
        const pr = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ sku: bestT.parentSku, artworkBase64: image.imageBase64, artworkUrl: image.imageUrl }),
          signal: AbortSignal.timeout(90000),
        });
        if (pr.ok) { const pj: any = await pr.json(); proofId = pj?.proofId || null; }
      } catch { /* proof is best-effort */ }
    }
    return {
      ok: true,
      decision: m?.decision || (bestT ? 'use' : 'create'),   // 'use' | 'create'
      design: {
        sport: a.sport, garmentType: a.garmentType, division: a.division,
        colours: a.colors || [], keywords: a.keywords || [],
        elements: a.elements || {},       // { logo, name, number, allOverPattern }
        summary: a.summary,
      },
      // On 'use' → the real style code to hand to showConfigurator.
      template: bestT?.parentSku ? { sku: bestT.parentSku, name: bestT.name, sizes: bestT.sizes } : null,
      // Deterministic configurator config (colours mapped to the palette + text) —
      // the server, not the model, decides how the design renders (colour fix).
      suggestedConfig: j?.suggestedConfig || null,
      // Faithful proof image id (their artwork on our garment) — shown big.
      proofId,
      // A couple of alternates the model can offer if the customer dislikes the top match.
      alternates: (m?.results || []).slice(1, 4)
        .map((r: any) => r?.template || r)
        .filter((t: any) => t?.parentSku)
        .map((t: any) => ({ sku: t.parentSku, name: t.name })),
    };
  } catch (err) {
    console.error('[AgentService] analyzeDesign error:', err);
    return { ok: false, message: 'Could not analyse the design right now.' };
  }
}

/**
 * CDL "design it in chat" (Door A): generate a jersey concept from the
 * customer's brief (nano-banana via product-service), then analyse + match it to
 * a make-able template — the same use/create decision as an upload. The concept
 * image itself never enters the LLM prompt (it's ~1–2MB); we return a short
 * conceptId the panel fetches, plus the decision/design/template the model needs.
 */
async function generateDesign(tenantId: string, rawArgs: string): Promise<any> {
  let brief = ''; let sizes: string[] | undefined;
  try { const a = JSON.parse(rawArgs || '{}'); brief = String(a?.brief || '').trim(); if (Array.isArray(a?.sizes)) sizes = a.sizes; } catch { /* */ }
  if (!brief) return { ok: false, message: 'Ask the customer to describe the design (colours, team, number, style).' };
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/design`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ brief, sizes }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, message: 'The design generator is busy right now — try again in a moment.' };
    const j: any = await res.json();
    const a = j?.analysis || {};
    const m = j?.match || {};
    const bestT = m?.best?.template || m?.best;
    return {
      ok: true,
      conceptId: j?.conceptId || null,           // panel fetches the concept image by this id
      decision: m?.decision || (bestT ? 'use' : 'create'),
      design: {
        sport: a.sport, garmentType: a.garmentType, division: a.division,
        colours: a.colors || [], keywords: a.keywords || [], elements: a.elements || {}, summary: a.summary,
      },
      template: bestT?.parentSku ? { sku: bestT.parentSku, name: bestT.name, sizes: bestT.sizes } : null,
      suggestedConfig: j?.suggestedConfig || null,
      alternates: (m?.results || []).slice(1, 4).map((r: any) => r?.template || r).filter((t: any) => t?.parentSku).map((t: any) => ({ sku: t.parentSku, name: t.name })),
    };
  } catch (err) {
    console.error('[AgentService] generateDesign error:', err);
    return { ok: false, message: 'Could not generate the design right now.' };
  }
}

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
async function generateTeamDesign(
  tenantId: string,
  image: { imageBase64?: string; imageUrl?: string } | undefined,
  rawArgs: string,
): Promise<any> {
  let brief = ''; let sourceId = ''; let sku = '';
  try {
    const a = JSON.parse(rawArgs || '{}');
    brief = String(a?.brief || '').trim();
    sourceId = String(a?.sourceId || '').trim();
    sku = String(a?.sku || '').trim();
  } catch { /* */ }
  if (!brief && !sourceId && !image?.imageBase64 && !image?.imageUrl) {
    return { ok: false, message: "Ask the coach to describe the team's look (sport, colours, garment, lettering), or attach the team logo." };
  }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/flat-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        brief,
        ...(sourceId ? { sourceId } : {}),
        ...(image?.imageBase64 ? { artworkBase64: image.imageBase64 } : {}),
        ...(image?.imageUrl ? { artworkUrl: image.imageUrl } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, message: 'The team design generator is busy right now — try again in a moment.' };
    const j: any = await res.json();
    if (!j?.ok) return { ok: false, message: j?.message || 'Could not generate the team views right now.' };
    return {
      ok: true,
      frontId: j.frontId, backId: j.backId, leftId: j.leftId, rightId: j.rightId,
      frontError: j.frontError, backError: j.backError, leftError: j.leftError, rightError: j.rightError,
      brief,
      ...(sku ? { sku } : {}),
      instruction: 'The four views (front/back/left/right, whichever generated) are now shown to the coach. Tell them briefly what is shown and invite them to approve or ask for a change. The panel itself offers the "approve, go to roster" step — you do not need another tool call for that.',
    };
  } catch (err) {
    console.error('[AgentService] generateTeamDesign error:', err);
    return { ok: false, message: 'Could not generate the team design right now.' };
  }
}

/** uploadPhotosFor3D is deliberately server-thin: the actual bake happens
 *  CLIENT-SIDE in PhotoUploadDesignPanel once the customer submits their real
 *  photos (POST /api/cdl/bake3d, not this function). This tool's only job is
 *  to hand back an ok:true so the UI dispatch layer opens the upload panel —
 *  mirrors generateTeamDesign's dispatch-then-uiAction shape without the
 *  network round trip generateTeamDesign needs (there is no server-side
 *  generation step here, just a phase switch). */
async function uploadPhotosFor3D(rawArgs: string): Promise<any> {
  let sku = '';
  try {
    const a = JSON.parse(rawArgs || '{}');
    sku = String(a?.sku || '').trim();
  } catch { /* */ }
  return {
    ok: true,
    ...(sku ? { sku } : {}),
    instruction: 'The real-photo upload panel is now shown to the customer. They will upload up to 4 real photos (front required) of their actual garment and the 3D bake runs when they submit — you do not do anything further here; just tell them briefly the panel is open and to add their photos.',
  };
}

/** CDL: submit the current design for artist review (the production-authority
 *  gate). The artist signs off before anything prints; the agent can never
 *  approve for them. */
async function submitForReview(tenantId: string, sessionId: string, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  const kind = args?.kind === 'create' ? 'create' : 'use';
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ sessionId, kind, sku: args?.sku, summary: args?.summary, sizes: args?.sizes }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: 'Could not submit for review right now.' };
    const j: any = await res.json();
    return {
      ok: true, jobId: j.jobId, status: j.status, kind,
      instruction: kind === 'create'
        ? 'Submitted as a NEW design. Tell the customer our artist will generate the cut pieces at every size and finalise it, then you will confirm once approved. Do NOT promise a timeline you were not given.'
        : 'Submitted to the artist for a production check. Tell the customer it is with our artist and you will confirm once approved. Do NOT call it production-ready yourself.',
    };
  } catch (err) {
    console.error('[AgentService] submitForReview error:', err);
    return { ok: false, message: 'Could not submit for review right now.' };
  }
}

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
async function submitTeamOrder(tenantId: string, sessionId: string, journeyState: any, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  const sku = String(args?.sku || journeyState?.activeSku || '').trim() || undefined;
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ sessionId, kind: 'use', sku, summary: args?.summary }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: 'Could not submit the team order right now.' };
    const j: any = await res.json();
    return {
      ok: true, jobId: j.jobId, status: j.status,
      instruction: 'Submitted the team order to our artist. Tell the coach it is with our artist and you will confirm once approved — do NOT call it production-ready yourself. If the roster or design views look incomplete on the artist side, tell the coach to use the "Submit team order" button on the 3D preview instead, which carries the full roster.',
    };
  } catch (err) {
    console.error('[AgentService] submitTeamOrder error:', err);
    return { ok: false, message: 'Could not submit the team order right now.' };
  }
}

/** CDL: report where the design sits in artist review. The customer may only be
 *  invited to agree once the artist has approved; neither gate acts for the other. */
async function checkReviewStatus(tenantId: string, sessionId: string): Promise<any> {
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/cdl/reviews?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, message: 'Could not check the review status.' };
    const j: any = await res.json();
    const latest = (j.reviews || []).slice(-1)[0];
    if (!latest) return { ok: true, status: 'none', instruction: 'No design has been submitted for review yet. Submit one with submitForReview once the customer is happy.' };
    const map: Record<string, string> = {
      pending_artist: 'Still with our artist for review — tell the customer honestly it is being checked; do NOT say it is ready.',
      changes_requested: `Our artist asked for changes${latest.artist?.notes ? ` (${latest.artist.notes})` : ''} — relay this and help the customer revise.`,
      artist_approved: 'The artist has APPROVED the proof. Invite the customer to AGREE to it so it can go to print — you cannot agree for them.',
      customer_agreed: 'The customer has agreed; it is being finalised for print.',
      ready_for_print: 'Approved by artist AND agreed by the customer — it is READY FOR PRINT. Proceed to quote/checkout.',
    };
    return { ok: true, jobId: latest.jobId, status: latest.status, kind: latest.kind, instruction: map[latest.status] || 'Report the status honestly.' };
  } catch (err) {
    console.error('[AgentService] checkReviewStatus error:', err);
    return { ok: false, message: 'Could not check the review status.' };
  }
}

/**
 * Fitment guide (v1): call product-service's `/sizing/recommend`, which is
 * backed by SizingService's real per-tenant size-chart lookup (never an LLM
 * guess). Mirrors analyzeDesign's fetch shape/error handling exactly.
 */
async function recommendSize(tenantId: string, rawArgs: string): Promise<any> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* */ }
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/sizing/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({
        category: args?.category,
        usualSize: args?.usualSize,
        waistIn: typeof args?.waistIn === 'number' ? args.waistIn : undefined,
        chestIn: typeof args?.chestIn === 'number' ? args.chestIn : undefined,
        division: args?.division,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: 'The sizing guide is unavailable right now.' };
    const data: any = await res.json();
    /* State the number this returns, verbatim — nothing else (2026-08-24 live
     * finding). A prior version of this result had no such instruction: the
     * model received `recommendedSize:"34"` and still told the customer "36,"
     * inventing a stretch-fabric justification the real size chart says
     * nothing about. The tool firing correctly is not enough on its own — the
     * same "settle it in code" lesson as enforceItemDesignability, applied to
     * a text answer instead of a UI render. */
    return {
      ...data,
      instruction: data.recommendedSize
        ? `State the size as exactly "${data.recommendedSize}" — do not round up or down, and do not invent a reason (stretch fabric, fit style, etc.) not present in this result.`
        : 'No real size chart data matched — say plainly you cannot confirm a size for this yet. Do not guess one.',
    };
  } catch (err) {
    console.error('[AgentService] recommendSize error:', err);
    return { ok: false, message: 'Could not look up a size recommendation right now.' };
  }
}

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

function handleBuildProjectPlan(rawArgs: string): any {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  const projectType = String(args.projectType || 'decking').toLowerCase();
  if (projectType === 'fencing') {
    return ProjectCalculatorService.calculateFencing(args.lengthM || 15, args.heightM || 1.8, args.material || 'Timber Palings');
  }
  if (projectType === 'lining') {
    return ProjectCalculatorService.calculateWallLining(args.areaM2 || 35, args.material || 'GIB Standard 10mm');
  }
  // Default to decking
  return ProjectCalculatorService.calculateDecking(args.lengthM || 4, args.widthM || 3, args.material || 'Kwila', args.heightM || 0.4);
}

function handleCheckBranchStock(rawArgs: string): any {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  return BranchStockService.getStockForSku(args.sku || 'PM-TIMBER-100', args.productTitle || 'Building Material / Tool', args.branch);
}

async function lookupOptions(tenantId: string, rawArgs: string): Promise<unknown> {
  let sku = '';
  try { sku = String(JSON.parse(rawArgs || '{}').sku || '').trim(); } catch { /* fall through */ }
  if (!sku) return { found: false, message: 'No item code supplied.' };
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    if (typeof port.options !== 'function') {
      return { found: false, sku, message: 'Option data is not available for this catalogue.' };
    }
    let r = await port.options({ tenantId }, sku);
    // Not found by code → the caller probably passed a product NAME. Resolve and retry once.
    if (!r.found) {
      const resolved = await resolveSkuByName(tenantId, sku);
      if (resolved && resolved !== sku) {
        const r2 = await port.options({ tenantId }, resolved);
        if (r2.found) return { ...r2, sku: resolved, resolvedFrom: sku };
      }
    }
    return r.found
      ? r
      : { found: false, sku, message: `No per-variant colour/size list is recorded for ${sku}. Do NOT tell the customer you "couldn't retrieve" or "failed to find" anything — that reads as a broken feature. Instead, describe the item's known details (fabric, fit, materials, care) confidently, and if they want a specific colour or size, say it can be confirmed at checkout. Never invent specific colours or sizes you have not verified.` };
  } catch (err) {
    console.error('[AgentService] getProductOptions error:', err);
    return { found: false, sku, message: 'Option lookup failed.' };
  }
}

/** Resolve a findRelated tool call through the KnowledgePort. Shared by the
 *  streaming and non-streaming dispatch paths so they cannot drift. Always
 *  returns a shape the model can read — including an explicit "nothing known"
 *  so it states that instead of inventing a matching item code. */
async function lookupRelated(tenantId: string, rawArgs: string): Promise<unknown> {
  let sku = '';
  try { sku = String(JSON.parse(rawArgs || '{}').sku || '').trim(); } catch { /* fall through */ }
  if (!sku) return { found: false, message: 'No item code supplied.' };
  try {
    const port = await adapterRegistry.getKnowledge(tenantId);
    if (typeof port.related !== 'function') {
      return { found: false, sku, message: 'Relationship data is not available for this catalogue.' };
    }
    let r = await port.related({ tenantId }, sku);
    let found = !!(r.collections.length || r.outfittingSets.length || r.sizingGroup);
    // Same name-vs-code trap as getProductOptions — resolve a product NAME once.
    if (!found) {
      const resolved = await resolveSkuByName(tenantId, sku);
      if (resolved && resolved !== sku) {
        const r2 = await port.related({ tenantId }, resolved);
        if (r2.collections.length || r2.outfittingSets.length || r2.sizingGroup) {
          return { found: true, ...r2, sku: resolved, resolvedFrom: sku };
        }
      }
    }
    return found
      ? { found: true, ...r }
      : { found: false, sku, message: `No collection, coordinating set or alternate-size version is recorded for ${sku}. Say so plainly — do not infer or construct one.` };
  } catch (err) {
    console.error('[AgentService] findRelated error:', err);
    return { found: false, sku, message: 'Relationship lookup failed.' };
  }
}
const CAPABILITY_TO_TOOL: Record<string, string | string[]> = {
  products: 'showItems',
  steps: 'showGuide',
  quote: 'updateQuote',
  accessories: 'showAddons',
  choice: 'presentChoice',
  installGuide: 'showDocuments',
  warranty: 'showInfo',
  configurator: 'showConfigurator',
  roster: 'readRoster',
  teamColours: 'getTeamColours',
  // CDL "design line": both front doors — analyse an uploaded design AND generate
  // one from a description — the configurator to render the matched template, and
  // the artist-review gate (submit + status) that guards production.
  customDesign: ['analyzeDesign', 'generateDesign', 'showConfigurator', 'submitForReview', 'checkReviewStatus'],
  // Coach team-order journey (Wednesday thin slice) — a NEW, separate capability
  // key rather than folding into customDesign, so it's Augusta-only opt-in and
  // never changes what other tenants' agents can call.
  teamOrder: ['generateTeamDesign', 'submitTeamOrder'],
  // Real-photo 3D match — upload up to 4 REAL photos of an actual garment and
  // bake them onto the real 3D mesh. A separate, new capability (not folded
  // into customDesign/teamOrder) so it stays an explicit per-tenant opt-in —
  // today only Augusta, since it needs a renderable style with a real mesh.
  photoUpload3D: 'uploadPhotosFor3D',
  // Fitment guide (v1) — sizing questions + a size recommendation grounded in a
  // real per-tenant size chart. Opt-in per tenant: only enabled where we have
  // verified real size data (see SizingService for the grounding notes).
  fitmentGuide: 'recommendSize',
};
/** Every capability id an admin can enable (used by the back office to render toggles). */
export const AVAILABLE_CAPABILITIES = Object.keys(CAPABILITY_TO_TOOL);

/** Assemble this turn's toolset from the project's enabled capabilities.
 *  Empty/undefined → all tools (back-compat for projects not yet configured). */
export function buildToolset(enabled?: string[], entityModel?: { label?: string; labelPlural?: string }): OpenAI.ChatCompletionTool[] {
  const allow = new Set(UNIVERSAL_TOOL_NAMES);
  if (enabled?.length) for (const cap of enabled) {
    const t = CAPABILITY_TO_TOOL[cap];
    if (Array.isArray(t)) t.forEach((x) => allow.add(x));
    else if (t) allow.add(t);
  }
  const picked = enabled?.length
    ? tools.filter((t) => t.type !== 'function' || allow.has(t.function.name))
    : tools;

  /* Render the entity tools in THIS business's vocabulary — a teamwear tenant
   * asks about a "team", a bathroom tenant a "room". Falls back to a neutral
   * word so the tools stay coherent for a business that hasn't configured one. */
  const label = entityModel?.label || 'organisation';
  const plural = entityModel?.labelPlural || `${label}s`;
  return picked.map((t) => {
    if (t.type !== 'function') return t;
    const raw = JSON.stringify(t.function);
    if (!raw.includes('{ENTITY')) return t;
    const filled = raw.split('{ENTITY_PLURAL}').join(plural).split('{ENTITY}').join(label);
    return { ...t, function: JSON.parse(filled) };
  });
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
  /** Observable reasoning trace for the right-hand panel (additive). */
  trace?: TraceEntry[];
}

@Injectable()
export class AgentService {
  private openai: OpenAI;
  private intentResolver: IntentResolver;
  private configLoader: ConfigLoader;
  private sessionStore: SessionStore;
  private quoteService: QuoteService;
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
   * "answer the questions on the right" to a customer who had asked to look at
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
    tenantId: string, conversation: any[], journeyState: any, projectConfig: any,
  ): Promise<void> {
    const caps = projectConfig?.capabilities;
    if (caps?.length && !caps.includes('configurator')) return;
    const lastUser = [...(conversation || [])].reverse().find((m: any) => m.role === 'user');
    const code = this.namedStyleCode(String(lastUser?.content || ''));
    if (!code || journeyState?.activeSku === code) return;
    const found = await skusThatExist(tenantId, [code.toUpperCase()]);
    if (!found.includes(code.toUpperCase())) return;  // not a style here — say nothing
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
    this.openai = new OpenAI();
    this.intentResolver = new IntentResolver(this.openai, this.model);
    this.configLoader = new ConfigLoader();
    this.sessionStore = new SessionStore();
    this.quoteService = new QuoteService();
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
    opts: { customised?: boolean; capabilities?: string[] } = {},
  ): 'showItems' | 'showGuide' | 'showConfigurator' | null {
    // Customer explicitly said "don't render yet" / "just tell me what to look for" —
    // honour that by keeping the panel blank this turn.
    if (intent.panelRenderBlocked) return null;
    const rt = intent.retrievalType;
    const productish = intent.stage === 'products' || rt === 'product' || rt === 'design' || rt === 'collection';
    const canConfigure = !!opts.customised
      && (!opts.capabilities?.length || opts.capabilities.includes('configurator'));
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
            content: `Before you answer, you MUST call ${toolName} to render ${what} on the right panel, ${source}. Do not answer in text only.`,
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
          // ...and the catalogue, not the model, states what each card shows.
          await groundItemFacts(tenantId, call);
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
          if (verdict.designableAlternatives) {
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
    const { tenantId = 'caroma' } = request;
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
    const configBlock = this.configLoader.renderConfigBlock(projectConfig);
    // High-level orientation so the agent starts knowing who this business is
    // (AUG-14). Cached; never blocks the turn.
    const brandHubProfile = await this.configLoader.loadBrandHub(tenantId);
    const brandHubBlock = this.configLoader.renderBrandHubBlock(brandHubProfile, projectConfig.capabilities, projectConfig);
    trace.push({ step: 'config', detail: `model=${model} · configV=${projectConfig.configVersion ?? 'draft'}${projectConfig.journeyGuidance ? ' · +journeyGuidance' : ''}` });

    // ── Step 1: Intent detection (config-driven, no keyword routing) ──
    // Pass the project's configured context dimensions so classification (and
    // downstream retrieval scoping) is bounded by what THIS business serves.
    const intent = await this.intentResolver.resolve(messages, state, this.intentModel, projectConfig.contextDimensions);
    const dimStr = Object.entries(intent.dimensions || {}).map(([k, v]) => `${k}=${v}`).join(',') || '—';
    trace.push({
      step: 'intent',
      detail: `${intent.intent} · dims=${dimStr} · space=${intent.space} · stage=${intent.stage} · mode=${intent.mode} · confidence=${intent.confidence}`,
      data: intent,
    });

    // ── Load back-office business rules (config over code) ──
    const activeRules = await this.configLoader.loadActiveRules(tenantId);
    const rulesBlock = this.configLoader.renderRulesBlock(activeRules);
    trace.push({
      step: 'config-rules',
      detail: activeRules.length ? `${activeRules.length} active rule(s) loaded` : 'no rules configured',
      data: activeRules.map((r) => r.name),
    });

    // ── Step 3: Retrieval routing (don't fetch PDFs during discovery) ─
    const policy = buildRetrievalPolicy(intent);
    trace.push({
      step: 'retrieval-policy',
      detail: policy.allowRetrieval ? `allow [${policy.allowedTypes.join(', ')}]` : 'no retrieval (discovery — ask first)',
    });

    // ENFORCEMENT (not advice): when retrieval is disallowed this turn, remove
    // searchKnowledge from the tool set so the model physically cannot call it.
    const projectTools = buildToolset(projectConfig.capabilities, brandHubProfile?.entityModel);
    const activeTools = policy.allowRetrieval
      ? projectTools
      : projectTools.filter((t) => t.type !== 'function' || t.function.name !== 'searchKnowledge');

    // ── Journey working-memory block (server-owned; the loop guard) ──────────
    // Replaces the thin, client-supplied state string. Tells the model exactly
    // what has been completed/presented so it never re-asks or re-offers.
    const stateContext = renderJourneyStateBlock(journeyState);

    // Transcript is already bounded by the memory layer (recent turns; the
    // journey block carries durable facts). No client-side compaction needed.
    const activeMessages = messages;

    // Intent + retrieval guidance injected as a system message so the generation
    // step follows the policy (mode + what it may retrieve this turn).
    const intentGuidance =
      `[TURN GUIDANCE]\n- Detected intent: ${intent.intent} (stage: ${intent.stage}, mode: ${intent.mode})\n` +
      `- Missing context: ${intent.missingInfo.length ? intent.missingInfo.join(', ') : '(none)'}\n` +
      `- ${policy.guidance}`;

    // ── Build Conversation Array ────────────────────────────────────
    // System prompt is assembled per-turn: base + mode(business|technical) + stage.
    const conversation: any[] = [
      { role: 'system', content: assembleSystemPrompt(intent.mode, intent.stage) },
      ...(brandHubBlock ? [{ role: 'system', content: brandHubBlock }] : []),
      ...(configBlock ? [{ role: 'system', content: configBlock }] : []),
      ...(rulesBlock ? [{ role: 'system', content: rulesBlock }] : []),
      ...(stateContext ? [{ role: 'system', content: stateContext }] : []),
      { role: 'system', content: intentGuidance },
      ...(journeyState?.activeSku && !hasDesignImage ? [{ role: 'system', content:
        `[DESIGN ALREADY ON THE PANEL] The customer is already looking at their design on style ${journeyState.activeSku}. IGNORE any "discovery — ask first" guidance above and do NOT re-onboard — never ask which school/team/sport/gender/colours when a design is already shown. Answer the customer's actual question about the design in front of them: tweak colours/name/number, explain what they see, or offer to send it to the artist. ` +
        `If they ask "where is the 3D" or "why is it my exact image": the panel is showing THEIR design reproduced on our garment — a faithful proof, the accurate preview for a full custom all-over print. Be honest that it is a proof image (not a spinnable 3D); interactive 3D spin only applies to simpler template designs, and the artist finalises the print file. Do not claim it is "3D".` }] : []),
      ...(hasDesignImage ? [{ role: 'system', content:
        '[CUSTOM DESIGN ATTACHED] The customer attached a design image this turn. FIRST call analyzeDesign to read the garment and match it to our make-able template library. ' +
        'If it returns decision "use", call showConfigurator with template.sku and the analysed colours. The panel shows their design REPRODUCED on our garment as a faithful PROOF — tell them "here is your design on our <style>" and that we make this style; call it a proof/preview, do NOT call it "3D". ' +
        'If it returns decision "create", warmly tell them it is a brand-new design — we will generate the cut pieces at their sizes and an artist will finalise it — and do NOT invent a style code or call showConfigurator.' }] : []),
      ...((projectConfig.capabilities || []).includes('customDesign') && !hasDesignImage ? [{ role: 'system', content:
        '[YOU CAN DESIGN] This brand can DESIGN a custom garment for the customer — you are their designer. ' +
        'When the customer DESCRIBES a look they want created/made (colours, team, number, style, vibe) — "design me a…", "can you make a…", "create a…" — call generateDesign with their brief FIRST; do NOT answer with searchKnowledge/showItems catalogue cards. ' +
        'Only use searchKnowledge/showItems when they want to BROWSE existing products. Iterations ("make the sleeves brighter") → generateDesign again. ' +
        'When the customer is happy or says "send it to your artist/for review", call submitForReview (kind "use" or "create"); when they ask "is it ready?", call checkReviewStatus. A custom design needs artist approval AND customer agreement before print — never call it production-ready yourself.' }] : []),
      ...activeMessages
    ];

    const maxLoops = 6;
    const MAX_SEARCHES = 6;          // collection + core fixtures need multiple searches
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
    const wantUiTool = this.requiredUiTool(intent, { customised: brandHubProfile?.model?.customised, capabilities: projectConfig.capabilities });

    // Mandatory opening move: research the named org before the model acts.
    // When it researches THIS turn, the colour-confirmation card owns the panel —
    // suppress a same-turn clarify so the model can't bury it under a question form.
    this.noteTeamSize(conversation, journeyState);
    this.noteShownItems(conversation, journeyState);
    await this.noteNamedStyle(tenantId, conversation, journeyState, projectConfig);
    const researchedThisTurn = await this.maybeResearchOrg(tenantId, projectConfig, intent, journeyState, conversation, uiToolCalls);
    await maybeForceSizeRecommendation(tenantId, conversation, activeTools, projectConfig.capabilities, uiToolCalls, () => {}, model, llm);

    // ── Step 5: Generation — controlled tool-calling loop ───────────
    while (loops < maxLoops) {
      loops++;
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
        const effWantUi = cdlUseSku ? 'showConfigurator' : wantUiTool;
        if (!forceText && !researchedThisTurn && (hadRetrieval || effWantUi === 'showConfigurator') && effWantUi && !forcedUi &&
            !intent.panelRenderBlocked &&
            !uiToolCalls.some((c) => c.function?.name === effWantUi)) {
          forcedUi = true;
          trace.push({ step: 'forced-ui', detail: `${effWantUi}${cdlUseSku ? ` (CDL match ${cdlUseSku})` : ''} (model answered in prose)` });
          await this.forceUiTool(tenantId, conversation, activeTools, effWantUi, uiToolCalls, () => {}, model, llm, journeyState, !!brandHubProfile?.model?.customised, projectConfig.configuratorType);
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
            || call.function.name === 'buildProjectPlan' || call.function.name === 'checkBranchStock') {
          hadRetrieval = true;
          const result = call.function.name === 'buildProjectPlan'
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
          if (cdlUseSku && !forcedUi && !intent.panelRenderBlocked &&
              !uiToolCalls.some((c) => c.function?.name === 'showConfigurator')) {
            forcedUi = true;
            if (cdlSuggested?.sku) {
              // Colour fix: server-built config (all analysed colours mapped to the
              // style palette), not model-built — the buffered path returns
              // uiToolCalls directly, so no emit is needed.
              trace.push({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku}, server config)` });
              uiToolCalls.push({ id: `cdl_${cdlUseSku}`, type: 'function', function: { name: 'showConfigurator', arguments: JSON.stringify(cdlSuggested) } } as any);
              conversation.push({ role: 'system', content: `[RENDERED] The customer's design is already on the right in their colours on style ${cdlUseSku}. Do NOT call showConfigurator again this turn; tell them it's shown and invite tweaks or sending it to the artist.` });
            } else {
              trace.push({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku})` });
              await this.forceUiTool(tenantId, conversation, activeTools, 'showConfigurator', uiToolCalls, () => {}, model, llm, journeyState, !!brandHubProfile?.model?.customised, projectConfig.configuratorType);
            }
          }
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
            const toolResult = await (await adapterRegistry.getKnowledge(tenantId)).search(
              { tenantId },
              // Gender is injected SERVER-SIDE from the resolved intent (not the model) so
              // a "men's" journey never surfaces women's products — hard filter, not a hint.
              { query: args.query, type: args.type, category: args.category, limit: 8, gender: intent?.dimensions?.gender },
            );
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(await markDesignable(tenantId, toolResult)),
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
            // A team order priced at quantity 1 is money-wrong and looks authoritative.
            // The engine multiplies correctly; it just defaults missing quantity to 1.
            // Refuse to build it rather than ship a confident wrong total.
            const _size = Number(journeyState.teamSize) || 0;
            const _items = Array.isArray(parsedArgs.items) ? parsedArgs.items : [];
            if (_size > 1 && _items.length && _items.every((it: any) => (Number(it.quantity) || 1) <= 1)) {
              conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
                success: false, quantityMissing: true,
                message: `The customer needs ${_size} pieces, but every line is quantity 1 — that quotes a team order as a single garment. Re-call updateQuote with quantity=${_size} on each per-player garment.` }) });
              didSearch = true;
              continue;
            }

            const quote = await this.quoteService.build({
              tenantId, sessionId,
              title: parsedArgs.title,
              items: await resolveQuoteItemSkus(tenantId, Array.isArray(parsedArgs.items) ? parsedArgs.items : []),
              installationSummary: parsedArgs.installationSummary,
              warrantySummary: parsedArgs.warrantySummary,
              pricing: projectConfig.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
            });
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
                message: `You ALREADY presented this ${call.function.name} earlier in this conversation (it is on the right panel). Do NOT present it again. Acknowledge it briefly if relevant and move to the next unmet goal in the journey memory.`,
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
            tenantId, call, !!brandHubProfile?.model?.customised);
          await groundItemFacts(tenantId, call);
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
          if (!verdict.designableAlternatives) uiToolCalls.push(call);
          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(itemVerdict || verdict),
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
    // SAFETY NET: the gender gate fired but the model didn't render a clarify → synthesize
    // it so the buttoned panel ALWAYS appears (deterministic, no model dependence).
    if (mustClarifyGender && !uiActions.some((a) => a.name === 'setPhase' && (a.arguments as any)?.phase === 'clarify')) {
      uiActions.push(this.synthGenderClarify(intent));
      if (!finalMessage?.content) finalMessage = { role: 'assistant', content: 'Happy to help! First — who are we shopping for, and what’s the occasion?' };
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
    const { tenantId = 'caroma' } = request;
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

    // Published project config (model + persona + journey guidance)
    const projectConfig = await this.configLoader.loadProjectConfig(tenantId);
    const model = projectConfig.model || this.model;
    const llm = getChatClient({ provider: projectConfig.provider, apiKey: projectConfig.apiKey, baseUrl: projectConfig.baseUrl }); // per-project provider + key
    const configBlock = this.configLoader.renderConfigBlock(projectConfig);
    // High-level orientation so the agent starts knowing who this business is
    // (AUG-14). Cached; never blocks the turn.
    const brandHubProfile = await this.configLoader.loadBrandHub(tenantId);
    const brandHubBlock = this.configLoader.renderBrandHubBlock(brandHubProfile, projectConfig.capabilities, projectConfig);
    pushTrace({ step: 'config', detail: `model=${model} · configV=${projectConfig.configVersion ?? 'draft'}${projectConfig.journeyGuidance ? ' · +journeyGuidance' : ''}` });

    // Intent (config-driven) — bounded by the project's configured context dimensions
    const intent = await this.intentResolver.resolve(messages, state, this.intentModel, projectConfig.contextDimensions);
    const dimStr = Object.entries(intent.dimensions || {}).map(([k, v]) => `${k}=${v}`).join(',') || '—';
    pushTrace({ step: 'intent', detail: `${intent.intent} · dims=${dimStr} · space=${intent.space} · stage=${intent.stage} · mode=${intent.mode}`, data: intent });

    // Config rules
    const activeRules = await this.configLoader.loadActiveRules(tenantId);
    const rulesBlock = this.configLoader.renderRulesBlock(activeRules);
    pushTrace({ step: 'config-rules', detail: activeRules.length ? `${activeRules.length} active rule(s) loaded` : 'no rules configured' });

    // Retrieval policy + enforcement
    const policy = buildRetrievalPolicy(intent);
    pushTrace({ step: 'retrieval-policy', detail: policy.allowRetrieval ? `allow [${policy.allowedTypes.join(', ')}]` : 'no retrieval (discovery — ask first)' });
    const projectTools = buildToolset(projectConfig.capabilities, brandHubProfile?.entityModel);
    const activeTools = policy.allowRetrieval
      ? projectTools
      : projectTools.filter((t) => t.type !== 'function' || t.function.name !== 'searchKnowledge');

    // Prompt assembly (mirrors processChat) — journey working-memory block.
    const stateContext = renderJourneyStateBlock(journeyState);
    const intentGuidance =
      `[TURN GUIDANCE]\n- Detected intent: ${intent.intent} (stage: ${intent.stage}, mode: ${intent.mode})\n` +
      `- Missing context: ${intent.missingInfo.length ? intent.missingInfo.join(', ') : '(none)'}\n` +
      `- ${policy.guidance}`;

    const conversation: any[] = [
      { role: 'system', content: assembleSystemPrompt(intent.mode, intent.stage) },
      ...(brandHubBlock ? [{ role: 'system', content: brandHubBlock }] : []),
      ...(configBlock ? [{ role: 'system', content: configBlock }] : []),
      ...(rulesBlock ? [{ role: 'system', content: rulesBlock }] : []),
      ...(stateContext ? [{ role: 'system', content: stateContext }] : []),
      { role: 'system', content: intentGuidance },
      ...(journeyState?.activeSku && !hasDesignImage ? [{ role: 'system', content:
        `[DESIGN ALREADY ON THE PANEL] The customer is already looking at their design on style ${journeyState.activeSku}. IGNORE any "discovery — ask first" guidance above and do NOT re-onboard — never ask which school/team/sport/gender/colours when a design is already shown. Answer the customer's actual question about the design in front of them: tweak colours/name/number, explain what they see, or offer to send it to the artist. ` +
        `If they ask "where is the 3D" or "why is it my exact image": the panel is showing THEIR design reproduced on our garment — a faithful proof, the accurate preview for a full custom all-over print. Be honest that it is a proof image (not a spinnable 3D); interactive 3D spin only applies to simpler template designs, and the artist finalises the print file. Do not claim it is "3D".` }] : []),
      ...(hasDesignImage ? [{ role: 'system', content:
        '[CUSTOM DESIGN ATTACHED] The customer attached a design image this turn. FIRST call analyzeDesign to read the garment and match it to our make-able template library. ' +
        'If it returns decision "use", call showConfigurator with template.sku and the analysed colours. The panel shows their design REPRODUCED on our garment as a faithful PROOF — tell them "here is your design on our <style>" and that we make this style; call it a proof/preview, do NOT call it "3D". ' +
        'If it returns decision "create", warmly tell them it is a brand-new design — we will generate the cut pieces at their sizes and an artist will finalise it — and do NOT invent a style code or call showConfigurator.' }] : []),
      ...((projectConfig.capabilities || []).includes('customDesign') && !hasDesignImage ? [{ role: 'system', content:
        '[YOU CAN DESIGN] This brand can DESIGN a custom garment for the customer — you are their designer, so they never need another tool. ' +
        'When the customer DESCRIBES a look they want created/made (colours, team, number, style, vibe) — e.g. "design me a…", "can you make a…", "I want a jersey that…", "create a…" — call generateDesign with their brief FIRST. Do NOT answer such a request with searchKnowledge/showItems catalogue cards. ' +
        'Only use searchKnowledge/showItems when the customer wants to BROWSE existing catalogue products ("show me…", "what baseball jerseys do you have"). If they iterate ("make the sleeves brighter"), call generateDesign again with the refined brief. ' +
        'ARTIST REVIEW: when the customer is happy and wants to proceed, or explicitly says "send it to your artist / for review / to production", call submitForReview (kind "use" if it is on an existing style, "create" if it is a new design). When they ask "is it ready / approved?", call checkReviewStatus. A custom design must be artist-approved AND customer-agreed before it can print — never call it production-ready yourself.' }] : []),
      ...messages,
    ];

    // ── Tool rounds (non-streamed) — resolve searches + UI actions ──
    const maxLoops = 6;
    const MAX_SEARCHES = 6;          // collection + core fixtures need multiple searches
    let loops = 0;
    let searchCount = 0;
    let hadRetrieval = false;
    let readyToSpeak = false;
    let forcedUi = false;               // panel-render enforcement fired already?
    let forcedSearch = false;           // post-clarify "don't defer, search now" nudge fired already? (ANF-10)
    let mustClarifyGender = false;      // gender gate fired → guarantee a clarify panel (post-turn)
    let cdlUseSku: string | null = null;  // CDL: analyzeDesign matched a real template → force the configurator
    let cdlSuggested: any = null;         // CDL: server-built configurator config (colours+text mapped to the palette)
    const uiToolCalls: any[] = [];
    const wantUiTool = this.requiredUiTool(intent, { customised: brandHubProfile?.model?.customised, capabilities: projectConfig.capabilities });

    // Mandatory opening move (streaming): research the named org before the model acts.
    // Same guard as the buffered path — a same-turn clarify would bury the card.
    this.noteTeamSize(conversation, journeyState);
    this.noteShownItems(conversation, journeyState);
    await this.noteNamedStyle(tenantId, conversation, journeyState, projectConfig);
    const researchedThisTurn = await this.maybeResearchOrg(tenantId, projectConfig, intent, journeyState, conversation, uiToolCalls, emit);
    await maybeForceSizeRecommendation(tenantId, conversation, activeTools, projectConfig.capabilities, uiToolCalls, emit, model, llm);

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
        const effWantUi = cdlUseSku ? 'showConfigurator' : wantUiTool;
        pushTrace({ step: 'forced-ui?', detail: `cdlUseSku=${cdlUseSku ?? '—'} effWantUi=${effWantUi ?? '—'} forcedUi=${forcedUi} blocked=${intent.panelRenderBlocked} already=${uiToolCalls.some((c) => c.function?.name === effWantUi)}` });
        if (!researchedThisTurn && (hadRetrieval || effWantUi === 'showConfigurator') && effWantUi && !forcedUi &&
            !intent.panelRenderBlocked &&
            !uiToolCalls.some((c) => c.function?.name === effWantUi)) {
          forcedUi = true;
          pushTrace({ step: 'forced-ui', detail: `${effWantUi}${cdlUseSku ? ` (CDL ${cdlUseSku})` : ''}` });
          await this.forceUiTool(tenantId, conversation, activeTools, effWantUi, uiToolCalls, emit, model, llm, journeyState, !!brandHubProfile?.model?.customised, projectConfig.configuratorType);
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
            'The customer is waiting and the right-hand panel is EMPTY. Do NOT defer, do NOT reply with "give me a moment" or "let me look" — this turn you MUST call searchKnowledge for their brief and then showItems with the real results. Act now, in this same turn.' });
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
      const DATA_TOOLS = new Set(['findRelated', 'getProductOptions', 'findEntity', 'registerEntity', 'requestArtwork', 'checkArtworkApproval', 'analyzeDesign', 'generateDesign', 'generateTeamDesign', 'submitTeamOrder', 'submitForReview', 'checkReviewStatus', 'recommendSize', 'uploadPhotosFor3D']);
      const dataCalls = fnCalls.filter((c) => DATA_TOOLS.has(c.function.name));
      const otherCalls = fnCalls.filter((c) => c.function.name !== 'searchKnowledge' && !DATA_TOOLS.has(c.function.name));

      if (dataCalls.length) {
        hadRetrieval = true;
        const results = await Promise.all(
          dataCalls.map(async (call) => ({
            id: call.id,
            name: call.function.name,
            value: call.function.name === 'findRelated'
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
        if (cdlUseSku && !forcedUi && !intent.panelRenderBlocked &&
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
            conversation.push({ role: 'system', content: `[RENDERED] The customer's design is already on the right in their colours (${(cdlSuggested.colours || []).join(', ') || 'their palette'}) on style ${cdlUseSku}. Do NOT call showConfigurator again this turn. Tell them their design is shown, invite tweaks to colours/name/number, or offer to send it to the artist for review.` });
          } else {
            pushTrace({ step: 'forced-ui', detail: `showConfigurator (CDL ${cdlUseSku})` });
            await this.forceUiTool(tenantId, conversation, activeTools, 'showConfigurator', uiToolCalls, emit, model, llm, journeyState, !!brandHubProfile?.model?.customised, projectConfig.configuratorType);
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
              const r = await (await adapterRegistry.getKnowledge(tenantId)).search({ tenantId }, { query: args.query, type: args.type, category: args.category, limit: 8, gender: intent?.dimensions?.gender });
              // Same annotation as the non-streaming path — this is the one the
              // storefront actually uses, so an omission here is invisible in
              // tests and total in production (the AUG-38 failure, repeated).
              const marked = await markDesignable(tenantId, r);
              return { id: call.id, content: JSON.stringify(marked), args, result: marked };
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
          // A team order priced at quantity 1 is money-wrong and looks authoritative.
          // The engine multiplies correctly; it just defaults missing quantity to 1.
          // Refuse to build it rather than ship a confident wrong total. (This is the
          // path the storefront actually uses — the buffered one is the fallback.)
          const qSize = Number(journeyState.teamSize) || 0;
          const qItems = Array.isArray(parsedArgs.items) ? parsedArgs.items : [];
          if (qSize > 1 && qItems.length && qItems.every((it: any) => (Number(it.quantity) || 1) <= 1)) {
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
              success: false, quantityMissing: true,
              message: `The customer needs ${qSize} pieces, but every line is quantity 1 — that quotes a team order as a single garment. Re-call updateQuote with quantity=${qSize} on each per-player garment.` }) });
            didSearch = true;
            continue;
          }
          const quote = await this.quoteService.build({
            tenantId, sessionId,
            title: parsedArgs.title,
            items: await resolveQuoteItemSkus(tenantId, Array.isArray(parsedArgs.items) ? parsedArgs.items : []),
            installationSummary: parsedArgs.installationSummary,
            warrantySummary: parsedArgs.warrantySummary,
            pricing: projectConfig.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
          });
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
            message: `You ALREADY presented this ${call.function.name} earlier in this conversation (it is on the right panel). Do NOT present it again. Move to the next unmet goal in the journey memory.`,
          }) });
          didSearch = true;
          continue;
        }
        // Validate before emitting so the panel gets the CORRECTED design, and
        // the model is told what could not be applied instead of a bare success.
        const verdict = await validateDesign(tenantId, call, projectConfig.configuratorType);
        // showItems may not present stock styles as customisable (AUG-25).
        const itemVerdict = await enforceItemDesignability(
          tenantId, call, !!brandHubProfile?.model?.customised);
        // Card facts come from the catalogue, never the model (AUG-82).
        await groundItemFacts(tenantId, call);
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
        if (verdict.designableAlternatives) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(verdict) });
          {
            const _s = summarizeToolCall(call.function.name, parsedArgs, verdict);
            void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
          }
          continue;
        }

        uiToolCalls.push(call);
        emit('uiAction', { name: call.function.name, arguments: emitArgs });
        conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(itemVerdict || verdict) });
        {
          const _s = summarizeToolCall(call.function.name, parsedArgs, itemVerdict || verdict);
          void this.sessionStore.appendStep(sessionId, tenantId, { turnIndex, tool: call.function.name, ..._s, ts: new Date().toISOString() });
        }
      }
      if (!didSearch) readyToSpeak = true; // UI-only round → speak next
    }

    // ── Final answer — streamed token by token ──────────────────────
    // For a plain retail brand we can't stream raw tokens: a leaked "not
    // customisable" sentence would already be on screen before a post-strip runs.
    // So we buffer per-sentence and only emit sentences that pass the taboo filter.
    const plainRetail = projectConfig?.commerceMode === 'cart' && !projectConfig?.configuratorType;
    let finalText = '';
    let pending = '';   // holds an in-progress sentence (plainRetail only)
    try {
      // No tools/tool_choice here → the model can only produce text (OpenAI rejects
      // tool_choice when tools are absent). This IS the final spoken answer.
      const stream = await llm.chat.completions.create({
        model,
        messages: conversation,
        stream: true,
        ...genParams(model, projectConfig.temperature),
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (!delta) continue;
        finalText += delta;
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
    // Flush the trailing (unterminated) sentence.
    if (plainRetail && pending) {
      const clean = this.stripCartTaboo(pending, true);
      if (clean) emit('token', { delta: clean });
    }
    finalText = this.stripCartTaboo(this.stripChatMedia(finalText), plainRetail);
    if (plainRetail && !finalText.trim()) {
      finalText = 'Here are a few great options — let me know which one catches your eye, or head to checkout any time.';
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
