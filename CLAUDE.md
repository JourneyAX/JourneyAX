# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # Next.js dev server (default :3000; .claude/launch.json uses :3010)
npm run build
npm run lint     # eslint (flat config, eslint-config-next) — must stay at 0 errors
npm test         # node:test via tsx, runs src/**/*.test.ts
```

Unit tests are `node:test` + `tsx`, no framework. They cover the parts where being
wrong costs money or trust: `lib/pricing`, `lib/rate-limit`, `lib/api-guard`, and
`services/fit/return-store`. Anything touching those four must keep `npm test` green.

`test-*.js` at the repo root and `src/scripts/e2e-test-suite.ts` are a separate,
older thing: ad-hoc Playwright scripts run directly (`node test-flow.js`). They
need a dev server already running and are stale — they hardcode
`http://localhost:3008` and write screenshots to a macOS path
(`/Users/mahaveer/.gemini/...`). Fix both before running on Windows. `eslint.config.mjs`
scopes the module-system rules off for them rather than pretending they are app code.

### Knowledge-base ingestion

All ingestion is manual, run via `npx tsx`, and writes to MongoDB Atlas `journeyx.documents`:

```bash
npx tsx src/scripts/ingest.ts --stats            # DB counts by type
npx tsx src/scripts/ingest.ts --md               # import ../GWA/*.md
npx tsx src/scripts/ingest.ts --crawl            # Firecrawl crawl of caroma.com.au
npx tsx src/scripts/ingest-master.ts             # Playwright sitemap scrape + PDF ingest (main path)
npx tsx src/scripts/ingest-technical-pdfs.ts --dry-run
npx tsx check-db.ts                              # connectivity + document counts
```

**Env gotcha:** the app reads `.env` and `.env.local` (Next.js loads both, `.env.local` winning per key), while every ingest script calls `dotenv.config({ path: '.env.local' })` only. `.env.local` **does exist** and carries `MONGODB_URI` / `OPENAI_API_KEY` — an earlier version of this file claimed it did not. If a script reports an undefined key, check `.env.local` actually holds it rather than assuming the file is missing.

**Second env gotcha:** Next expands `$VAR` inside env files. Any value containing a literal `$` — password hashes, connection strings, generated secrets — is silently mangled. Use `$$` to escape, or a format that avoids `$` entirely (see Authentication).

Other external prerequisites: `ingest-master.ts` shells out to `pdftotext` and writes PDFs to `../GWA/Technical_PDFs` (outside this repo); `ingest.ts --md` reads `../GWA`; the Firecrawl path needs `FIRECRAWL_API_KEY`, which is not in `.env`.

## Routes

`npm run dev`, then:

| Route | What it is |
|---|---|
| `/` | Caroma bathroom journey (the original) → `/api/chat` |
| `/shop` | Apparel journey, with the Fit Advisor → `/api/shop` |
| `/advisor` | Mock storefront hosting the Fit Advisor as a modal widget |
| `/csr` | Augusta CSR reorder desk → `/api/csr` · **staff login required** |
| `/fit` | Batch size review, Augusta vs Abercrombie · **staff login required** |
| `/login` | Staff sign-in |
| `/api/quote` | Authoritative quote totals (POST). Not a page. |
| `/api/health` | Liveness + retrieval health (GET). Not a page. |
| `/api/auth/*` | `login`, `logout`, `me`. Not pages. |

`/shop`, `/advisor`, `/csr` and `/fit` all run on local mock data and need no `OPENAI_API_KEY`. Only `/` requires a live key.

`/csr` and `/fit` need an account before they will render — see Authentication.

## Architecture

A single-page Caroma bathroom configurator. Two columns: a chat on the left, and a right panel whose contents are chosen by the AI, not by routing.

**The AI is the UI router.** `src/app/api/chat/route.ts` is the whole backend. It runs its own OpenAI tool loop (`maxLoops = 8`, model `gpt-5.4-mini`) and splits tools into two kinds:

