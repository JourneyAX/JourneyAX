# JourneyAX

Conversational commerce journeys where **the AI chooses the interface**, not the router. The model calls a tool, the browser replays it as a state change, and the right-hand panel becomes whatever the conversation now needs — clarifying questions, product cards, an installation checklist, a fit advisor, a quote.

Two businesses run on the same engine: a Caroma bathroom configurator and an apparel journey with size intelligence.

## Journeys

Run `npm run dev`, then:

| Route | What it is | Needs a key? |
|---|---|---|
| `/` | Caroma bathroom configurator | **Yes** — `OPENAI_API_KEY` + `MONGODB_URI` |
| `/shop` | Apparel journey: fit, try-on, bag, returns, 5 languages | No — mock data, deterministic fallback |
| `/advisor` | Fit Advisor as a modal widget on a mock storefront | No |
| `/csr` | Augusta CSR reorder desk | No — **staff sign-in required** |
| `/fit` | Batch size review, two brands on one engine | No — **staff sign-in required** |
| `/login`, `/account` | Staff sign-in and account management | No |

`/api/health` reports whether retrieval is working or has silently degraded. Point an uptime monitor at it.

## Getting started

**Prerequisites:** Node.js 20+ (developed on 24). MongoDB Atlas with a `vector_index` **created in the Atlas UI** — `ensureIndexes()` only creates the scalar ones. An OpenAI key.

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

Only `/` needs the key and the database. Every other journey runs on local mock data, so you can develop most of the app with an empty `.env.local`.

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # must stay at 0 errors
npm test         # node:test via tsx
```

### Staff accounts

`/csr` and `/fit` require sign-in. Create an account:

```bash
npx tsx src/scripts/make-user.ts add alice csr
```

With `JOURNEYAX_USER_STORE` set this writes to a JSON file and enables password changes, MFA and recovery codes. Without it, the script prints a line for `JOURNEYAX_USERS` and the directory is read-only.

## Architecture

**`src/app/api/chat/route.ts` is the whole backend for `/`.** It runs its own OpenAI tool loop and splits tools in two:

- `searchKnowledge` runs server-side against MongoDB and feeds the result back into the loop.
- `setPhase` / `updateQuote` / `showProducts` / `showGuide` are **never executed on the server.** They are collected, answered with a stub so the model keeps going, and returned as `uiActions[]` for the browser to replay as reducer dispatches.

So the model changes the interface by calling a function that does nothing where it is called. Adding a panel means: a tool, a branch in the route, a handler in `ChatPanel`, a reducer action, an entry in `ProjectPanel`.

**Retrieval** tries Atlas `$vectorSearch` and falls back to a regex scan. That fallback used to be invisible; `searchWithReport()` now returns `degraded`, the model is told to hedge when it fires, and `/api/health` reports it.

**Money is verified server-side.** `lib/pricing.ts` is shared by both sides, the browser's figure is a preview, and `/api/quote` is the number of record. Nothing may be ordered on a total that did not come from there.

**The fit engine** (`src/services/fit/`) is brand-agnostic size intelligence: six independent signals, each returning `null` when it lacks data, so one engine serves made-to-order team wear and retail fashion with no branching. Onboarding a brand is one object in `brands.ts`.

## Where the detail lives

**`CLAUDE.md` is the working document** — architecture, the authentication model, the request-handling pipeline, and a "things that will mislead you" section covering the traps this codebase actually contains. Read it before changing anything non-trivial. `AGENTS.md` covers the Next 16 breaking changes.

## Status

A proof of concept under active hardening, not a production deployment. Honest limitations:

- Four of the five journeys run on **mock data**. Only `/` is wired to anything real.
- Rate limiting, account lockout and session revocation are **in-process** — they reset on restart and do not coordinate across instances.
- The writable user store is a **JSON file**, single-instance only.
- The scraped-page parsers are positional string-slicing against one site's layout and will break when it changes. They are tested so the breakage is visible.

---
*Built as a proof of concept by JourneyAX.*
