# PlaceMakers — production readiness report

Branch `JourneyAX-dev-v4`. Written 2026-10-13, updated the same day after the first load.

**Status update.** At the owner's explicit approval in chat, `scripts/okf/apply-tenant-release.ts` loaded the authored PlaceMakers release into the environment the owner's local services read (the `journeyax` cluster, environment `production`): OKF release `1.2.0` (475 concepts, 0 verified claims), the catalogue mapping, the default journey `placemakers_shop`, and Business Pack `1.3.12`, with the activation following it by checksum. The owner is the only tester. Everything before that was built on isolated in-memory stores. The first run found and fixed four defects that only the real database could show (see "Found by loading it" below). Nothing here has been seen by a real customer.

**Later committed candidate (not loaded or activated).** The Claude/Codex combined changes add a cleaning family, dynamic project narrowing, pending-card answer handling and reply shaping. Its offline snapshot contains 476 concepts and passes 4,694/4,694 gate/basket scenarios; the hermetic public-path canary covers 21 scenarios. These numbers describe the branch candidate, not the active `1.2.0` release. The snapshot also identifies 381 products with neither category path nor category ID: they are counted in coverage but cannot be selected by a category-scoped search. Neither those products nor real-model wording are resolved by the passing offline scenarios.

**Conversation decision (built after the above; not loaded or activated).** Each turn now decides whether to ask, recommend (with a reason quoted from the product's own text), show, or answer, instead of always posting a question plus product cards. See "The conversation decision" in [okf-platform-implementation.md](okf-platform-implementation.md). It needs no new release: it reads the live pack and catalogue, and `extensions.dialoguePolicy` is optional. It has been exercised only on test fixtures and offline data, never on the real model or a real customer.

## Verdict

**Not production-ready yet — and the remaining items are not engineering work I can finish alone.** The platform side is built and proved
(coverage, the public path, customer wording, cards and theming, checksum-bound activation and rollback). What is missing is what only
people, the live environment, or a real database can supply:

| # | Blocker | Why it stops the claim | Who |
|---|---|---|---|
| 1 | **0 verified claims.** Every installation, warranty, care and safety answer is withheld; customers are referred to a specialist. 194 candidate items and 8 authoring gaps are waiting. | A safety/compatibility/installation/warranty claim needs an applicable manufacturer document or a qualified person. I cannot supply that and will not invent it. | PlaceMakers product/safety experts |
| 2 | **Loaded, but only the owner has tested it.** The release, mapping and pack are in the owner's environment; one customer conversation was reviewed (wet-area question, fixed) and a screws conversation (reply guard, fixed). Routing quality across real customer wording is unmeasured beyond that. | Natural phrasing is the long tail: the gate depends on authored phrases, and a customer can word anything. | PlaceMakers staff: keep adding phrases from real conversations |
| 3 | **The public URL and a real browser were never exercised.** The load ran against real MongoDB (draft, release, pack, activation all written and read back), but the canary ran on loopback with a stand-in model and nobody has run it against the deployed storefront. | The public-path claim is proved for the code and the data, not for the deployment. | Whoever holds a customer session |
| 4 | **Publishing is still the go-live action for a live tenant** (see Finding below). | There is no separate approval between "publish" and "customers see it" when the environment's activation is already `migrated` or `canary`. A stopped line is no longer restarted by a publish. | Product decision |
| 5 | **The real language model was never exercised.** All turns used a fixed stand-in; the claim validator and prompt rules are tested, the model's wording is not. | Model-composed replies are unmeasured. | Run `packages/pack-eval` / the live canary with the real model |

## What is demonstrated

| Claim | Evidence |
|---|---|
| Every department and leaf category is reachable, scoped, priced under its commerce rules, safe, honest about claims, and works by SKU | Active-release evidence was **4,653/4,653** scenarios for 475 concepts. The linked [candidate coverage matrix](coverage/placemakers/evaluation.md) now reports **4,694/4,694** scenarios for 476 concepts. These are offline gate/basket checks, not proof that the 381 unscoped products can be found or that real catalogue search and pricing work end to end. |
| The tenant's own customer journeys behave | 46 customer-path scenarios in `scripts/okf/tenants/placemakers.scenarios.json`, run at publication as acceptance scenarios |
| No business knowledge is in code | Questions, scopes, cards, next actions, wording, thresholds, lexicons, templates: all in the release, the tenant files, or the platform default JSON. `hardcoding-guard` passes; a test fails if the presentation port contains a customer sentence |
| Nothing unverified is claimed | Verified-claims register below: **0 verified**, claim classes withheld; "Have you considered?" is unverified cross-sell, never proof of compatibility; a suitability question gets the listing plus a plain statement that it can't be confirmed |
| A hazard escalates, never sells | 1,092 safety scenarios: no products, no cross-sell, no checkout, a professional is named, no invented guidance; a hazard outranks an order question |
| The browser gets a customer view | Allow-listed events, no trace/decision/model route/knowledge ids, plain error bodies, `Retry-After` forwarded; the full stream only for a platform workload with the internal key |
| The public path works end to end | `tests/public-path/public-path.spec.ts` (11): storefront route → gateway → commerce → runtime; auth, tenant isolation, throttling, oversize, prompt injection, conversation isolation |
| Cards render and are themed | `tests/public-path/cards-render.spec.tsx` (5): every card sent renders, binds only declared fields, the stylesheet reads only theme variables (no hard-coded colour), a tenant theme reaches the markup |
| Customers read plain language | The linked [candidate hermetic transcript](canary/placemakers-public-path-2026-10-13-hermetic.md) reports **21 scenarios, 0 violations**, sanitised. It uses a fixed stand-in model, so it does not prove real-model wording or deployed browser behaviour. |
| Activation is checksum-bound and reversible | [docs/activation/release-lifecycle-evidence.md](activation/release-lifecycle-evidence.md) — wrong checksum / stale revision / wrong release / unknown release refused; tampered pack refused; rollback restores the original checksum; stop-the-line stops pinned and new conversations |

## Found by loading it

The first real load found defects no hermetic test could, because the test database differed from the real one. All are fixed with tests:
1. **`undefined` stored as `null`.** 40 generated concepts carried optional fields set to `undefined`; the real driver stores `null`, which changes a content hash, so the release failed its own integrity check. The generator no longer emits them, saving strips them, and the in-memory test database now stores `undefined` as `null` like the driver (an existing test now fails on the old code).
2. **A regression in my own activation fix.** The publication gate's rollback drill assumed a fixed activation revision; the fix made a rollback advance it, so every Studio publish would have failed. The gate now reads the revision, and a new test runs the real gate.
3. **No way to set a default journey.** A project with several journeys cannot be published without one, and the product had no setting for it. It is now a validated pack setting (Studio: Pack settings → Default journey).
4. **Rollback blanked the project's `packVersion`.** The old rollback wrote an undefined value; it no longer does.

Then, from the owner's first conversations: wet-area wording routed to a retaining-wall category (project phrases and a "two categories of one project" rule fixed it); the reply guard threw away whole replies for one ordinary word like "fastening" (it now removes only the offending sentence, logs it, and uses the tenant's own wording if nothing is left); the log never said which OKF release a service was running (it now logs each release load and names the pack and release in every turn's diagnostics); and the 5-second limit on the two fast model steps was hard-coded and shorter than the project's model needs (model policies are now platform data with validated per-project overrides; PlaceMakers is set to 10 s).

## Test results

`node scripts/run-all-tests.mjs --group all` — **29 of 29 suites pass** (core, type-checks for every app and package including the new
`canary` and `tests/public-path` projects, the extended suites, and the hardcoding guard). The run is logged under
`logs/test-runs/<timestamp>/` (git-ignored; one log per suite plus structured JSONL).

Suites added in this phase: `journey-core` (public projection), `canary` (13), `public-path` (public path 11, cards 5, release lifecycle 8),
runtime `customer-wording` (13) and `runtime-public-view` (4), knowledge coverage evaluation (14) and policy wording (35 total).

Defects the tests found in this phase, all fixed with regression tests: the gateway swallowed an upstream refusal into a `200`; the
`Retry-After` header was never emitted; the runtime answered a tampered pack with a `200` containing an error; a customer card carried
an internal concept id in a group key; two card colours were hard-coded; platform vocabulary, relationship ids and a repeated hazard
sentence reached customers; an engine reason could reach a customer through a fallback path; a `503` leaked its internal message;
"I'm your our consultant" when no company name was set.

## Verified-claims register

Source of truth: `docs/coverage/placemakers/verification-worklist.{md,json}` (regenerate with `scripts/okf/ingest-taxonomy.ts`).

- **Verified claims: 0.** `verifications` in the release is empty. Every claim class a customer could rely on is off.
- Candidate documents for a person to review: **194 worklist items** — installation 119, warranty 61, safety 13, care 1 — across 149 concepts,
  each listing up to five crawled documents that name a product in the category. A candidate is *not* evidence until a qualified person
  attaches and verifies it for that concept; applicability (the right product, the right revision) is theirs to judge.
- **8 authoring gaps** — no document can support these; a qualified person must write and verify first-response guidance: bathroom leak,
  leaking tap or pipe, blocked drain, mould and damp, electrical hazard, gas hazard; care instructions for decking and tapware.
  Until then each escalates to a professional and shows no products.
- Mechanism: verification is attested by a person holding a verifier role for that claim class; editing a verified concept makes its
  verification stale; a revocation withdraws a concept immediately (all exercised in the knowledge suite).

## Finding — publishing and activation

`publishBusinessPack` / `rollbackBusinessPack` used to rewrite the environment's activation record on every publication: no new approver,
no revision increment, status forced to `migrated`, so a publish restarted a stopped line and migrated a legacy tenant. **Fixed**
(`packages/business-pack/src/publisher.ts`): the activation follows a publication only while it is already live (`migrated` / `canary`),
keeps its status, advances the numbered revision with a compare-and-swap and logs the publisher; a stopped (`rollback`) or legacy
(`unmigrated`) record is never touched, and a concurrent approval is never overwritten. Tests: `activation-follow.spec.ts` (7) and the
lifecycle spec.

**Remaining decision.** For an environment whose activation is live, a publish still puts the new release in front of customers
(checksum-bound, audited, but not separately approved). **Treat "Publish Business Pack" in production as the go-live action** unless you
decide production should require an explicit approval after publish; that would change Workwear Group's flow, so it is not applied.

## Production activation checklist

Nothing below has been done. Each production write needs your explicit approval at the time.

**A. Decisions (people)**
1. Decide whether production should require an explicit, attributed activation after publish (above). Recommended: yes for PlaceMakers; it changes Workwear Group's flow, so it needs their sign-off.
2. Commerce ceilings for derived concepts (today `allowed/allowed`; authored overlays already tighten trade categories to
   professional confirmation and fixings to compatibility confirmation). Confirm or tighten.
3. Whether an uncovered shopping request may fall back to the catalogue (`policy.coverage.uncoveredShopping`). Default and recommendation: off.
4. The five projects with no Business Pack journey (wet-area lining, deck, fence, paint, insulation) are served by the gate alone. Accept, or author journeys.
5. Name the qualified verifiers and the verifier roles; decide the order in which the 194 items are worked (safety first).

**B. Read-only checks (someone with access)**
1. Run `scripts/inventory/capture-pack-structure.ts` (read-only; written for a person to run) and review the live journeys' stages and required facts against the authored questions.
2. Confirm the live project states `pricing.currency` (expected `NZD`); publication fails without it.
3. Two databases report different active production pointers (`journeyx` 1.0.38, `journeyax` 1.0.33 at inventory time). Establish which one the deployed runtime reads before anything is published.
4. Confirm `OKF_ARTIFACT_BUCKET` and every service URL / `INTERNAL_API_KEY` are set for production (OKF release export failed at inventory time for the bucket).

**C. Prepare in staging (not production)**
1. Back office → Pack settings → Catalogue mapping: declare the price path with its currency, the category fields and hierarchy, and the lifecycle fields; use *Check against my catalogue*; save only with no errors. Apply `docs/migrations/placemakers-component-category-rules.json`. Declare fact roles (measurement / money / quantity) in the fact registry.
2. Import the authored bundle (`bundle.zip` written by `scripts/okf/ingest-taxonomy.ts`) into the staging Studio draft; publication evaluation and the 46 acceptance scenarios must pass.
3. Publish the immutable OKF release; stage it; publish the Business Pack to **staging**.
4. Run the canary against the staging public URL with a customer session: `CANARY_COOKIE='…' npx tsx packages/canary/src/cli.ts --spec scripts/canary/placemakers.canary.json --url <staging chat stream url>`. Required: 0 errors. Keep the sanitised transcript.
5. Run the real-model evaluation (`packages/pack-eval`) against staging and read the transcripts for wording.
6. Run `npm run test:integration` in `apps/journey-runtime-service` against the guarded test database (needs a real MongoDB; transactions and indexes).
7. Open the staging storefront in a browser at phone and desktop widths and review the cards in the tenant theme.

**D. Production (explicit approval for each step)**
1. Record the current production pack version and checksum and the current activation record (rollback target).
2. Apply the same catalogue mapping and facts to production; publish the OKF release; stage it.
3. Publish the Business Pack to production — **this is the go-live** if the production activation is `migrated` (or no record exists and you then approve it); until decision A1, treat the publish as the go-live. Someone watches the canary and error rate.
4. Run the live canary immediately and again after an hour.

**E. Rollback**
- Fast: in Studio roll the project back to the recorded version (pointer, Studio state and — by checksum — the activation record move together); confirm with the canary.
- Stop-the-line: set the activation to `rollback` with `promoteReleaseActivation` (a numbered, attributed approval); every conversation stops. A publish or rollback no longer restarts it; restore with an explicit approval of the exact checksum.
- Drill both in staging before production.

**F. After go-live**
- Work the verification worklist; each attested claim enables that claim class for that concept only; re-run the evaluation after each batch.
- Re-run the live canary on a schedule; any new violation is a defect.

## Remaining gaps (not done, stated plainly)

- Real MongoDB, real model, live URL, real browser: none exercised (see blockers 3 and 5, and C5–C7).
- 381 products have neither a category path nor a category; no scope can select them (counted, not hidden).
- The canary's `canary` activation status has no meaning for PlaceMakers (it has no legacy path); out-of-bucket traffic returned a `500` in the harness. Use `migrated`.
- The hermetic canary's model is a fixed stand-in; its non-policy reply text says nothing about production wording.
- Locale: only the platform's English messages ship; other locales are a tenant policy overlay that exists but is unused.
- `agent-commerce-service` (legacy path) still contains domain code of its own; covered by the guard's rules, not refactored.
- A past conversation's knowledge trace is not persisted (the preview shows what the assistant *would* use).
- The conversation decision's thresholds and word lists are platform defaults tuned on fixtures. They need review against real PlaceMakers product descriptions and conversations; tune through `dialoguePolicy`, not code.
- How-to answers quote only what the product's own description says; most descriptions say nothing about use, so the assistant will often say it has no instructions on file until a verified source is added.
- Requiring an explicit approval after a production publish (so a publish alone changes nothing for customers) is not implemented.