- `searchKnowledge` — executed server-side against MongoDB, result fed back into the loop.
- `setPhase` / `updateQuote` / `showProducts` / `showGuide` — **never executed server-side.** They are pushed onto `uiToolCalls`, answered with a dummy `{success:true}` so the model keeps going, and returned to the browser as `uiActions[]`. The client replays them as reducer dispatches.

So the model changes the right-hand panel by calling a function that does nothing on the server. Adding a panel means: new tool in `tools[]` → new branch in the `else if` on route.ts:391 → new `uiActions` handler in `ChatPanel.sendToAI` → new reducer action → new entry in `ProjectPanel`.

**State flow.** `JourneyContext` (`useReducer`) holds the canonical journey state. `ProjectPanel` renders exactly one panel per `state.phase`. Panels are dumb; they reach back into the chat through globals that `ChatPanel` installs on `window` (`__handleClarifySubmit`, `__handleBuildQuote`, `__handleUserMessage`) — this is deliberate, not accidental, and is how `ClarifyPanel`/`ProductsPanel`/`GuidePanel` push messages into the conversation.

`ChatPanel` keeps its own `messages` array separate from `state.messages` (the latter holds only the welcome message and `note` bubbles). After each call it replaces `messages` wholesale with `data.conversation` from the server, then flattens `role: 'tool'` / `tool_calls` entries into plain text before the next request.

**Phase quirks:** `Phase` includes `'guide'`, but the `setPhase` tool's enum does not. The guide phase is entered only as a side effect of `SET_GUIDE_STEPS`. `ChatPanel.sendToAI` also contains ~15 lines of fallback that infer a phase from state when the model forgets to call `setPhase` — check that before concluding a phase transition is broken.

**Retrieval** (`src/services/knowledge/mongo.ts`): `search()` tries Atlas `$vectorSearch` on the `vector_index` index, and on any error or empty result falls back to a regex scan over `chunk`. The vector index must be created in the Atlas UI — `ensureIndexes()` only creates the scalar ones.

That fallback used to be invisible: degraded search returned confident-looking
answers and nothing said so. `searchWithReport()` now returns `{ mode, degraded,
reason }` alongside the hits, `lastSearchReport()` exposes the most recent one, and
`/api/health` reports `status: "degraded"` when retrieval has dropped to keyword
matching. Prefer `searchWithReport` in new code — the plain `search` wrapper still
throws the signal away.

**The model is told too.** `/api/chat` puts a `retrievalNote` in the tool result
when retrieval is degraded, instructing it to rely only on what the content
plainly states and to admit uncertainty. Answering off keyword-matched chunks
with the same confidence as a good vector hit is how a customer gets told the
wrong thing about an in-wall component.

Ingestion pipeline is crawl/scrape → `classifier.ts` (URL patterns first, then content patterns) → `chunker.ts` (strategy per `DocumentType`; products are stored as one atomic chunk, everything else is sectioned or sliding-window with overlap) → `embedder.ts` (`text-embedding-3-small`, 1536-dim, batches of 100) → `insertDocuments`.

Scraped page text has image URLs appended under a `--- Product Images ---` marker. `route.ts` re-parses that marker (`parseImages`) and scrapes a `Specifications` block out of the raw content (`parseSpecs`) on every search hit, injecting `imageUrl` and `specs` into the tool result so the model can pass them straight into `showProducts`. Both parsers are positional string-slicing against Caroma's page layout and will break if the scrape format changes.

**Fit engine** (`src/services/fit/`): brand-agnostic size intelligence, used by the CSR journey and intended for any apparel tenant. Deliberately separate from `csr/` — nothing in `fit/` knows about COMS, rosters or sublimation.

