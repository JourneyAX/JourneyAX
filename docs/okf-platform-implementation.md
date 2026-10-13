# OKF governed knowledge and tenant-owned platform settings

Scope: PlaceMakers and Workwear Group (the active tenants). MongoDB is the operational source of truth; OKF
bundles are the portable interchange format (export/import); GCS holds immutable release artifacts and is never
read per turn. `packs/` is migration input only.

## What lives where (nothing business-specific is in code)

| Concern | Owner | Stored in | Validated by |
|---|---|---|---|
| Concepts, relationships, evidence, verification, commerce policy | Back office (OKF Studio) | `okf_drafts` → immutable release (`okf_releases` + release-scoped collections) | `packages/knowledge` validator, server evaluation, human attestation |
| Decision lexicon (intents, SKU grammar, verifier roles, messages) | Platform defaults + tenant `policy` block in the OKF release | `packages/knowledge/src/defaults/platform-policy.json` + release content | `validateOkfTenantPolicy` (token-phrase grammar, no regex from stored data) |
| Tenant acceptance scenarios | Tenant | OKF release `acceptanceScenarios` | executed at publication |
| Catalogue field mapping (price, currency, stock, lifecycle, attributes, category scope, planner category rules) | Back office → *Pack settings* | project doc `catalogMapping` → Business Pack (checksum-bound) | `CatalogMappingSchema` (paths only, no operators) |
| What a fact *means* (measurement / money / quantity / multiple) | Fact registry `role` / `multiple`, OKF fact `extensions.role` | Business Pack `factRegistry` | schema enum |
| Interpretation wording (money/quantity expressions, prompt rules, fallback messages) | Platform defaults + pack override | `apps/journey-runtime-service/src/defaults/interpretation-policy.json` + `extensions.interpretationPolicy` | `validatePackSettings` |
| Idle re-pin of conversations | Pack | `extensions.workspacePinPolicy.idleRepinAfterHours` (absent = never) | `validatePackSettings` |
| Environment (dev/test/staging/production) | Publish request | per-environment releases, pointers, history, rollback | `resolvePublicationEnvironment` |
| New-project defaults, dev seed tenants | JSON files | `apps/project-service/src/defaults/new-project.json`, `apps/project-service/seed/*.json` (opt-in) | `seed-loader` |
| Operational ceilings | Platform data | `packages/knowledge/src/defaults/limits.json` | `resolveOkfLimits` |

Rule of thumb enforced by `scripts/ci-hardcoding-guard.ts`: no tenant names, fixed models/currencies, positional
journey/agent picks, key-spelling heuristics, invented human identities, localhost fallbacks or assumed currency
symbols in platform source.

## Stage history (all on `JourneyAX-dev-v4`, one commit per stage)

1. OKF hardening, authoring/attestation/interchange, runtime control plane, basket commerce, claim validator.
2. CDL removal (docs/scripts/data/artifacts, Python retexture-service, backend, web flows) — moved to
   `Caroma-Poc/CDL/` outside this repo with a `MANIFEST.md`.
3. Data-driven decision policy; runtime wording and SKU/topic detection from policy.
4. Shared test infrastructure (`@journeyax/test-support`: in-memory Mongo fake, structured reporter).
5. Environment-aware Business Pack publication, rollback and history.
6. Catalogue mapping + safe currency handling; basket lifecycle vocabulary from the mapping.
7. Fact semantics from the pack; interpreter/composer wording and price formatting from policy.
8. Revocation API (create/list/lift with a corrected release, unique event index, bounded history).
9. Draft size ceiling; metadata-only release storage verified.
10. Workspace pin lifecycle; explicit principals; environment-aware service URLs.
11. Test runner, stricter guard, opt-in JSON seeds.
12. Server-owned entity hashes + draft analysis; OKF Studio; tenant pack settings.

## Operating notes

**Revocation** (`knowledge.revoke`, manager/admin). `POST /projects/:id/knowledge/revocations` withdraws concepts of a
published release immediately and requires a reason and an explicit expiry. `POST .../revocations/:revocationId/lift`
requires a *corrected release* whose revoked concepts really changed (or were retired). Events are append-only with a
unique `(tenant, environment, revocationId, eventType)` index; the safety read path uses primary/majority; `.../prune`
archives terminated history. Every call is attributed to the authenticated principal and logged as structured JSON.

**Verification.** The Studio queue assigns a verifier; only that verifier (not a draft author) attests, and the
service enforces tenant verifier-role membership. Editing a verified concept makes its verification stale — the server
rebinds content hashes on save and never silently keeps an old verification valid.

**Publishing.** Studio → *Publish immutable OKF* → *Publish Business Pack* (same environment). Non-production
publishes never disturb the production Studio state; rollback is scoped to the environment of the snapshot.

