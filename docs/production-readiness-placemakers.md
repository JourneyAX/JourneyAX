# PlaceMakers — production readiness report

Branch `JourneyAX-dev-v4`. Written 2026-10-13. Everything below was built and proved on isolated, in-memory stores. **No production-backed
data was read or written after the initial read-only inventory, and no production release was activated.**

## Verdict

**Not production-ready yet — and the remaining items are not engineering work I can finish alone.** The platform side is built and proved
(coverage, the public path, customer wording, cards and theming, checksum-bound activation and rollback). What is missing is what only
people, the live environment, or a real database can supply:

| # | Blocker | Why it stops the claim | Who |
|---|---|---|---|
| 1 | **0 verified claims.** Every installation, warranty, care and safety answer is withheld; customers are referred to a specialist. 194 candidate items and 8 authoring gaps are waiting. | A safety/compatibility/installation/warranty claim needs an applicable manufacturer document or a qualified person. I cannot supply that and will not invent it. | PlaceMakers product/safety experts |
| 2 | **The live project has no catalogue mapping, fact registry or authored release.** The live pack (1.0.38 at inventory time) has no OKF reference, no fact registry and no mapping; the staged OKF release has 6 concepts. | None of the 475 authored concepts is live; prices cannot be read without a declared currency path. | Release owner (production write, needs approval) |
| 3 | **Never run against real MongoDB or the live URL.** Transactions, indexes and the activation store were exercised through an in-memory fake; the canary ran on loopback with a stand-in model. | The public-path claim is proved for the code, not for the deployment. | Whoever holds a customer session / DB access |
| 4 | **Publishing is still the go-live action for a live tenant** (see Finding below). | There is no separate approval between "publish" and "customers see it" when the environment's activation is already `migrated` or `canary`. A stopped line is no longer restarted by a publish. | Product decision |
| 5 | **The real language model was never exercised.** All turns used a fixed stand-in; the claim validator and prompt rules are tested, the model's wording is not. | Model-composed replies are unmeasured. | Run `packages/pack-eval` / the live canary with the real model |

## What is demonstrated

| Claim | Evidence |
|---|---|
| Every department and leaf category is reachable, scoped, priced under its commerce rules, safe, honest about claims, and works by SKU | Coverage matrix: [docs/coverage/placemakers/evaluation.md](coverage/placemakers/evaluation.md) — **4,653 of 4,653 scenarios hold, 0 gaps**, 10 families, 18 departments, 376 leaf categories, 475 concepts. Mutation tests prove each family fails when its rule is broken. |
| The tenant's own customer journeys behave | 46 customer-path scenarios in `scripts/okf/tenants/placemakers.scenarios.json`, run at publication as acceptance scenarios |
| No business knowledge is in code | Questions, scopes, cards, next actions, wording, thresholds, lexicons, templates: all in the release, the tenant files, or the platform default JSON. `hardcoding-guard` passes; a test fails if the presentation port contains a customer sentence |
| Nothing unverified is claimed | Verified-claims register below: **0 verified**, claim classes withheld; "Have you considered?" is unverified cross-sell, never proof of compatibility; a suitability question gets the listing plus a plain statement that it can't be confirmed |
| A hazard escalates, never sells | 1,092 safety scenarios: no products, no cross-sell, no checkout, a professional is named, no invented guidance; a hazard outranks an order question |
| The browser gets a customer view | Allow-listed events, no trace/decision/model route/knowledge ids, plain error bodies, `Retry-After` forwarded; the full stream only for a platform workload with the internal key |
| The public path works end to end | `tests/public-path/public-path.spec.ts` (11): storefront route → gateway → commerce → runtime; auth, tenant isolation, throttling, oversize, prompt injection, conversation isolation |
| Cards render and are themed | `tests/public-path/cards-render.spec.tsx` (5): every card sent renders, binds only declared fields, the stylesheet reads only theme variables (no hard-coded colour), a tenant theme reaches the markup |
| Customers read plain language | Transcript: [docs/canary/placemakers-public-path-2026-10-13-hermetic.md](canary/placemakers-public-path-2026-10-13-hermetic.md) (17 scenarios, 0 violations, sanitised). Platform vocabulary is rejected in every notice (4,653 scenarios), every shipped message, and every canary reply |
| Activation is checksum-bound and reversible | [docs/activation/release-lifecycle-evidence.md](activation/release-lifecycle-evidence.md) — wrong checksum / stale revision / wrong release / unknown release refused; tampered pack refused; rollback restores the original checksum; stop-the-line stops pinned and new conversations |

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
- Requiring an explicit approval after a production publish (so a publish alone changes nothing for customers) is not implemented.
