# JourneyAX — Architecture Decision Record (ADR)

Single source of truth for the platform + infra decisions. ADR-style: each entry has **Status · Context · Decision · Consequences**. Companion docs: [`deployment-plan.md`](./deployment-plan.md) (the how-to), `~/Downloads/architecture_gap_analysis.md` (current-vs-target scorecard).

_Last consolidated: 2026-08 · Owner: platform_

---

## ADR-01 — Composable / MACH microservices (no consolidation)
**Status:** ✅ Accepted (firm)

**Context:** JourneyAX is an API-first, headless, multi-tenant commerce platform. 11 deployable units — 2 Next.js apps (storefront, back-office) + 9 NestJS services (gateway, auth, project, product, organization, agent-commerce, analytics, data, lead) + 7 shared packages. npm workspaces + Turborepo.

**Decision:** Keep the **microservice / MACH / composable** split. **Do NOT merge services into a monolith.** The runtime shape is: *frontends + back-ends → API Gateway → routes by domain → services → respond back through the gateway; services talk east-west internally; cache at the gateway.*

**Consequences:** Independent scale/deploy per service; more moving parts and more service-to-service auth to manage (see ADR-04/05). The east/west auth complexity is accepted as the cost of composability, not a reason to consolidate.

---

## ADR-02 — Deployment topology: Vercel (frontends) + GCP Cloud Run (services), scale-to-zero
**Status:** ✅ Accepted

**Context:** Want lowest/zero cost, spend only on demand, git-driven. Atlas already the managed DB.

**Decision:**
- **Frontends → Vercel** (Hobby/free; native Next.js; git auto-deploy; PR previews; inherently scale-to-zero).
- **Backend services → GCP Cloud Run, `min-instances=0`** — a request wakes them, idle = $0. Exception: **gateway + auth kept warm (`min=1`)** so the first demo click isn't a cold-start chain.
- **DB → MongoDB Atlas M0** (free). **LLM → OpenAI** (usage cost, not infra).

**Consequences:** ≈ **$0 infra at idle**; only OpenAI is variable. Trade-off = cold-start latency on woken services (hide with a free Cloud Scheduler warm-ping during demos, or pay ~$10/mo for more `min-instances` if it becomes always-on). Atlas allowlist `0.0.0.0/0` + SCRAM/TLS for now (Cloud Run has dynamic egress IPs); static egress IP via VPC+NAT is a later hardening.

---

## ADR-03 — CI/CD: reuse the Metafy Cloud Build pattern
**Status:** ✅ Accepted

**Context:** Metafy AI (`metafyai-aeo/metafy-ai-platform`) already runs this exact stack in production. Same monorepo shape (npm workspaces + Turbo, NestJS + Next).

**Decision:** Copy Metafy's pipeline, change only the service list / ports / secrets / project IDs:
- **Frontends:** Vercel git integration + a `vercel.json` per app (build packages then app, `--legacy-peer-deps`). No workflow file.
- **Services:** one shared **`Dockerfile.template`** (`--build-arg SERVICE_NAME`) + a **4-step Cloud Build** `cloudbuild.yaml`: `detect` changed services → `build-and-push` (Artifact Registry) → `gcloud run deploy` → **`update-urls`** (inject every Cloud Run URL into the gateway + services = dynamic service discovery). Branch → env (`journeyax-qa` / `journeyax-production`).
- **All secrets from GCP Secret Manager** (`--update-secrets`), never `.env`.

**Consequences:** Proven, low-invention. Fixes the `INTERNAL_API_KEY` env-drift class of bug (one canonical value per side). Reference: memory *Metafy deploy pattern*.

---

## ADR-04 — Gateway is the single public door; all other services private
**Status:** 🟡 Accepted, partially implemented

**Context:** Frontends + services were calling private Cloud Run services with no Google identity → Cloud Run IAM 403. Org policy `iam.allowedPolicyMemberDomains` (Domain Restricted Sharing) **blocks making services public** (`allUsers`) — and we do not want them public regardless.

**Decision:**
- **api-gateway = the only public backend** (+ auth-service public is tolerated because login is inherently public). **project / product / organization / agent-commerce (and the rest) stay `--no-allow-unauthenticated` = private.**
- Reach private services with a **Google IAM ID token** (`google-auth-library`): the caller mints a token whose audience = the target service URL and sends it as `Authorization: Bearer`. Granting `run.invoker` to a **named service account** is allowed by the org policy — nothing goes public. Rejected: making the 4 services public (defeats the gateway and fights the policy).

**Status of implementation:** ✅ Done + correct **in the gateway** (`getIdToken`, per-audience 55-min cache, Authorization swap, local-dev fallback; app authz preserved via injected `x-user-*` headers). ⚠️ **Not yet done for the frontends (see ADR-06 Gap 1) or east-west calls (Gap 2).**