**Pin policy.** Conversations stay on the release they started with. A pack may opt in to moving *idle, active*
conversations onto the active release, only when that release still contains their journey and stage.

## Tenant actions required before relying on the new behaviour

These are data changes made through the back office (they cannot live in code any more):

1. **Fact roles.** Facts that are measurements, money or quantities need `role` (`measurement` | `money` |
   `quantity`) in the fact registry, or `extensions.role` on the OKF fact. Facts that hold several values need
   `multiple: true`. Without a role the interpreter no longer guesses from the key name.
2. **Catalogue mapping.** Workwear Group's `priceUSD.min` / `variants[0].msrpUSD` prices and any attribute aliases
   (for example `toeType` → `toeProtection`) must be declared in *Pack settings → Catalogue mapping*, with the price
   currency stated explicitly. A price without a declared currency is treated as unpriced.
3. **PlaceMakers planner rules.** Apply `docs/migrations/placemakers-component-category-rules.json` (the former
   built-in category table) to the PlaceMakers `catalogMapping`.
4. **Service URLs.** In production every service URL must be configured (`AUTH_SERVICE_URL`, `PRODUCT_SERVICE_URL`,
   `PROJECT_SERVICE_URL`, `GATEWAY_URL`, …); localhost fallbacks apply only when `NODE_ENV` is not `production`.
5. **Dev seeds.** Seed tenants are no longer created on startup. Set `PROJECT_SEED_ENABLED=true` (bundled dev seeds) or
   `PROJECT_SEED_DIR=<dir>` for local development only.
6. **AI model.** A project must state `ai.provider` and `ai.model`; publication fails closed instead of assuming one.
7. **Currency (and optionally locale).** A project must state `pricing.currency`; the pack's `profile.primaryCurrency` is taken from
   it and publication is blocked when it is missing. Before this stage the pack silently took the schema default (`AUD`), which
   made every NZD-priced product fail the runtime's currency filter. `profile.primaryLocale` / `supportedLocales` /
   `supportedCurrencies` are optional project settings carried into the pack.

## Testing and logs

```bash
npm test                 # core suites + type-checks + hardcoding guard (writes logs/test-runs/<timestamp>/)
npm run test:all         # adds the extended suites
node scripts/run-all-tests.mjs --only knowledge,project-service
```

Each run writes `summary.md`/`summary.json`, one `<suite>.log` per suite and structured `structured/*.jsonl`
(one JSON line per test with duration and error) via `JOURNEYAX_TEST_LOG_DIR`. Exit status is non-zero on any failure.
`logs/` is git-ignored.

## Known gaps / decisions

- `agent-commerce-service` (legacy path) still contains its own domain code; it is covered by the guard's new
  rules but not refactored.
- The Studio's fact-role editing is via the advanced JSON editor (OKF `extensions.role`); a form is a follow-up.
- Mixed-currency catalogues are filtered, not converted; the platform never converts currencies.
- Pre-existing lint errors in `ConfiguratorPanel` (react-hooks/refs) are unrelated and untouched.

## Taxonomy ingestion (Phase 3)

`packages/knowledge/src/ingest` builds a navigable OKF draft from a tenant's real catalogue taxonomy. It is
domain-neutral: the input is a dated snapshot plus a tenant config (`scripts/okf/tenants/<tenant>.ingest.json`) that holds every
question template, threshold, commerce ceiling and wording choice.

```bash
npm run okf:snapshot -- placemakers scripts/okf/tenants/placemakers.ingest.json   # read-only capture → docs/inventory/…snapshot.json
npm run okf:ingest -- docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json scripts/okf/tenants/placemakers.ingest.json logs/okf/placemakers
```

Outputs (`logs/okf/<tenant>/`): `draft.json`, `coverage.{md,json}`, `departments/<slug>.md`, `bundle.zip` (department
indexes for review). The committed review copy is `docs/coverage/<tenant>/`.

What it generates: one concept per department, group and category (not per SKU) with exact catalogue category
identifiers, `child_of` relationships, a navigation question per parent (from the config template), name-derived
synonyms, model-generated search phrases and candidate document sources. What it never generates: any claim class, any
verification, any evidence chunk. Every generated item carries `x-journeyax-provenance`, and `auditProvenance` rejects a
draft where derived material is marked verified, asserts a claim, or exceeds the configured commerce ceiling.

Known limitations (see the coverage report warnings): some category names occur in more than one department, so an
identifier can also select products elsewhere (needs path-scoped matching in the catalogue mapping); customer terms
spanning categories resolve to a common parent concept and are listed as "family suggestions" for the authored layer.

## Authored business layer (Phase 4)

