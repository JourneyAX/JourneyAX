# JourneyAX / Augusta — Journey Regression Report

**Last run:** 2026-07-21
**Scope:** the Augusta (Momentec Brands) team-kit journey, end to end.

---

## ✅ STATUS: GREEN — 6/6 (quota restored)

Provider: **OpenAI `gpt-4o`** (chat) + `text-embedding-3-small` (retrieval).

```
[volleyball-girls] turn1=['researchSchool'] turn2=['showItems'] products=['342213','344110','A24000']
[baseball-boys]    turn1=['researchSchool'] turn2=['showItems'] products=['221221','356S2B']
[soccer-womens]    turn1=['researchSchool'] turn2=['showItems'] products=['321510','321520','321522']
[basketball-mens]  turn1=['researchSchool'] turn2=['showItems'] products=['228118','228125','228150','228218']
[football-boys]    turn1=['researchSchool'] turn2=['showItems'] products=['228187','228287','258','750EY']
[hockey-girls]     turn1=['researchSchool'] turn2=['showItems'] products=['228108','CUT_DK8380']

CROSS-SPORT DISTINCTNESS: OK — every sport returned a distinct product set
6/6 scenarios passed; 0 cross-sport overlaps
```

Also confirmed this run: embeddings OK (1536 dims); sport-correct search
(volleyball→volleyball, baseball→baseball, soccer→Sheffield/Wembley); and the
journey **close** — "that's everything, what's next?" → `updateQuote` **$911.40 USD**
→ "Approve & pay securely".

### Prior incident (resolved) — OpenAI quota exhaustion
A run returned **0/6** with every LLM call failing `429 insufficient_quota`. It was
NOT a code regression. Two things it broke, worth remembering:
1. **Chat** — endpoint still returned HTTP 201 but with an error body and
   `uiActions: []`, so it merely *looked* like "the agent does nothing".
2. **Embeddings** — vector search died and fell back to regex, which returned
   **the same products for every sport** — indistinguishable from the original
   "no difference between football/soccer/volleyball" bug.

Lesson: if sports stop differentiating, check embedding health before suspecting
retrieval logic.

---

## What the suite covers

Two-turn flow per scenario, across sport × gender:

1. **Turn 1** — name the sport, gender and school ("volleyball jerseys for
   Oswego East, girls varsity, 14 players").
2. **Turn 2** — confirm the researched colours ("Use Navy and Silver. Show me
   the options.").

### Assertions
| Check | Why it exists |
|---|---|
| Turn 1 calls `researchSchool` | Research must be the opening move, once per journey |
| No `showConfigurator` with an **empty SKU** | An empty render is why every sport looked identical |
| Turn 2 returns a **real product** | Confirm must advance to actual retrieved styles |
| Product names match the **sport** | Catches the soccer↔football embedding collision |
| **Cross-sport distinctness** | No two sports may return the same product set |

### Scenarios
`volleyball-girls`, `baseball-boys`, `soccer-womens`, `basketball-mens`,
`football-boys`, `hockey-girls`.

---

## Last known-good result (before quota block)

```
[volleyball-girls] turn1=['researchSchool'] turn2=['showItems'] products=['344110','A24000']
[baseball-boys]    turn1=['researchSchool'] turn2=['showItems'] products=['221224','356S2B']
[soccer-womens]    turn1=['researchSchool'] turn2=['showItems'] products=['321510','321520','321522']
[basketball-mens]  turn1=['researchSchool'] turn2=['showItems'] products=['228125','539J','54MMR','857000']
[football-boys]    turn1=['researchSchool'] turn2=['showItems'] products=['228187','228287','PWFFY1']
[hockey-girls]     turn1=['researchSchool'] turn2=['showItems'] products=['228108','CUT_DK8380']

CROSS-SPORT DISTINCTNESS: OK — every sport returned a distinct product set
6/6 scenarios passed; 0 cross-sport overlaps
```

Also verified manually at that time:
- **Journey close:** completion signal ("that's everything / what's next") →
  `updateQuote` builds a real quote (**$911.40 USD**) → "Approve & pay securely".
- **Full uniform:** "add matching shorts" → returns a real matching product.
- **Gender correctness:** "girls" → Ladies/Girls styles, not generic.
- **3D render:** naming a SKU ("design style 228358 in 3D") renders reliably.

---

## Known non-deterministic edge

Asking to design by **long product name** ("Design the Ladies FreeStyle
Sublimated Cap Sleeve Volleyball Jersey in 3D") sometimes gets *narrated*
instead of rendered. Naming the **SKU** ("design style 228358") renders every
time. Demo-safe path: confirm → products (SKUs visible) → "design style N".

---

## How to re-run

The harness currently lives in the session scratchpad (temporary):

```
python3 <scratchpad>/regress.py
```

It only needs `agent-commerce-service` on :3004 and `product-service` on :8083.

> **Note / tech-debt:** the harness is Python, which conflicts with the repo's
> TypeScript-only convention. It should be ported into the existing
> `apps/agent-commerce-service/src/eval/` suite so it lives in the repo and runs
> in CI, rather than a temp file that gets cleaned up.

## 2026-07-21 — Session memory, back-office performance, conversations

### Server-side conversation memory: CONFIRMED working (was broken by a client bug)

The lifecycle memory is real and always was — `SessionStore` (Mongo `journeyx.sessions`)
persists the full transcript + typed `journeyState` every turn, and `processChat`
rehydrates the WHOLE history (no truncation window). What was broken: the browser
never captured its own `sessionId`, so every turn opened a fresh session.

Cause: `streamChat` only parsed SSE frames terminated by a blank line; the final
`done` frame — which carries `sessionId` — was left in the buffer and discarded.
Fixed by draining the buffer after the reader ends.

Evidence after the fix (same session accumulating):
```
8767b250 | augusta | turns=3 | msgs=6  | teamSize=14 | activeSku=228358
b0eb4dcf | augusta | turns=4 | msgs=8  | teamSize=18 | activeSku=227130
```
Note: sessions have NO TTL index — nothing is deleted. `summary` is never populated
(rolling summarisation is unimplemented); history grows unbounded per session.

### Back-office performance

Measured cause — NOT the database. Mongo's slowest query was 1021 ms; everything
else was 17–44 ms. The cost was: no cache anywhere, every tab refetching on every
visit, each request firing 2–3× from duplicate effects, plus Next dev compile on
first hit.

| endpoint | before | after |
|---|---|---|
| `/api/insights` (Dashboard/Analytics/Orders) | 1274 + 1964 ms (×2 per visit) | 205 ms ×1 cold, 17–47 ms warm |
| `/api/catalogue` | 549 + 699 + 501 ms (×3 per visit) | 24 ms ×1 |
| `/api/knowledge/stats` | 1468 + 2933 ms (×2) | 81 ms |
| cold `/api/insights` (first ever hit) | 15.1 s | 0.03 s |

Changes: new `@journeyax/cache` (Redis when `REDIS_URL` is set, in-process
otherwise; project-scoped keys, single-flight, 7-day TTL ceiling); server caching on
insights/catalogue/knowledge-stats; client-side single-flight + 45 s cache in
`authedFetch`; `documents.countDocuments($or)` → indexed `projectId` (1021 ms → 44 ms).
Invalidated on any project write (BFF), on ingest completion, and on workspace switch.
`?refresh=1` bypasses both layers — every Refresh button passes it.

### Conversations (AUG-77)

Sessions are now per CONVERSATION, not per project. New-conversation + switcher in
the chat header; legacy single-thread keys migrate into the first conversation.
Verified: a new thread has no memory of the previous school; switching back restores
the earlier thread's context, across a full page reload.

### Regression

`EVAL_FAST=1 run-evals` → 11/11 passed (Caroma unaffected).

## 2026-07-21 (later) — AUG-68 direct product questions, AUG-57 design concepts

### AUG-68 — a named style now opens the designer

Two separate faults, both fixed:

1. **Research hijacked the turn.** STEP 0 held every turn back to ask "are these
   your colours?", including turns where the customer had already named a style.
   Research still runs and the colour card still appears; it only *gates* the turn
   when the colours are genuinely the open question (`alreadyKnowsWhatTheyWant`).
2. **A named style was answered with a form.** "show me 227130 in serpentine…"
   produced four clarifying questions and an empty panel. `noteNamedStyle` now
   instructs the agent to call `showConfigurator` for that style THIS turn and ask
   the rest afterwards. Applied to BOTH agent paths (the AUG-38 parity trap).

Style-code detection: 6–8 digits, or 5–8 mixed letters+digits. Five bare digits is
deliberately excluded — that is a ZIP, not a style. 14/14 phrasing cases correct.
Existence is checked with `POST products/skus/exists` (exact membership), NOT the
fuzzy search — the first attempt used search and silently dropped `PG8130` because
another product ranked higher.

Verified: `Design PG8130 in 3D, orange` → `showConfigurator`;
`show me 227130 in serpentine, red and royal, for Westfield High` → `showConfigurator`;
`Baseball jerseys for Westfield High, 18 players` → still the guided path.

### AUG-57 — three concepts, then 3D

New `concepts` phase between the product card and the designer. Each card is the
REAL composed print for that design line on that style (same artwork the 3D view
wraps), rendered in the team's colours. Clicking one applies that design line and
opens 3D — no agent turn in between.

Also fixed while building it:
- **Confirmed team colours never reached the design.** `SET_SCHOOL_RESEARCH` now
  seeds `design.baseColor/accentColor` from the palette-mapped colours, so concepts
  and the first 3D render arrive in the team's colours instead of stock ones.
- **The agent's own turn preempted the choice** (and, separately, threw a fresh
  quote off the panel). `SET_PHASE` now refuses configurator while the customer is
  mid-choice, and refuses it over a quote for the same style.
- **The pick sent a chat message** whose reply raced the opening designer and left
  it stuck on "Building your garment…". It is now a local note — the click already
  applied the design line; the agent has nothing to decide.
- Concept art is not lazy-loaded (three above-the-fold images) and shimmers until
  the composite arrives rather than showing empty frames.

Verified: research → confirm → cards → Design → 3 concepts (BRAID/INTEGRATE/
STRIKEOUT, all carrying the team colour) → pick CHOPPER → 3D renders in orange.

`EVAL_FAST=1 run-evals` → 11/11 passed.

## 2026-07-21 (later still) — AUG-67 unblocked: the design corpus was invisible

The blocker was misdiagnosed. `character` (the measured visual reading) was never
missing — 7,436 documents carry it, 6,860 non-empty. What was missing were the two
fields RETRIEVAL filters on:

| field | before | after |
|---|---|---|
| `metadata.type = design` | 1,699 | 9,135 |
| `metadata.brand = augusta` | 4,282 | 11,818 (design docs missing it: 7,436 → 0) |

The design/cap ingest stages write `docType` and `projectId`; search filters on
`metadata.type` and `metadata.brand`. So every measured design document was
unreachable whenever a type filter was passed — the needs mapping had nothing to
rank, which is why it looked unimplemented.

**Fixed as data, not as a query.** An `$or` at query time is not available: the
Atlas vector index declares only `metadata.brand`, `metadata.type`,
`metadata.category` as filter paths (verified via `listSearchIndexes`), and
filtering on a path it does not know silently degrades the whole query to regex.
Filtering on `projectId` directly — the real isolation key (AUG-19) — has the same
problem until the index is redefined. New maintenance op **`sync-doc-type`**
(dry-run by default, copy-only, never overwrites an existing value) mirrors
`docType → metadata.type` and `projectId → metadata.brand`. 7,536 documents synced.

Verified at the index: `$vectorSearch` with `{metadata.brand: augusta,
metadata.type: design}` now returns design documents with real scores (0.71–0.73)
and their `character` arrays. Before the backfill it returned none.

### Open — retrieval is running on REGEX, not vectors

Every query through the running product-service returns `score = 0`, including
plain product searches, and "bold modern look" returns colour-swatch PDFs. The
cause is NOT the data: the same key embeds fine right now (1536 dims) and the same
vector query succeeds from a standalone script. The long-running product-service
process was started while the key was unusable (the quota incident) and still holds
that client; `embedText` swallows the failure and falls back to regex by design.

**Restart product-service to pick up the working key** — nothing else is needed,
and until then all retrieval quality (not just design) is regex-level. The service
was left running untouched rather than restarted mid-session.

## 2026-07-21 (evening) — AUG-78: 3D-first offers (the "3D not working" loop)

User-reported conversation: three basketball items offered in a row, every
preview failed, then fixed-colour headwear was offered with a Design button.

### Root causes found
1. **Unproven items were offered.** "Man Up" and "All-Over Pattern" had NO
   product record at all (text chunks wearing product names); "Dominant"
   (UPB110) has a print template but no 3D mesh. Only 381/677 sublimated styles
   are fully proven (template + mesh). Retrieval ranks on text and cannot know.
2. **A field-name mismatch put Design buttons on stock items.** The designability
   annotation wrote `customisable`; the storefront button gates on `designable`.
   The visor the agent had just called "not customizable" still showed
   "Design this in 3D".
3. **Retrieval noise from the earlier metadata gap** compounded it (fixed by the
   sync-doc-type backfill; the "regex fallback" theory itself was a misdiagnosis —
   the search API never serializes `score`, so score=0 proves nothing. Vector
   search verified live: "top for playing hoops" → basketball jerseys).

### Fix — enforced in code, config-driven (no Augusta hardcoding)
`enforceItemDesignability` gains a design-first mode, gated on the project's
brand-hub `model.customised` flag. In that mode: PROVEN styles are kept;
definite stock and unproven items are dropped; if nothing proven survives,
proven alternatives of the same kind replace the list (name-fallback added for
items with no product row); unknowns survive only over a blank panel. Both
`customisable` AND `designable` are now written, and labels are written even
when nothing is dropped (a first version returned early and shipped proven
jerseys unlabelled). Non-design-first projects (Caroma) keep the old
augment-don't-filter behaviour. Applied to all three paths incl. forceUiTool.

Also hardened: product-service dotenv now uses `override: true` (a stale key
inherited from a long-lived turbo supervisor survives any child restart
otherwise) and the OpenAI client self-heals on embed failure instead of pinning
the process to the regex fallback until someone restarts it.

### Verified end to end (browser)
"Loud aggressive bold basketball jerseys for Naperville North, mens, 15 players"
→ research card → confirm → exactly 2 items, BOTH proven (228118, 228125,
designable:true, 42/35 design lines, mesh:true) → Design → 3 concepts → pick
SPEEDY → 3D basketball jersey renders in orange. Zero "can't preview" apologies.
Evals: 11/11 (Caroma unchanged).

## 2026-07-21 (late) — clarify-before-options softened; AUG-46 running total

### STEP 0 no longer holds product hostage (config change, published v26)
The demand for a school before ANY product came from the project's own
`persona.journeyGuidance`: *"Do NOT list or describe products yet."* Changed
through the back office (draft → publish), not code:

> STEP 0 — WHO IS IT FOR (ask ONCE, never twice) … ASK ONLY ONCE. If they answer
> without naming a specific school, decline to name one, or say anything like
> "just show me" / "skip the questions", go straight to STEP 3 and show real
> styles for the sport and gender you DO have … You still need the school before
> STEP 4 — ask for it then, when it actually decides the colours, and say why.

Verified: "…mens, 15 players. Skip the questions, show me options." → products
immediately, no clarify form.

### A second hole in the 3D-first guard, found by that test
The softened flow surfaced 7 items with **no sku at all** — design-line
DOCUMENTS ("MAN UP — FREESTYLE SUBLIMATED TURBO DYNASPEED BASKETBALL JERSEY"),
i.e. the exact items that failed in the user's transcript. `enforceItemDesignability`
returned early when no sku was present, so the guard never ran on the worst case.
Now, in design-first mode, code-less rows are REPLACED by real proven styles
(matched on the design document's own name). Verified: the 7 became 4 styles
(3B4VTA, 228110, 228118, 228210) — all renderable:true, meshes present, 34–49
design lines each.

### AUG-46 — live count + running price on the kit pill
The pill showed a count only. It now also shows the running total, priced by the
SAME server quote engine as the quote screen (never client arithmetic, P0-04) and
carrying the roster quantity, so it is the real order value. Debounced 400ms;
retries up to 3× because the effect only re-runs when the rack changes — a single
transient failure previously left the figure blank for the whole session. The
rack's own button shows it too ("Build quote for 1 item · $1,052").

Verified in browser: pill reads "Your kit 1 $1,052"; rack button matches.
Typecheck clean on all three apps; evals 11/11.

## 2026-07-22 — Demo flow hardened end to end (Augusta team kit)

Ran the whole journey cold and fixed everything it hit. Three real faults, all
found by walking the flow rather than testing pieces.

### 1. The team's primary colour never reached the garment
`renderer-config` served the SEED palette — 14 hand-typed colours (NAVY,
SCARLET, WHITE…) with no entry containing the word "blue" — while the ingest had
captured the brand's real 111-colour palette into `brand_palettes` and nothing
consumed it. So Naperville North's BLUE mapped to nothing, the jersey rendered
in one colour, and three "different" concepts came out identically orange.

- `getRendererConfig` now serves the CAPTURED palette when one exists (cached
  1h, config still wins when there is no capture): 14 → **111 colours, 11 blues**.
- `nearestInPalette` tie-break: a candidate carrying a SECOND colour word is a
  blend, not a shade. "Blue" was landing on "Blue Grey" (a grey); it now returns
  **BRIGHT BLUE**. Verified across Blue/Orange/Gold/Green.
- Cached research is **re-mapped against the current palette on every read**.
  The colour match is derived data and was frozen into the cache — every school
  researched before the palette grew would have kept "no match" forever.

Result: **"3 looks in Bright Blue and Orange"**, three visibly different designs.

### 2. Chat contradicted the panel at the concepts step
Clicking Design made the agent render a design line of its own ("Fast Break")
while the customer was choosing from the concepts. The message now states the
customer picks the design line and tells the agent not to choose or render one.

### 3. Pricing a kit took 9.4 seconds — on the step everyone watches
`getBySkus` pulled WHOLE documents (each with a 1536-dim embedding, dozens of
chunks per style) and matched SKUs with no index — the AUG-43 trap, in the money
path. Fixed with a field projection, two new indexes
(`metadata.brand+metadata.sku`, `+metadata.specs.Item Code`), and a per-project
pricebook cache (prices are catalogue facts; dropped on ingest/publish).

| | before | after |
|---|---|---|
| pricebook | 9.7s | 5.3s cold → **4ms** warm |
| kit/quote (end to end) | 9.4s | **0.15s** |

### Verified (browser, cold start, one pass)
research card w/ sources → confirm → 4 proven styles, all with Design buttons →
3 distinct concepts in team colours → pick OVER AND BACK → 3D renders blue with
orange piping → add to kit (pill shows "1 · $1,052") → Build quote → **$70 × 15
= $1,052**, lead time, Approve & pay. Zero failures.
Typecheck clean on all three apps; evals 11/11.

## 2026-07-22 (afternoon) — payment confirmation + back-office truth + catalogue speed

### AUG-79 — the customer paid and was shown nothing
Stripe returned to `?order=…&status=success`; the storefront showed the intro
hero. Root cause: the order sat at `pending_payment` because the **webhook never
arrives** — Stripe cannot reach a service that is not publicly routable, which is
every laptop and private environment. The UI polls for `paid`, gave up after 12
tries, and fell back to the hero.

Fixed by asking Stripe directly when an order is still unpaid: `checkout.sessions
.retrieve` over a server-to-server call, the same authority the webhook carries —
NOT the browser's `?status=success`, which anyone could type. Whichever arrives
first writes the same transition. Also:
- `GET order/:id` returned a total and nothing else, so the panel fell back to
  (empty) client state and showed **"Price on request"** to someone charged $161.
  Orders store `quoteId`, not lines — the lines are now read back from the quote.
- `OrderedPanel` renders from the ORDER, not from this browser tab (the tab's
  state is wiped by the payment redirect), and the copy no longer promises a
  confirmation email that nothing sends.

Verified on the real order: **"Payment received · You're all set"**, all four
line items with SKUs and quantities, **Paid $161.10**.

### Fix 2 — Team Orders was reading a shape nothing writes
The view built its list from `sessions.state.bom` — the pre-P0-04 shape. Quotes
now live in `quotes` and orders in `orders`, so the screen showed **0 while 52
quotes and 3 orders existed**. It now reads both collections, and a quote that
has been paid for shows as **ordered** rather than appearing twice.
Verified: 25 quotes, 4 orders, the paid one green.

### Fix 1 — Gear Catalogue: 14.5s → 0.47s cold
Caused by my own `sync-doc-type` backfill this morning: `metadata.brand` went
from 4,282 to 11,818 documents, which inflated the `$or` branch.
- Dropped the `$or` for the single indexed field (verified every project now has
  full `metadata.brand` coverage: augusta 11818/11818, caroma 3770/3770).
- `$project` before `$sort`/`$group` so embeddings never travel (the AUG-43 trap
  again — third place it has appeared).
- New index `metadata.brand + metadata.type + updatedAt`.

| | before | after |
|---|---|---|
| catalogue cold | 14.5s | **0.47s** |
| catalogue warm | 0.03s | 0.03s |

Also: the header asserted **"0 products"** while loading (there are 2,350) — it
now says it is loading rather than stating the opposite of the truth.

Typecheck clean on all four apps; evals 11/11.
