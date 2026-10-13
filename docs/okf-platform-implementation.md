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
commerce, and **"Have you considered?" cross-sell suggestions**.

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

**Disclaimers are guaranteed.** Any disclaimer the gate requires and the composed message omitted is appended
deterministically. A suitability/compliance/compatibility question about a concept we can list returns the listing plus the
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