The derived layer says *where things are*; the authored layer says *how a customer is helped*. It is a second tenant file,
`scripts/okf/tenants/<tenant>.authoring.json` (PlaceMakers: `placemakers.authoring.json`), applied on top of the generated
draft with `applyAuthoring` (`packages/knowledge/src/ingest/authoring.ts`). Nothing in it is code.

```bash
npm run okf:ingest -- <snapshot> scripts/okf/tenants/placemakers.ingest.json logs/okf/placemakers scripts/okf/tenants/placemakers.authoring.json
```

What the spec can express: **facts** (question, options, `role: measurement`, `type: array` for multi-select), **families**
(customer-level groupings over several categories, e.g. *Screws*), **projects** (deck, bathroom renovation, laundry, fence,
paint, wet-area lining, insulation — each with ordered questions and optionally the Business Pack journey that runs it),
**problems** (leak, blocked drain, mould, electrical, gas), **care** topics, **risk overlays** that can only *tighten*
commerce, **"Have you considered?" cross-sell suggestions**, and **aliases**: the everyday words, brands and slang customers use for a
category that already exists ("gib" for plasterboard, "dunny" for toilets, "gurney" for a pressure washer). An alias adds customer phrases to
that one concept, marked as an unverified authored proposal; it has no field for a claim, a commerce change or a relationship, it may not
take another concept's name or a phrase two categories both claim, and it removes the same phrase from other concepts' derived keywords so
they do not compete. PlaceMakers has 87 (563 phrases); every one is tested to reach its category. They show the *shelf* for a word,
not proof the shop stocks the item, and PlaceMakers staff should extend them from real conversations.

What it cannot express (enforced by the schema, so a spec cannot smuggle it in): claims, compatibility/requirement/
substitution relationships, safety steps, instructions, warranty terms, or anything marked verified. Authored material is
stamped `x-journeyax-provenance.kind = authored_proposal`, `verified: false`, source `src-authoring-proposal`
("awaiting merchant review"). Problem and care concepts therefore *escalate*: products paused, no invented guidance, a
professional is named. Installation, warranty and care questions return `evidence_answer` with retrieval blocked until a
person attaches and verifies a source.

Cross-sell is surfaced by the gate as `suggestions` (`unverified_cross_sell`), labelled with the tenant's
`cross_sell_label` ("Have you considered?") and the note that compatibility is not confirmed. It never feeds a claim class
and is not offered with problem, evidence-blocked or hazard answers.

**Verification worklist** (`verification-worklist.{md,json}`): for each concept that could carry installation, warranty,
safety or care claims, the crawled documents (max 5, by stated SKU) that a qualified person could review, plus the
concepts for which *no* document exists and a person must author the guidance. PlaceMakers today: 194 items across 149
concepts (installation 119, warranty 61, safety 13, care 1), 8 authoring gaps, **0 verified**.

Gate additions from this stage: a project concept with `broadQueryPolicy` and no `journeyRef` is served by the gate
itself (`project_served_by_gate`) — questions and grouped overview come from the release, not from code.

Known gaps carried forward: five projects (wet-area lining, deck, fence, paint, insulation) have no Business Pack journey, so
they are answered by the gate only; care concepts with no verified evidence return no products (design question for the
runtime phase); derived concepts' commerce ceiling is `allowed/allowed` (merchant decision); eleven category names occur in
more than one department and need path-scoped matching in the catalogue mapping.

## Runtime connection (Phase 5)

The authored release now runs through the real chain — draft → immutable OKF release → attached to the project → Business Pack
publisher → runtime turn service → gate → catalogue handler → presentation → basket policy — and
`apps/journey-runtime-service/test/placemakers-authored-e2e.spec.ts` proves it on the committed snapshot, authoring spec and
catalogue mapping (only the language model is a fixed function).

**Category scope is a path.** `searchScope.catalogCategoryPaths` (optional; an absent field leaves existing entity hashes
unchanged) names department → group → category. A product is in scope when its own path *starts with* the scope path, compared
exactly, so a "Plumbing" in Tools never selects the "Plumbing" in Bathrooms. Names remain only for products that carry a
category but no hierarchy path (14 PlaceMakers categories). The gate hands paths to the runtime for the concept, each overview
group and each suggestion; the catalogue handler anchors every segment and treats them literally; a scope that was supplied but is
unusable returns nothing rather than the whole catalogue; the basket governs a product by path and reads category fields through the
tenant's catalogue mapping. Scope ambiguity fell from 11 to 0. 381 products that have neither a path nor a category are counted in
"Other products" but no scope can select them (reported, not hidden).

**Governed scope is not emptied by wording.** When knowledge chose the scope, the customer's words narrow it but never empty it
(`scopeAuthoritative`): "screws" no longer drops Masonry Anchors because their names don't contain "screw".