**Consequences:** Zero public internal services, org-policy compliant. Requires the token on **every** hop, not just the gateway (ADR-05).

---

## ADR-05 — North/south = API Gateway; east/west = tokens now, service mesh later
**Status:** 🟡 Accepted; east/west incomplete

**Context:** Market standard (Kong, Gravitee, GCP, MACH stacks): **API Gateway handles north/south (external), Service Mesh handles east/west (internal), used together, zero-trust.** JourneyAX east/west today = a **static shared secret** (`INTERNAL_API_KEY` / `x-internal-key`) — works app-side but carries no Google identity, so it 403s the moment services go private. Critical path affected: `agent-commerce-service → product-service` (the retrieval path, ~15 call sites), `agent → project`, `product → project`, `project → auth`.

**Decision:**
- **Now (Level 1):** put the **same Google ID-token logic on the internal hops**, via a **shared internal-http-client** (Metafy's `getServiceIdentityToken()` pattern) — one helper used everywhere, so no call is forgotten. IAM: grant `run.invoker` to each **calling** service's SA (or confirm all run as the one default compute SA, which then covers all callers).
- **Later (Level 2):** graduate east/west to **Cloud Service Mesh (mTLS + workload identity)** when the number of services/teams makes in-code tokens a chore. Removes token-minting from app code.

**Consequences:** Level 1 is a small, contained change (outbound-fetch layer), no business logic touched. Level 2 is heavier / not scale-to-zero-friendly → deliberately deferred.

---

## ADR-06 — Caching: two layers, both backed by Upstash Redis
**Status:** 🟡 Accepted; edge cache not started, data cache memory-only in prod

**Context:** Two distinct caches get conflated. On **scale-to-zero Cloud Run, in-memory cache is useless** (dies on cold start; each instance separate) — so caching *must* use a shared external store.

**Decision:**
- **Data / application cache** = existing `@journeyax/cache` (`getOrSet`, project-scoped, `invalidateProject`, TTL≤7d). Redis-when-`REDIS_URL`-set, memory otherwise. **Point it at Upstash Redis** in cloud (today it's memory-only → effectively off in prod). It already fixed the 15s back-office slowness (cause was duplicate fetches + no cache, *not* Mongo). Rule: cache per project, never across; invalidate on any project write / ingest / workspace switch; every Refresh must send `?refresh=1`.
- **Gateway response cache** (edge) = **new, not built yet.** Cache **public GETs only** (catalogue/search, `/config`, size-charts) keyed by `method:path:tenant`, short TTL. **Back it with Upstash Redis** (same instance, `resp:*` namespace) — **not** in-process LRU (useless on serverless). Never cache: authenticated/personalized responses, the chat SSE stream, or mutations.

**Consequences:** One Upstash Redis instance serves both layers (two namespaces). Redis is **mandatory** in cloud, not optional.

---

## ADR-07 — Sequencing of the private-networking rollout
**Status:** ✅ Accepted (corrects the order in the gap-analysis doc)

**Context:** Flipping services to `--no-allow-unauthenticated` breaks **both** frontends-calling-services-directly **and** service-to-service calls unless auth is in place first.

**Decision — do it in THIS order:**
```
[gateway ID token ✓]  +  Gap 1 (frontends → gateway only)  +  Gap 2 (east/west ID tokens)
            └──────────────────── THEN ────────────────────┘
                     flip services --no-allow-unauthenticated
                                   └──── THEN ────▶  Gap 3 (Redis edge cache)
```

**Consequences:** Privatizing before Gap 1 + Gap 2 are done would 403 the agent→product retrieval path and take down the storefront. Gap 2 is a **prerequisite** to going private, not a deferral.

---

## The three open gaps (snapshot)
| # | Gap | Status | Next step |
|---|-----|--------|-----------|
| 1 | Gateway isn't the single door (frontends bypass via direct `*_SERVICE_URL`) | ⚠️ | Point ALL frontend service-URL envs at the gateway URL (full list in the gap-analysis doc); keep gateway's own envs on the real service URLs |
| 2 | East/west uses a static `INTERNAL_API_KEY`, no Google identity | ⚠️ | Shared internal-http-client attaching an ID token on every service→service call + `run.invoker` per calling SA |
| 3 | No response cache at the gateway | ❌ | Upstash-Redis-backed response cache for public GETs, keyed by tenant+route |
| — | Service mesh (mTLS east/west) | ❌ | Level 2 — defer until scale demands it |

## One-line summary
MACH microservices → **Vercel (frontends) + Cloud Run scale-to-zero (services) + Upstash Redis + Atlas M0**, deployed via the **Metafy Cloud Build pattern**; the **gateway is the only public door**, services **private**, every hop authenticated with **Google IAM ID tokens** (Cloud Service Mesh later); caching lives **at the gateway AND in the services, both backed by Upstash Redis**. Spend is **on-demand / ≈ $0 idle**.
