import type OpenAI from 'openai';

import {
  GENERIC_TOOL_DEFINITIONS,
  GENERIC_TOOL_NAMES,
} from './generic-tools';

/**
 * Contracts coupled to tenant integrations or domain-specific journeys.
 *
 * Definitions and the public model-facing order are deliberately preserved.
 * Phase 1 does not change capability filtering, tool execution, or UI actions.
 */
export const TENANT_SPECIFIC_TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
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
        "After it returns on 'use', tell the customer you've designed their concept and it's shown below; invite them to tweak colours, name or number. " +
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
      name: 'updateQuote',
      description: 'Assemble the final quote (Bill of Materials). You propose ONLY real SKUs and quantities from the catalogue — the server looks up the real price, stock and totals. NEVER call updateQuote with 0 items or for an assessment summary. A quote MUST contain at least one real product SKU to order. For diagnostic guides or troubleshooting without products, call showGuide. For product recommendations, call showItems.',
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
      name: 'getMyOrders',
      description: "The signed-in customer's own order history (most recent first). Use for 'what did I buy', 'my last order', 'same as before'. Refuses with sign_in_required for a guest. Never accepts or needs a customer id — it is bound server-side.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMyLatestOrder',
      description: "The signed-in customer's most recent order only. Use when the customer says 'last time', 'my latest order', 'what I bought before'.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMyOrder',
      description: "One of the signed-in customer's orders by its reference (as returned by getMyOrders). Refuses references that belong to anyone else.",
      parameters: { type: 'object', properties: { orderReference: { type: 'string', description: 'The order reference exactly as returned by getMyOrders.' } }, required: ['orderReference'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCurrentOffer',
      description: "TODAY's unit price and available stock for a SKU in the signed-in customer's market, plus the subtotal for a quantity. Historical order prices are NOT current prices — call this before quoting a price for a repeat purchase. Returns demo_offer_not_available when the market has no offer for that SKU.",
      parameters: { type: 'object', properties: { sku: { type: 'string', description: 'A real catalogue SKU (from an order line, searchKnowledge or showItems).' }, quantity: { type: 'integer', minimum: 1, description: 'Packs wanted (default 1).' } }, required: ['sku'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStaffInventory',
      description: 'Staff-only inventory snapshot (on-hand, reserved, lead time, inbound) for replenishment questions. Refuses unless the signed-in profile has the staff role. Never claim a demand forecast from it — say what is missing when lead time or inbound data is absent.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommendStorage',
      description: 'Which storage products (deck boxes, binders, portfolios, drawers) fit a given number of cards, from the business\'s own capacity facts — arithmetic done for you, never guessed. Call it before recommending storage when the customer has given a card or deck count. Returns the families that fit with their exact capacities; then searchKnowledge/showItems those families to present real SKUs.',
      parameters: {
        type: 'object',
        properties: {
          cards: { type: 'integer', minimum: 1, description: 'Total cards to store (a Commander deck is 100, a Standard deck 60).' },
          sleeving: { type: 'string', enum: ['unsleeved', 'single', 'double', 'sealable-double'], description: 'How the cards are sleeved — it changes capacity.' },
          kind: { type: 'string', enum: ['deck-box', 'binder', 'portfolio', 'drawer', 'case', 'any'], description: 'What kind of storage they want, if stated.' },
        },
        required: ['cards'],
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
        "It deterministically computes structural bearers, joists, palings/boards, fasteners, concrete, tools needed, and NZ Building Code compliance notes, and opens the interactive Project Plan in the conversation.",
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
  {
    type: 'function',
    function: {
      name: 'openSpacePlanner',
      description:
        "LAUNCH the interactive 3D and 2D PlaceMakers Space & Modular Cabinet Planner in the conversation. " +
        "Call this whenever the customer wants to build or plan a laundry cabinet, kitchen modular units, bathroom vanity & tower, or modular cabinetry space (e.g. 'I want to build a laundry cabinet', 'plan kitchen cabinets', 'space planner for laundry'). " +
        "It provides a live 3D visual canvas where customers can configure and place modular cabinets, choose finishes, and generate a live bill of materials.",
      parameters: {
        type: 'object',
        properties: {
          roomType: { type: 'string', enum: ['laundry', 'kitchen', 'bathroom', 'utility'], description: 'The room type (e.g. laundry, kitchen, bathroom).' },
          wallWidthMm: { type: 'number', description: 'Wall width in millimetres if specified (e.g. 2000).' },
          installType: { type: 'string', enum: ['diy', 'trade'], description: "Pass this ONLY if the customer already stated it in their message (e.g. 'trade installer', 'DIY', 'myself') — pre-selects the panel's install toggle so it matches what they said instead of defaulting to DIY. Omit if not stated." },
          finish: { type: 'string', enum: ['white-gloss', 'anthracite', 'natural-oak', 'coastal-elm'], description: "Pass this ONLY if the customer already stated a style/finish preference (e.g. 'modern gloss white' → white-gloss, 'dark charcoal' → anthracite, 'warm timber' → natural-oak, 'grey timber' → coastal-elm). Omit if not stated." },
        },
        required: [],
      },
    },
  },
];

export const TENANT_SPECIFIC_TOOL_NAMES = TENANT_SPECIFIC_TOOL_DEFINITIONS.map(
  (tool) => tool.type === 'function' ? tool.function.name : '',
) as string[];

const TOOL_DEFINITION_BY_NAME = new Map(
  [...GENERIC_TOOL_DEFINITIONS, ...TENANT_SPECIFIC_TOOL_DEFINITIONS]
    .filter((tool): tool is OpenAI.ChatCompletionFunctionTool => tool.type === 'function')
    .map((tool) => [tool.function.name, tool]),
);

const TOOL_ORDER = ["researchSchool","searchKnowledge","registerEntity","requestArtwork","checkArtworkApproval","readRoster","getProductOptions","analyzeDesign","generateDesign","generateTeamDesign","uploadPhotosFor3D","submitForReview","checkReviewStatus","submitTeamOrder","recommendSize","findRelated","setPhase","updateQuote","showItems","showGuide","showAddons","presentChoice","showDocuments","showInfo","presentComparison","presentSuggestions","getMyOrders","getMyLatestOrder","getMyOrder","getCurrentOffer","getStaffInventory","presentBundle","recommendStorage","loadSkill","showConfigurator","buildProjectPlan","checkBranchStock","openSpacePlanner"] as const;

/** The exact Phase-1 model contract, in its original order. */
export const ALL_TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = TOOL_ORDER.map((name) => {
  const tool = TOOL_DEFINITION_BY_NAME.get(name);
  if (!tool) throw new Error(`Tool definition missing for ${name}`);
  return tool;
});

export const TOOL_CLASSIFICATION = {
  generic: GENERIC_TOOL_NAMES,
  tenantSpecific: TENANT_SPECIFIC_TOOL_NAMES,
} as const;