**"Have you considered?"** The gate's unverified cross-sell is resolved by the runtime into live products from the same governed
catalogue capability and shown as an `accessories` card whose heading and note come from policy (`cross_sell_label` /
`cross_sell_note`), with no required/recommended grouping. It appears only beside real results, only for buyable product
targets, never beside a problem, care or evidence answer, and never marks anything as compatible. Adding to the basket still goes
through the per-product commerce policy.

**Notices are guaranteed.** Any customer notice the gate requires (`claims.notices`) and the composed message omitted is appended
deterministically; the agent-facing `claims.disclaimers` (which can name internal ids) are never shown verbatim (Phase 7). A suitability/compliance/compatibility question about a concept we can list returns the listing plus the
`technical_requirement_unverified` statement and no claim class.

**A bare SKU is governed.** An exact product code that names no concept in words resolves to the most specific concept its
category belongs to (deepest path, then narrowest scope), so it gets the same commerce and claim rules as the product by name.

**Defects found by running the real chain (all fixed, all with regression tests):**
- The fact registry attached from an OKF release omitted each fact's `key`, so a Business Pack that referenced an OKF release
  failed schema validation and could not be published.
- The publisher never set the pack's currency or locale; the schema default (`AUD` / `en-AU`) applied silently. Currency now
  comes from `pricing.currency` and publication fails without it (see tenant action 7).
- The interpreter drops facts the pack does not declare; without the attached registry no authored question could ever be answered.

**Journeys.** The five authored projects without a Business Pack journey (wet-area lining, deck, fence, paint, insulation) are
served by the gate from the release alone — questions, grouped overview of their categories, live products, cross-sell, basket
rules — and are tested that way. Bathroom, laundry and kitchen hand off to `placemakers_plan_your_space`; publication verifies
that every journey a concept references exists in the pack. Whether the live journeys' stages collect those facts could not be
verified without reading the live pack: `scripts/inventory/capture-pack-structure.ts` (read-only, run by a person) captures it.

**Unmatched concepts.** With the default policy an uncovered request is never answered from the catalogue; catalogue-only
fallback is an explicit, per-release decision (`policy.coverage.uncoveredShopping`) that shows live facts only and carries no claim.
A request that only partly matches ("garden gnomes" → Garden & Landscaping) asks that department's question and claims nothing.

## Back-office Knowledge Base (Phase 6)

The Studio now answers the questions a person actually has. The service computes every figure (`KnowledgeInsightService`, read-only);
the screens only choose words and layout, so the UI and the publish gate cannot disagree.

| Question | Where | Endpoint |
|---|---|---|
| Where does my knowledge stand — draft, released, staged, live — and what exactly differs? | *From draft to customers* (`LifecyclePanel`) | `GET /projects/:id/knowledge/lifecycle` |
| What does it cover, by department, journey and kind of claim; what is missing? | *Coverage and what is missing* (`CoveragePanel`) | `GET /projects/:id/knowledge/coverage` |
| What would the assistant use for this message? | *Conversation preview* (`DecisionPreview`) | `POST /projects/:id/knowledge/preview` (adds `live` products, cross-sell and concept name) |
| Does my catalogue mapping read my real products? | *Pack settings → Catalogue mapping* (`CatalogMappingForm`) | `GET/POST /projects/:id/catalog-mapping[/check]` |

**Lifecycle.** Draft → immutable release → staged (the release the project is bound to) → live (the release the active Business
Pack runs, per environment). It states the next step to take, and names what a publish would change (draft vs staged, staged vs live)
by concept, using stable identity and content hashes. A live pack that carries no knowledge is called out.

**Coverage.** Departments come from the catalogue's own category paths, not from code. For each: listed products (through the
tenant's mapping, hiding discontinued items), the share inside some concept's scope, concepts, authored concepts, concepts with
candidate documents. It also reports products no scope can select, whether each journey a concept hands off to exists in the live pack,
projects answered by knowledge alone, unverified claims by class, and every problem/care topic that still has no verified guidance.
Nothing is shown as verified unless a current, matching verification record exists.

**Catalogue mapping form.** Replaces raw JSON as the main path (JSON stays under *Advanced*). Fields are grouped (identity, categories,
price and currency, stock, lifecycle, attributes); platform defaults show as placeholders; mistakes are flagged next to the field while typing
using the same grammar as the service (a parity test compares the form's verdict with the schema's). *Check against my catalogue* reads a
sample spread evenly across the tenant's products and reports, for the mapping as it is now: what could be read for the code, name, price,
currency, stock, category and hierarchy; prices with no declared currency (an error when most of the sample is affected); mixed
currencies (reported, never converted); lifecycle values in use and how each is treated; configured fields found on no product; and the
products as the assistant would read them. *Fields found on your products* lists what the products really contain with how often, and lets
a person say what each field means. Saving is enabled only after a current check with no errors; the service validates again on save.