- `signals.ts` — six independent evaluators (`elapsed-growth`, `size-history`, `return-signal`, `fit-preference`, `style-offset`, `measurement-chart`). Each returns `null` when it lacks data, which is how one engine serves made-to-order team wear (no returns, growth matters) and retail fashion (returns matter, growth is noise) with no branching.
- `brands.ts` — **the only file that differs per tenant.** A brand entry lists which signals it holds data for, a trust weight each, and a policy. Onboarding a brand is one object.
- `engine.ts` — weighted mean of signal deltas, clamped to `policy.maxStep`, scored by agreement between signals. Suppresses anything below `policy.minConfidence`. It never mutates: `RUN_FIT_REVIEW` produces suggestions, and `ACCEPT_FIT` / `ACCEPT_ALL_FIT` is what changes a roster size.
- `size-scales.ts` — scales are ordered arrays, so "one size up" is index arithmetic and the engine never has to know it is moving `YM→YL` rather than `6→8`.
- **The learning loop.** `returnSignal` reads `Wearer.returns`; `services/fit/return-store.ts` is what writes it. Before that store existed the reader was wired and the writer was not, so "it learns from returns" was structurally untrue — and invisible, because a wearer with no returns and a brand that takes no returns both make the signal return `null`. `reviewSizes` now calls `hydrate()` on every wearer before evaluating. **The default store is an in-process Map**: recorded returns die on restart and are not shared between instances. Implement `ReturnStore` against a database and call `setReturnStore` before this is real.
- `GROWTH_PER_YEAR` in `signals.ts` holds estimated growth rates, not measured ones. They are declared in one place precisely so they can be replaced wholesale when real reorder-pair data arrives. Nothing else depends on their being estimates.
- Policy is enforced in code, not prompt: `measurement-chart` refuses outright on a youth scale or when `allowBodyMeasurement` is false. The Augusta profile sets `assumeMinors: true`, so no body data is ever used for school athletes.
- **Fit Advisor** (`services/fit/advisor.ts`, `components/fit/FitAdvisor.tsx`) is the shopper-facing half: cold-start sizing for someone with no history, via height/weight or "I wear an M in <brand>". It works on ease — finished garment (`garment-specs.ts`) minus estimated body (`body-model.ts`) — per zone. `FitSilhouette.tsx` draws the body outline scaled to that estimate with the garment over it; **the ease in that drawing is exaggerated (`EASE_PX_PER_IN`) for legibility**, the quoted inches are true.
- **Tenants.** `lib/tenants.ts` holds per-business config (endpoint, branding, openers, welcome) and `ChatPanel` takes a `tenant` prop. `/` is Caroma → `/api/chat`; `/shop` is apparel → `/api/shop`. **`showFitAdvisor` exists only on `/api/shop`** — it is a clothing tool and was deliberately removed from the bathroom journey. `/api/shop` has a deterministic `localReply` fallback so the apparel demo runs with no valid `OPENAI_API_KEY`.
- `resolveGarment` prefers our own stored spec over anything the model passes; with neither a known `styleId` nor a usable retrieved chart it returns `null` and no advisor is shown.
- Straight-cut garments (crew tee, jerseys) declare `zones: ['chest']`. Their "waist" measurement is hem width, and judging it against a body waist reports every slim wearer as "loose" — a fact about the pattern, not the person.
- `checkSizes` is a UI tool on `/api/csr` — like the other UI tools it is never executed server-side. The model is forbidden by system prompt from stating a size conclusion itself; it can only call `checkSizes` and let the workspace answer.

## Authentication

Two audiences, deliberately treated differently:

- **Staff** — `/csr` and `/fit` require a signed-in session. `src/proxy.ts`
  redirects unauthenticated browsers to `/login`.
- **Shoppers** — `/`, `/shop` and `/advisor` need no account. They still receive
  an *anonymous* session so rate limits key on a browser rather than an IP that
  a whole school or call centre shares.

**An anonymous session must never satisfy an authorisation check.** Everyone gets
a cookie, so "has a session" is not "is signed in" — `role` is what grants access,
and `requireStaff` checks exactly that. Getting this backwards would open the
reorder desk to the public.

