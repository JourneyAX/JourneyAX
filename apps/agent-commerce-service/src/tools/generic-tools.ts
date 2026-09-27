import type OpenAI from 'openai';

/**
 * Reusable retrieval, selection, presentation, and conversation contracts.
 *
 * These definitions have no direct tenant-service dependency. Their current
 * descriptions remain unchanged; making their executors reusable is Phase 2.
 */
export const GENERIC_TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
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
      description: 'Update the UI phase. When transitioning to "clarify", you MUST provide dynamic questions tailored to the user\'s context. These questions will render in the conversation.',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['intro', 'clarify', 'validating', 'products', 'quote', 'ordered'] },
          questions: {
            type: 'array',
            description: 'Dynamic clarification questions to show in the conversation. Required when phase is "clarify".',
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
      name: 'showItems',
      description: 'Show recommendation cards (items — products, services or options) in the conversation. Use AFTER searchKnowledge to present items for review BEFORE building the final quote. Use only real data returned by searchKnowledge — never invent.',
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
      description: 'Show an interactive troubleshooting or installation guide in the conversation. Use this for step-by-step instructions (e.g. diagnosing a leak, installing a product).',
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
  {
    type: 'function',
    function: {
      name: 'showAddons',
      description: 'Show recommended accessories / add-on parts for the selected product(s) in the conversation, grouped by necessity. Use AFTER the customer has chosen their main products. Use only real items from searchKnowledge — do NOT invent SKUs, prices, or images.',
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
      description: 'Present a decision to the customer as selectable options in the conversation (e.g. "DIY vs professional installation", "which finish"). Generic — use whenever the journey needs the customer to pick a path before continuing.',
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
      description: 'Show official installation / troubleshooting guide documents (PDFs) for a product in the conversation, with view + download links. Use the documents returned by searchKnowledge — NEVER invent URLs. If a product has multiple guides, include all relevant ones.',
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
      description: 'Show warranty & guarantee information for the selected product(s) in the conversation, BEFORE building the quote. Use ONLY warranty facts found in the knowledge base. If product-specific warranty is not in the data, say so honestly (do not invent terms). Optionally offer an extended warranty / service package if one is configured.',
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
      // ── Presentation contract additions (v3 Card CMS, docs/v3-card-cms-
      // architecture.md — modelled on anthropics/commerce-agents' present_*
      // tools): the model's judgment is which SKUs, in what order, and why —
      // every fact is joined server-side from records already seen this
      // session, never re-typed by the model. See enforceItemDesignability's
      // presentComparison/presentSuggestions branches for the provenance and
      // sanitisation this contract requires before either ever renders.
      name: 'presentComparison',
      description: 'Compare two to four products the customer is deciding between, side by side on named dimensions (price, size, material, warranty — whatever they actually raised). Use when they have narrowed to a few finalists, AND whenever they ask what the DIFFERENCE is between two named products, ranges or variants ("Matte vs Dual Matte", "standard or Japanese size") — for that ask, searchKnowledge each one, showItems the real matches, then present them side by side in the SAME turn; a prose-only answer to a "which is different how" question is a miss. Never as a first response to a broad ask; searchKnowledge + showItems comes first. Not needed when one product answers the request, or when the differences are better said in a sentence than a table. Every SKU MUST already have been returned by searchKnowledge or shown in showItems this conversation — a SKU that does not exist in the real catalogue is dropped before this renders, and specs must come from what was actually retrieved, never invented.',
      parameters: {
        type: 'object',
        properties: {
          skus: { type: 'array', items: { type: 'string' }, description: 'Two to four real SKUs, in the order they should be compared.' },
          dimensions: { type: 'array', items: { type: 'string' }, description: 'What is being compared, in the order to show it — e.g. ["Price","Capacity","Warranty"].' },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: 'One row per dimension (same order as `dimensions`), one cell per SKU (same order as `skus`). Values must come from real specs already retrieved this conversation.',
          },
          verdict: { type: 'string', description: 'One sentence naming the trade-off, or your recommendation, if you have one.' },
        },
        required: ['skus', 'dimensions', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'presentSuggestions',
      description: "Offer up to four short next-step suggestions as tappable chips (e.g. \"Show me cheaper options\", \"Compare with X\", \"Add to quote\"). Call it in the same round as the turn's last card, or right after your text when the turn has no card. A tapped chip is sent back as the customer's next message worded exactly as shown — word each one as something the CUSTOMER would say, not an instruction to yourself. Not needed when the natural next step is obvious from the card alone, or on a turn that already ends in a question.",
      parameters: {
        type: 'object',
        properties: {
          chips: { type: 'array', items: { type: 'string' }, description: "Up to four short chips, in the customer's voice, each under 80 characters." },
        },
        required: ['chips'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'presentBundle',
      description: 'Present a set of products that belong TOGETHER as one card with a total and one "Add all" — a coordinated set from a series, a double-sleeving kit (outer + inner + box), a gift bundle for a budget. Every SKU MUST already have been returned by searchKnowledge or shown this conversation; prices and names are joined by the server. Use after retrieval, not as a first response to a broad ask. Not needed for a single item or a plain list of alternatives (showItems is for those).',
      parameters: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'What the set is, in the customer\'s terms — e.g. "The Raid set", "Double-sleeving kit for your Commander deck".' },
          why: { type: 'string', description: 'One sentence on why these belong together.' },
          items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, reason: { type: 'string', description: 'One clause on this item\'s role in the set.' } }, required: ['sku'] }, description: 'Two to six real SKUs with quantities.' },
        },
        required: ['heading', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'loadSkill',
      description: "Load the full technique for one named skill (from the skills list in your system prompt) when its description applies to this turn. The system prompt only ever carries each skill's name and one-line summary — call this to read the actual guidance before acting on it.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The exact skill name as listed in the system prompt.' },
        },
        required: ['name'],
      },
    },
  },
];

export const GENERIC_TOOL_NAMES = GENERIC_TOOL_DEFINITIONS.map(
  (tool) => tool.type === 'function' ? tool.function.name : '',
) as string[];