Not done in this phase: showing, for a past real conversation, which knowledge the assistant used (turn decisions are not persisted with
the knowledge trace yet — the preview shows what it *would* use for a message); editing a concept's catalogue category paths in the concept
editor (they are preserved on save, and visible in the Advanced JSON); an in-product guided *import* of the authoring spec.

## Evaluation, public path and customer wording (Phase 7)

**Coverage-driven evaluation** (`packages/knowledge/src/evaluation.ts`). Scenarios are generated from the release and the
catalogue snapshot, not hand-picked, and run through the real gate and basket policy (nothing stubbed): ten families — routing,
scope, commerce, safety, technical claims, evidence, exact SKU, cross-sell, negative and the tenant's own customer paths. PlaceMakers:
**4,653 scenarios, 0 failing, 0 gaps**, every department and leaf category probed in every family that applies
(`docs/coverage/placemakers/evaluation.{md,json}`; regenerate with `scripts/okf/ingest-taxonomy.ts`). The tenant's customer paths
(`scripts/okf/tenants/placemakers.scenarios.json`, 46) are attached to the draft as acceptance scenarios and run at publication.
A mutation test per family proves the evaluation fails when the thing it guards is broken.

**The customer sees a customer view.** The runtime's stream carries the decision, the knowledge trace, the model route and the
workspace; none of that belongs in a browser. `packages/journey-core/src/public-projection.ts` projects every event through an
allow-list held in data (`defaults/public-projection.json`); the full stream is available only to a platform workload that presents
the internal key. Error bodies are the platform's plain message, chosen by error code, never the exception text. Verified hops:
storefront route → gateway → commerce service → runtime; the gateway and commerce service forward upstream refusals with their
status and `Retry-After` instead of a 200 with an error inside.

**Public-path canary** (`packages/canary`, spec `scripts/canary/placemakers.canary.json`). A read-only check a person can run against
a deployed shop: it drives real conversations and checks the stream shape, the allowed events, that no internal content or
credential reaches the browser, that cards are real platform cards with valid state in the shop's currency, that nothing is
bought, that the reply reads like a person wrote it (no platform vocabulary, no repeated sentence), and the scenario's own
expectations. Its report is sanitised. It runs hermetically in CI (`tests/public-path`, four real hops on loopback, an in-memory store
and a fixed stand-in model; transcript in `docs/canary/`) and, with a customer session, against the live URL:
`CANARY_COOKIE='…' npx tsx packages/canary/src/cli.ts --spec scripts/canary/placemakers.canary.json --url <public chat stream url>`.

**Cards and theming.** Every card the public path sends renders without error, binds only fields its schema declares, and the card
stylesheet reads only theme variables (two hard-coded colours were replaced); a tenant theme reaches the markup
(`tests/public-path/cards-render.spec.tsx`).

**Customer wording (found by reading the canary transcript, fixed at the source).** Early transcripts showed the platform talking to
the customer in its own vocabulary — validator notes ("No capability execution outcome provided for validation."), relationship ids,
"pinned knowledge release", the same hazard sentence twice. Fixes, all in data or at the boundary:
- The gate separates `claims.disclaimers` (everything the agent must respect) from `claims.notices` (plain-language text a customer may
  read). Only notices are appended to a reply.
- Customer-facing policy messages were rewritten in plain language (`packages/knowledge/src/defaults/platform-policy.json`); tenants
  override any of them, and placeholders are validated against the platform default's own placeholders.