**`src/proxy.ts` is not the security boundary.** It is `middleware.ts` renamed
(Next 16; it now defaults to the Node runtime). It does an *optimistic* cookie
check only — it runs on prefetches and never sees a direct API call. The real
check is `requireStaff` inside each protected route handler. Any new staff-only
route must call it; adding a path to `STAFF_PATHS` alone protects the page and
not the data.

**The proxy cannot see revocation, and this was learned the hard way.** Next
bundles the proxy separately from route handlers, so module-level state is a
*different instance* there — the in-memory revocation store the proxy would
consult is not the one the login route writes to. Checking revocation in the
proxy compiles, runs, and silently does nothing. ("You should not attempt
relying on shared modules or globals" — the proxy docs, meant literally.)

Two consequences, both load-bearing:

- `/api/auth/me` clears a cookie that decodes as staff but fails verification.
  Without it the browser keeps presenting a dead cookie the proxy keeps
  accepting.
- The "already signed in, skip the login form" redirect is **suppressed when
  `?next=` is present.** A client bounced to `/login` because its session
  turned out to be dead arrives with `next`, and its cookie still looks valid
  to the optimistic check — redirecting it back is an infinite loop between the
  page it cannot use and the form it needs.

**The proxy also leaves `/api/auth/*` cookies alone.** It issues anonymous
sessions elsewhere, but doing so there puts a second `Set-Cookie` for the same
name on a login response, and which one the browser keeps is a coin toss — a
successful sign-in can end up storing the anonymous cookie.

Sessions are HMAC-SHA256-signed payloads in an HttpOnly cookie
(`src/lib/auth/session.ts`), carrying a `jti` so a single session can be
revoked by name. Staff sessions last 8 hours.

**`decodeSession` vs `verifySession` is a real distinction, not a synonym.**
`decodeSession` checks signature and expiry only. `verifySession` also checks
revocation, and is what `sessionFromRequest` — and therefore `requireStaff` —
uses. Only the proxy uses the weaker one, for the reason below.

**Revocation** (`src/lib/auth/session-store.ts`): `revokeToken(jti)` for one
session, `revokeAllFor(user)` for all of them via a per-user cutoff timestamp
that also kills sessions this process never saw. `revokeAllFor` takes an
`exceptJti` — a password change and MFA activation both re-issue the current
session and exempt it, so neither signs you out of the tab you are standing in.
A session with no `jti` **fails closed**.

**Two directories** (`src/lib/auth/users.ts`), both `UserDirectory`:

- `JOURNEYAX_USERS` — read-only. Fine for fixed pilot accounts. Password
  changes, MFA and recovery codes are *impossible* against it, and the routes
  return `501 directory_read_only` rather than pretending to succeed.
- `JOURNEYAX_USER_STORE=./data/users.json` — writable, and takes precedence.
  **The file holds password hashes and TOTP secrets.** It is gitignored; keep
  it out of backups that travel. Single-instance only — two processes writing
  it will clobber each other.

**Lockout** (`src/lib/auth/lockout.ts`): 5 failures locks an account for 15
minutes. Per-account, so spreading attempts across IPs does not help, and
*temporary* on purpose — a permanent lock turns anyone who knows a username
into a denial-of-service.

**MFA** (`src/lib/auth/totp.ts`): RFC 6238 TOTP on `node:crypto`, no dependency,
verified against the RFC's published test vectors. `totpLastStep` blocks replay
within a code's 30-second window. Recovery codes are single-use and stored
hashed. A secret lives in `pendingTotpSecret` until a code proves it — writing
straight to `totpSecret` would lock people out of their own accounts when they
abandon enrolment.

**There is no email-based password reset**, and that is a decision rather than
an omission: it would mean shipping a mail dependency and a token store, and it
is only ever as strong as the mailbox behind it. Recovery is out-of-band —
an administrator issues a temporary password and the account must change it at
next sign-in.

```bash
npx tsx src/scripts/make-user.ts add     <username> <csr|admin>
npx tsx src/scripts/make-user.ts reset   <username>   # temporary password
npx tsx src/scripts/make-user.ts mfa-off <username>   # lost device
npx tsx src/scripts/make-user.ts list
```

**Lockout and revocation are in-process.** Both reset on restart and neither
coordinates across instances — a revoked session stays alive on every other
instance. `setSessionStore` is the seam; move both at the same time as the
rate limiter.

**Password hashes use `.` as the separator, not the conventional `$`, and
base64url rather than base64.** This is not cosmetic: these hashes live in
environment variables, and `$` triggers variable expansion in `.env` files,
docker-compose and most shells — `scrypt$32768$8$1$…` silently becomes `scrypt`
followed by fragments, and every login fails with no useful error. Do not
"correct" the format back to `$`.

`SESSION_SECRET` must be at least 32 characters. `session.ts` **throws on
startup** in production if it is missing rather than falling back to a
development default, because a predictable secret lets anyone mint a staff
cookie — worse than no auth, because it looks secure.

## Request handling

Every API route now starts the same way: `guard()` from `lib/api-guard.ts` applies
a rate limit, caps the body size, parses JSON and rejects anything that is not an
object — returning a finished `Response` the handler passes straight through.
Handlers no longer see malformed input, and no route returns `error.message` to the
browser any more (it leaked upstream provider detail). Errors go to `lib/logger.ts`,
which silences `debug`/`info` in production.

`lib/rate-limit.ts` is an in-process sliding window: 20/min on the model-backed
routes, 120/min on `/api/quote`. It is keyed by IP because **there is still no
authentication** — it raises the cost of casual abuse and is not a security
boundary. It also does not coordinate across instances; swap the `hits` map for
Redis before running more than one.

## Things that will mislead you

- **Money is verified server-side, but only if you ask.** The maths lives in
  `lib/pricing.ts` and both sides run it. The browser's figure is a *preview*;
  `/api/quote` is the number of record, and `handleApprove` refuses to create an
  order until it returns `acceptable: true`. Any new checkout path must do the
  same — the model still supplies per-line prices, and nothing else validates them.
- **The scraped-page parsers are the most fragile code here.** `parseSpecs` and `parseImages` (`services/knowledge/page-parsers.ts`, extracted from `route.ts` so they could be tested) are positional string-slicing against Caroma's page template. `parseSpecs` assumes the specs table flattens to *alternating lines* and is introduced by the literal word "Specifications". When the site's layout changes these do not throw — they return `{}`, the model gets no specs, and it starts answering vaguely. `page-parsers.test.ts` has a section pinning those layout assumptions explicitly: if one fails, the parser is not buggy, the source format moved.
- **Conversation history is trimmed before every request** (`lib/conversation.ts`). There is no server-side session, so the whole history is resent each turn; without trimming, cost grows with the square of the conversation and a long journey eventually exceeds the context window and dies at the point the customer has invested most. System messages and the *first user message* always survive — losing the opening brief is how the assistant forgets it is designing a bathroom by turn 30. Dropped messages are replaced by one system note, so the model knows it is working from an abridged history rather than assuming nothing happened.
- **The tool loop can exhaust `maxLoops` mid-flight.** When it does, the last assistant message has `content: null` because its substance was in `tool_calls`, and the browser rendered that as an empty bubble. `route.ts` now substitutes a sentence. If you raise `maxLoops`, keep that fallback.
- **`.env` is git-ignored but present**, and carries keys for a much larger microservice platform (auth/gateway/product/analytics service URLs, Stripe, WhatsApp). This POC only uses `OPENAI_API_KEY` and `MONGODB_URI`.
- The system prompt in `route.ts` is ~50 lines of numbered CRITICAL RULES enforcing the phase order, no-hallucination policy, room scoping, and BOM accumulation. Behavioural changes usually belong there, not in code.
