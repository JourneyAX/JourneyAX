# Traditional (zero-token) Journey Engine

## Why this exists

The AI path calls OpenAI on every chat turn. That consumes **tokens** and can fail when the API quota is exhausted.

The **traditional engine** rebuilds the same Caroma journey with plain TypeScript rules:

- Intent detection via keywords/regex  
- Fixed clarify question sets  
- Deterministic product matching from a static catalog  
- Template install/troubleshoot guides  
- Deterministic BOM / quote builder  

**No OpenAI. No embeddings. No token meter.**

## Default mode

The app runs in traditional mode by default.

| Mode | How to enable | Tokens? |
|---|---|---|
| **Traditional (default)** | unset / anything except `ai` | None |
| **AI (legacy POC)** | `NEXT_PUBLIC_JOURNEY_ENGINE=ai` | Yes — needs `OPENAI_API_KEY` + Mongo |

## Supported journeys (traditional)

1. Bathroom shower renovate / replace  
2. Full bathroom spec  
3. Kitchen sink & mixer  
4. Laundry tub  
5. Troubleshooting (drip, pressure, mixer)  
6. Warranty / SKU lookup  
7. Products → quote with mandatory install parts + selected accessories  
8. Simulated order approve  

## Key files

- `src/lib/traditional/catalog.ts` — static products  
- `src/lib/traditional/questions.ts` — intents + clarify chips  
- `src/lib/traditional/guides.ts` — checklist templates  
- `src/lib/traditional/engine.ts` — rule orchestrator  
- `src/components/ChatPanel.tsx` — switches engines via env flag  

## Trade-offs

| Traditional | AI |
|---|---|
| Never runs out of tokens | Flexible free-text understanding |
| Predictable, testable | Can handle novel phrasing |
| Catalog must be coded/updated | RAG can search large scraped catalogs |
| Guides are templates | Can synthesize from PDFs |

For production cost control, keep traditional as the default and treat AI as an optional upgrade.