- The presentation port writes no sentence of its own. Failure, out-of-scope, greeting, approval, price-unavailable, bundle summary and
  heading wording come from the runtime message set (`apps/journey-runtime-service/src/defaults/interpretation-policy.json`, overridable
  by a pack's `extensions.interpretationPolicy.messages`, then by the tenant's knowledge policy). A decision carries
  `payload.customerMessage: true` only when its reason was written for a customer (a policy message or a rule's `remediationMessage`);
  anything else is replaced by the generic sentence and stays in the decision trace.
- A retrieval the knowledge gate blocked no longer reports "no outcome to validate"; nothing ran, so the customer gets the notice.
- Guards: a platform-vocabulary list (`defaults/evaluation-templates.json`, `internalVocabulary`) is applied to every notice in all 4,653
  scenarios, to every shipped customer message, to the presentation port's source, and to every reply the canary receives.

## Release lifecycle and activation (Phase 8)

Proved on the real repositories (publisher, pack loader/verifier, checksum-bound `ReleaseActivationRepository`, the four-hop public path)
over an isolated in-memory store: `tests/public-path/release-lifecycle.spec.ts`, evidence in `docs/activation/release-lifecycle-evidence.md`.

- An approval names a release version and checksum, is compare-and-swap numbered, and is attributed to a person. A wrong checksum, a
  stale revision, a release that is not the active pointer and an unknown release are each refused, and the record stays as it was.
- The runtime serves a request only if the active pack's version **and recomputed checksum** equal the approved ones; a tampered pack is
  refused (the customer is told nothing about why) and serving resumes when the pack is restored.
- A conversation is bound to the release it started on; publishing a newer release does not move it.
- `status: rollback` stops every conversation, pinned or not, until an explicit approval of the exact checksum.
- Rolling the project back restores the earlier release by its original checksum.

**Finding, fixed — a publication used to rewrite the activation record without an approver.** `publishBusinessPack` and
`rollbackBusinessPack` rewrote the activation record (`tenant_cutovers`) of any environment that had one: no new approver, no revision
increment, status forced to `migrated` — so a stopped line (`rollback`) was restarted by the next publish and a legacy (`unmigrated`)
record was migrated by one. The publisher now follows the publication only while the record is already live (`migrated`, `canary`),
keeps its status and canary percentage, advances the numbered revision with a compare-and-swap, and writes an audit row naming the
publisher; a stopped or legacy record is never touched, and a concurrent approval makes the publication fail instead of being overwritten.
The outcome (`followed` / `unchanged` / `none`) is returned to the caller. Tests: `packages/business-pack/test/activation-follow.spec.ts`
(7, six of which fail on the old code) and step 8 of the lifecycle spec.

**Still true, and a product decision:** for an environment whose record is live, publishing carries the approval to the new release, so
**"Publish Business Pack" in production is the go-live action** for a migrated tenant. Requiring a separate approval after publish for
production (so a publish alone changes nothing for customers) is not implemented; it would change how Workwear Group publishes.

## Conversation flow: the Cleaning pilot

Found by reading real conversations: the knowledge routed correctly, but the words and cards around it were wrong. The pilot fixes the
general mechanism and writes the Cleaning conversation as data; other departments follow the same pattern.

- **Order on screen:** the question card first, then the examples, then the unverified "Have you considered?" extras.
- **No false "Recommended":** category samples are examples. The badge needs a verified recommendation, and the card's default eyebrow is
  "From our range". An ordinary product overview has individual add actions, not "Add all" across unrelated examples; an assembled bundle retains
  its bulk action and uses the tenant's closing surface (or `closing_default`).
- **The assistant's words are shaped, from data** (`defaults/interpretation-policy.json` → `replyStyle`, overridable per pack and validated):
  the rules go to the model (one or two short sentences; no company name; no category names or "where to browse"; no questions, lists or
  steps because a card asks them; no sales pitch), and the reply is **enforced** on the way out by `kernel/reply-shaper.ts`: sentences with an
  internal id or backtick, a second question when a card asks one, a "head to / browse / tell me / let me know" phrase, the company's own name, bullet lines,
  and anything past the limit are removed whole, never rewritten. A removed clarification reply uses the tenant's `clarify_lead_in`.
  Ordinary product words such as "paint" and "vanities" are not treated as internal IDs. Every removal is logged.
- **A tapped answer never waits on a model.** The web app sends a card answer as text ("What are you cleaning? → equipment"). Only questions
  pending in that session are eligible; the release's own question and options are matched against it (`knowledge/src/card-answers.ts`),
  the answer becomes a certain fact, and the open question continues
  its concept. Before this, the answer depended on the slow model call; when it timed out, "equipment" was read as a new request and jumped to a
  power-tool category.
- **Cleaning in customer language** (authoring spec): "What are you cleaning?" with *Inside the house / Floors / Outside / The car / Household
  things*, each routed to its shelf; "cleaning supply", "cleaning stuff", "something to clean with" reach it (the singular used to land on a category).
  Tests: `placemakers-authored-e2e` (the customer's real reply as the fixture), `reply-shaper`, `okf-card-answers`, the canary scenario `cleaning-supply`.

- **An empty catalogue result is not availability evidence.** If a successful search finds no items, the model cannot say "Here are";
  the tenant's `nothing_to_show` message is used instead. An isolated regression test covers that case.

How-to-use guidance is now answered from the product's own details (next section); a verified source is still needed for anything beyond them. The persona text in the live project still tells the model "EVERY journey ends at a
real product… always show items"; it is the tenant's own wording, so it is flagged here rather than changed.

## The conversation decision (every department)

The pilot fixed one shelf. The next report said the assistant was still scenario-by-scenario: it always showed product cards, asked its
question after them, and never said why a product fitted. One decision now runs every turn, for every department
(`apps/journey-runtime-service/src/conversation/`). It acts like a counter salesperson: ask only when it helps, recommend when it knows, show when
the customer wants to look, and explain from the product itself.

| Action | When | What the customer gets |
|---|---|---|
| **ask** | not enough said to choose, and a question would help | the question card alone; no products yet; the question is the release's own (what are you cleaning?), or, on a shelf with many products and nothing to tell them apart, one built from the products (brand, a word the titles share, price bands) |
| **recommend** | the customer's words clearly single out one product (or a few) | the best fit with its reason, badged; no question |
| **show** | the customer asked to see them, named a product, declined questions, or there is nothing to narrow by | a short list with no invented reason |
| **answer** | "how do I…", "difference between…" | words only, no cards; steps come from the product's own details (below) |
| *defer* | safety, evidence, orders, projects, nothing matched | another part of the platform owns the reply, unchanged |

- **Deterministic.** Needs are read from the customer's words (shelf names, filler and function words dropped; light stemmer). Each candidate is
  scored on its own text (title > features > description), weighting rarer words more, so "clean" among cleaners says nothing and "oil",
  "driveway" decide. A brand the customer names ("hammers by Estwing") is a brand answer. The same words give the same decision; only the
  choice among equal sentences varies, by conversation and turn.
- **A reason is the product's own words.** The best one or two sentences of its description, features or specification that match what the
  customer said, quoted as written (cut with an ellipsis if long). A sentence that asserts a claim the release has not verified is never
  used; with none, the reason says only which words matched. Nothing is written by a model.
- **How-to is the product's own details or nothing.** The product must be clear from the customer's words (or the only one on the shelf);
  a sentence counts as an instruction when it opens with, or has two of, the policy's usage words ("Spray on, leave to dry, then brush off");
  safety and care wording (wear a respirator, ventilated area, dilute) is not relayed unless the release has verified it. With no steps on
  file the assistant says so. The claim guard now also recognises these safety phrasings in any tense.
- **It never interrogates.** At most `ask.maxPerConcept` questions per shelf (default 2); the release's question is asked once, a question
  built from products once per kind, and "No preference" is always an option. A budget question never opens a shelf: if price is the only thing that tells the products apart, the answer is the list (it may follow another question; `facets.price.askFirst` lets a tenant ask it first). A tapped answer arrives as text (the option's plain words, never a
  code), is read against the question on screen, narrows the list, and continues the same shelf.
- **Wording is the tenant's.** By default the platform fills the pack's own sentences (`templates`) with what the customer said and the product
  chosen, so a turn needs no model call (the model remains for answers it must word, and for tenants who set `wording: "model"`, in which case the
  claim guard and reply shaper apply as before). Notices the release requires accompany any turn that shows or describes a product; a question
  carries none.
- **Everything is data.** Thresholds, stop and filler words, stemming rules, answer/how-to/browse phrases, usage words and every sentence are in
  `defaults/conversation-policy.json`. A pack overrides any section with `extensions.dialoguePolicy` (Studio: Pack settings → Conversation flow),
  validated when saved: unknown keys, wrong types, out-of-range numbers and template placeholders the platform does not fill are refused.
  Nothing in the code names a department, product or brand.
- **The slow model read is skipped when it would add nothing.** Reading free text with the model costs 6 to 10 seconds on every turn.
  A tapped answer that the release's question or the products' question has already read exactly, and a plain short "show me…" for a shelf
  (no number, nothing left once the shelf and "show me" are removed), are understood without it; anything else still goes to the model, as
  before. The deterministic reading runs first and is kept only when complete (`modelReading` in the policy; a tenant can switch it off). The trace says
  `modelSkipped`, and no model route is claimed for a model that was not used.
- **One plain log line per turn**, including turns that end early:
  `[Turn] pack 1.3.17 | knowledge okf-…@4b0e1c8d619c | overview_then_ask · building-products/plasterboard (exact_phrase) | decided ask [release question: …]: … | cards: clarify | model read: skipped (tapped_answer)`.
  The knowledge release itself is logged once per process when it loads (a cached release prints nothing), so this line is the per-turn proof.
  `[TurnDiagnostics]` also carries the decision, its reasons, the needs and each product's score.
- **A shop with nothing to show is never handed to a model.** When the catalogue search ran and found nothing, or failed, the
  assistant still asks the release's question if it has one (a question needs no products), and otherwise says the tenant's plain
  `nothing_to_show` sentence, with no model call. Before this, an empty or failed search fell through to a model that improvised ("The
  results on screen will now focus on that range" when nothing was on screen). The `[Turn]` line now shows `catalogue search: N products / failed
  (reason) / not run`, so a broken search is visible in one line.
- **A leak is a problem however it is worded.** The platform's problem cues (`defaults/platform-policy.json`) now include "leaky",
  "leaking", "leaks" and "<thing> leak", with leak *products* ("leak sealant", "leak detector", "leak proof") still shopping, so "leaky toilet" and
  "toilet is leaking" get the same safe answer instead of one showing a toilet shelf. A tenant refusal is shown as written, with no model call to word it.
- **The claim guard also catches instructions about fittings and water in any phrasing** ("turn off the isolation tap", "switch off at
  the wall", "avoid using it", "isolate the supply", "don't use"), withheld unless the release has verified safety guidance.
- **Tapped answers read in the customer's words.** The web app now puts the label of the tapped option into the customer's message (shared
  `answerSummary` in `@journeyax/ui-cards/answers`), not its internal code ("→ interior-paint"). A multi-select keeps its values. The server
  reads a label or a value.
- **Remembered between turns** in the workspace (`conversation_state`: needs, constraints, what was asked, the question on screen); it is never
  shown to the customer or sent to the model, and a new shelf starts fresh.
- **Trace.** Every turn's trace carries `conversation`: the action, the rules that decided it in order, the needs, and each product's score,
  matched words and whether a reason was quoted.

Tests: `conversation-policy` (18: rules across cleaning, paint, screws and decking fixtures), `placemakers-authored-e2e` (22, the real
publication chain: question first and alone, recommend with a quoted reason and no model call, how-to from the product, many-products
question and tapped answer, model-worded tenants still guarded), `pack-settings` (validation), `okf-claim-validator`, canary scenarios
(`fastenings-screws`, `cleaning-supply`: question first, then "show me").

Not done, and said plainly: the thresholds are defaults that have only been exercised on fixture catalogues and PlaceMakers' offline data,
not on real customers or the real model's wording of an `answer`; real product descriptions will need their usage words and thresholds tuned
through `dialoguePolicy`. Substitution/comparison questions are still worded by the model. A recommendation is "the best match to what you
said", never "verified suitable": suitability still needs a verified claim.

## The Knowledge screen, for a business

The first version of the Studio's Knowledge tab was an engineer's control plane. Read by a business it was baffling: "unverified" on
every link, a verification queue of **963** rows with no limit, and four blank-looking settings. What was wrong, and what changed:

- **The queue listed things that make no claim.** `findStaleVerifications` lists every topic and link without a verification record, so for a
  catalogue-shaped release that is everything: 449 "sits inside" links (a category's place in the tree), 30 "goes well with" suggestions and
  ~460 ordinary categories. None of those states anything a customer could rely on, so there is nothing for a person to confirm.
  `findVerificationWork` (knowledge package) keeps only what could change what the assistant may say: a link that carries a claim class, a
  problem or care topic, a safety-critical or compatibility-sensitive topic, a topic with candidate manufacturer documents, and anything already
  confirmed that was since edited or has expired. For PlaceMakers that is **279** (6 problems, 10 care, 10 compatibility, 253 document reviews; the
  first 26 matter first, the document reviews can be done over time). The service's analysis returns this list, each with what it is about.
- **"Not ready" no longer depends on it.** A release ships with unconfirmed advice withheld, so outstanding checks are *advisory*: shown, labelled
  "does not block a release", and no longer make the release "not ready".
- **The checklist is plain and bounded.** `VerificationQueue`: one explanation of why advice is held back ("this is a safety lock"), then each
  kind of check (problems and safety, care, what goes with what, document reviews; the last marked "can wait"), each split by department with
  "Assign all N" to hand a whole department to one named person in one save. Every list scrolls inside its own box, so the page no longer grows with
  the catalogue. Links that make no claim are summarised ("449 only place topics in the catalogue"), not flagged.
- **A plain summary first** (`KnowledgeSummary`): whether customers are served and with which release, topics, products it can find, confirmed
  by a person, waiting for a person. The engineering detail (coverage tables, topic editor, links, readiness, preview, withdrawals, import/export,
  raw editor, history) is folded into "For engineers".
- **Pack settings say what is in effect without opening them**: "Set: …", "Built-in defaults: …" (not a gap) or "Needs a value" (the default
  journey, required before a multi-journey project can publish). The boxes now refill when the project reloads, and the tab reads the project
  again when it opens and after each save; before, they were filled once from the project as it was when the page first loaded, so a release applied
  since (by the script, or in another tab) showed as empty.

What this does **not** do: nobody has verified anything. A verification is a named person saying they checked a manufacturer's document and it
applies; an assistant cannot be that person. Assigning needs real people and roles (Studio: "Who belongs to each role"), and each checker must
confirm their own items.

