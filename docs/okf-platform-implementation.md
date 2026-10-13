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

Not done, and said plainly: **how-to-use guidance** for cleaning products. It is a care/usage claim, which needs a verified source; the worklist
holds 2 candidate documents for Cleaning (neither is about use). The persona text in the live project still tells the model "EVERY journey ends at a
real product… always show items"; it is the tenant's own wording, so it is flagged here rather than changed.
