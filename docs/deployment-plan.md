# JourneyAX — Deployment & CI/CD Plan (Vercel + GCP, low/zero-cost)

**Shape:** **Frontends → Vercel. Backend services → GCP Cloud Run (scale-to-zero). Cache → Upstash Redis (serverless). DB → MongoDB Atlas M0.** The two halves connect dynamically through env tokens. Everything sits on free tiers and only spends money **on demand** (a request wakes a service; idle = $0). No code changes here — this is the blueprint; artifacts to create are in §9.

> **This intentionally reuses the Metafy AI deployment pattern** (`Projects/metafyai-aeo/metafy-ai-platform`) — same Vercel + Cloud Run split, same 4-step Cloud Build orchestrator (`cloudbuild.yaml` + `scripts/cloudbuild-*.sh`), same shared `Dockerfile.template`, same scale-to-zero + Secret Manager + dynamic URL-injection. We copy those files and change the service list, ports, secrets, and project IDs (§9). Nothing here is invented — it's the process you already run in production for Metafy.

---

## 1. Where each unit runs

| Unit | Type | **Runs on** | Why |
|------|------|------------|-----|
| `journeyax-web` (storefront + chat) | Next.js | **Vercel** | Native Next platform, global CDN, scale-to-zero, PR previews free |
| `backoffice-admin` (control plane) | Next.js | **Vercel** | Same; separate Vercel project |
| `api-gateway` | NestJS | **GCP Cloud Run** (public) | The one public backend entry; routes `/api/v1/{tenant}/{domain}` |
| `auth-service` | NestJS | **Cloud Run** (scale-to-zero) | JWT mint/verify |
| `project-service` | NestJS | **Cloud Run** | Tenant config + publish |
| `product-service` | NestJS | **Cloud Run** | Vector search + embeddings |
| `organization-service` | NestJS | **Cloud Run** | Billing containers |
| `agent-commerce-service` | NestJS (SSE) | **Cloud Run** | LLM agent stream |
| `retexture-service` | **Python (FastAPI)** | **Cloud Run (public)** | CDL 3D bake: wraps a custom design onto the real per-SKU mesh. Own Dockerfile (`apps/retexture-service/Dockerfile`), 2 vCPU / 2Gi, 900s timeout, concurrency 1, scale-to-zero. Public because the browser loads the baked GLB from its `/jobs/<id>/…` URLs (see §retexture below) |
| `analytics-service` / `data-service` / `lead-service` | NestJS | **Cloud Run — deploy later / not always** | Off the A&F path; deploy only when needed |
| Cache | Redis | **Upstash Redis (serverless)** | Per-request billing, scale-to-zero, free tier; wired via existing `@journeyax/cache` (`REDIS_URL`) |
| Database | Mongo | **Atlas M0** (already connected) | Free, managed, vector search |
| LLM | OpenAI/others | external API | Usage cost only |

**"Zero-demand" is honored end-to-end:** Vercel functions are per-invocation, Cloud Run scales to zero and wakes on a request, Upstash bills per command, Atlas M0 is free. **Nothing runs (or costs) while idle.**

**The wiring is already env-driven** (`AUTH_SERVICE_URL`, `PRODUCT_SERVICE_URL`, `PROJECT_SERVICE_URL`, `ORG_SERVICE_URL`, `AGENT_SERVICE_URL`, `GATEWAY_URL`, `STOREFRONT_URL`, `REDIS_URL`) — so "connect the tokens dynamically" = set these as Vercel/Cloud Run env vars pointing at the deployed URLs + the shared `INTERNAL_API_KEY`/JWT. No hardcoded hosts to change.

---

## 2. Architecture

```
   ┌────────────── Vercel (free Hobby) ──────────────┐
   │  journeyax-web (storefront + chat)              │   Browser ──► Vercel CDN/SSR
   │  backoffice-admin (control plane)               │
   │   • Next API routes / BFF run server-side       │
   │   • env: GATEWAY_URL, *_SERVICE_URL, INTERNAL_API_KEY, JWT_SECRET
   └───────────────────────┬─────────────────────────┘
                           │  server-to-server (HTTPS + token)
                           ▼
   ┌────────────── GCP Cloud Run (scale-to-zero) ─────┐
   │  api-gateway (public) ─► auth / project / product / org / agent
   │   secrets ◄── Secret Manager                     │
   └───────────────┬───────────────────┬──────────────┘
                   ▼                    ▼
        MongoDB Atlas M0        Upstash Redis (cache)        OpenAI API (usage)
```

Traffic path: **browser → Vercel** (renders UI, its serverless API routes proxy) **→ GCP api-gateway → internal services → Atlas/Redis/OpenAI**. The frontends never expose backend URLs to the browser — the GCP endpoints and tokens live in **server-side Vercel env vars**, so there's no CORS surface and no secret in client JS.

---

## 3. Pipeline — REUSE the Metafy pattern (Cloud Build + Vercel)

This is deliberately **the same process already running for Metafy AI** (`metafyai-aeo/metafy-ai-platform`) — a proven Cloud Build orchestrator + Vercel split. We copy its files and change only the service list, ports, and project IDs.

**Frontends (Vercel) — near-zero setup:** two Vercel projects (root dirs `apps/journeyax-web`, `apps/backoffice-admin`), each with a `vercel.json` like Metafy's (build shared packages, then the Next app; `installCommand: npm install --legacy-peer-deps`; `framework: nextjs`). Vercel's git integration auto-deploys on push and gives PR previews. **No workflow file.**

**Backends (GCP) — Google Cloud Build**, one `cloudbuild.yaml` with **4 steps** (exactly Metafy's), each a small script under `scripts/`:
1. **`detect`** — merge-base/`HEAD^` diff → writes `services_to_deploy.txt` (only changed services) + `build_config.sh`; configures Artifact Registry docker auth.
2. **`build-and-push`** — for each changed service, `docker build` from the **one shared `Dockerfile.template`** (`--build-arg SERVICE_NAME=<svc>`) → push to **Artifact Registry** (`us-central1-docker.pkg.dev/<project>/journeyax-services`).
3. **`deploy`** — `gcloud run deploy` per service with per-service scaling/secrets (table in §3a).
4. **`update-urls`** — collect every Cloud Run URL and **inject them into the gateway + all internal services** (`--update-env-vars *_SERVICE_URL=...`). This is your "connect the tokens dynamically" — service discovery done at deploy time, no hardcoded hosts.

**Trigger:** a **Cloud Build trigger** on branch push — `journeyax-qa` branch → QA project, `journeyax-production` branch → prod project (mirrors Metafy's `metafy-QA`/`metafy-production`). Cloud Build's free tier (120 build-min/day) covers path-filtered builds of a handful of changed services. *(A thin GitHub Actions job that just runs `gcloud builds submit --config cloudbuild.yaml` is optional if you want the trigger to live in GitHub instead of GCP — same result.)*

So: **push to a branch → Vercel redeploys the app that changed, Cloud Build redeploys only the service(s) that changed and re-wires their URLs.** Both git-driven, both on-demand.

### 3a. Per-service Cloud Run config (mirrors Metafy's `cloudbuild-deploy.sh` case block)

| Service | min | max | mem | cpu | port | notes |
|---------|-----|-----|-----|-----|------|-------|
| `api-gateway` | **1** | 20 | 1Gi | 2 | 8080 | kept warm (front door) |
| `auth-service` | **1** | 10 | 512Mi | 1 | 8080 | kept warm (every request verifies JWT) |
| `agent-commerce-service` | 0 | 5 | 1Gi | 2 | 8080 | scale-to-zero; SSE streaming |
| `product-service` | 0 | 5 | 1Gi | 1 | 8080 | scale-to-zero (embeddings/vector) |
| `project-service` / `organization-service` | 0 | 5 | 512Mi | 1 | 8080 | scale-to-zero |
| `analytics/data/lead` (later) | 0 | 5 | 512Mi | 1 | 8080 | scale-to-zero |

`min=0` = "wakes on demand, $0 idle." Only the gateway + auth stay warm so the *first* click of a demo isn't a cold-start chain — same choice Metafy made. (All services listen on `PORT` from Cloud Run; the numbers above are Metafy's convention.)

---

## 4. Secrets & config (dynamic token wiring)

| Where | Holds |
|-------|-------|
| **GCP Secret Manager** (services) | `MONGODB_URI`, `OPENAI_API_KEY`, `ANTHROPIC/CLAUDE/GEMINI/PERPLEXITY_API_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WHATSAPP_*`, `REDIS_URL` (Upstash) |
| **Cloud Run env vars** (services) | the `*_SERVICE_URL` links (Cloud Run URLs), `AUTH_DEV_BYPASS=false`, `CHAT_RATE_*`, `LLM_MODEL` |
| **Vercel env vars** (frontends, server-side) | `GATEWAY_URL`, `PROJECT_SERVICE_URL`, `AUTH_SERVICE_URL`, `ORG_SERVICE_URL` (Cloud Run URLs), `INTERNAL_API_KEY`, `JWT_SECRET`, `STRIPE_SECRET_KEY` (for order routes) |
| **Vercel `NEXT_PUBLIC_*`** (build-time, client) | only client-safe values (`STRIPE_PUBLISHABLE_KEY`, storefront URL) |

Rotating a token = update it in Secret Manager (services) or the Vercel dashboard (frontends) and redeploy — no code touch. This also **permanently fixes the `INTERNAL_API_KEY` drift** we hit: one canonical value per side, no shell-env divergence.

---

## 5. Cache — Upstash Redis (the "zero-demand" Redis)

Your `@journeyax/cache` is already **Redis-when-configured, memory-otherwise** (PERF-1). So:
- Create an **Upstash Redis** database (free tier: ~10k commands/day, 256 MB, **serverless — billed per request, scales to zero**).
- Put its connection string in `REDIS_URL` (Secret Manager → Cloud Run). Services that cache (back-office data routes, per-project config) light up automatically; nothing to rewrite.
- *Why Upstash over GCP Memorystore:* Memorystore is an always-on VM (~$35/mo min, not free); Upstash is pay-per-command and idles to $0 — matches your "only spend on demand" rule.

---

## 6. Networking / auth between Vercel and GCP

- **api-gateway** = public (allow-unauthenticated) — the intended front door; already rate-limited + JWT-guarded.
- **Internal services** (auth/project/product/org/agent): **launch option A (zero-code)** — reachable but protected by the existing `INTERNAL_API_KEY` + JWT + rate limits (Vercel's server-side functions attach the key, exactly like today's localhost calls). **Fast-follow option B:** lock them to `--no-allow-unauthenticated` and have the gateway call them with Cloud Run **IAM ID tokens** (free, needs a few lines to attach the token — a small future change).
- **Atlas allowlist:** `0.0.0.0/0` + SCRAM + TLS for zero cost (Cloud Run has dynamic egress IPs); static IP via VPC+NAT later (~$5/mo) if required.
- **Stripe / WhatsApp webhooks:** repoint to the Cloud Run gateway (or a Vercel route) public URL; signatures already verified in code.
- **Custom domains (free):** `app.` / `admin.` → Vercel; `api.` → Cloud Run gateway.

---

## 7. Cost

| Item | Tier | Idle | Light traffic |
|------|------|------|--------------|
| Vercel (2 Next apps) | Hobby (free) | $0 | $0 |
| Cloud Run (5–8 services, scale-to-zero) | Always-free | **$0** | $0–5 |
| Upstash Redis | Free (per-request) | $0 | ~$0 |
| Artifact Registry | 0.5 GB free | ~$0 | ~$0 |
| Secret Manager / GitHub Actions | Free tiers | $0 | $0 |
| MongoDB Atlas | M0 | $0 | $0 |
| **Infra total** | | **≈ $0** | **≈ $0–5** |
| OpenAI (LLM) | usage | — | the real variable spend, per conversation |

**Genuinely ~$0 at idle.** You pay only when someone actually uses it (Cloud Run wakes, Upstash serves a command, OpenAI runs) — exactly the on-demand model you asked for.

---

## 8. The trade-off of scale-to-zero (and how to hide it)

Waking a slept Cloud Run service costs ~1–3s (a "cold start"), and a chain (gateway→product→agent) stacks them. Options, cheapest first:
1. **Warm the demo** with one throwaway request first — $0.
2. **Cloud Scheduler ping** (free: 3 jobs) hits `/health` every ~5 min on the hot services — ~$0, keeps them warm during a demo window.
3. **`min-instances=1`** on gateway + agent + product for an always-snappy always-on setup — ~$5–15/mo (only if this becomes a real client env).
Recommend **#2 during active demos**, otherwise accept the wake for pure zero-cost.

---

## 9. Phased plan + artifacts to create (no code today)

**Phases**
- **P0 (½d):** GCP project + APIs + WIF; Secret Manager loaded; Upstash + Atlas allowlist; 2 Vercel projects linked to the repo.
- **P1 (½d):** smoke-test **product-service** alone on Cloud Run (proves Docker + Atlas + WIF); deploy **journeyax-web** to Vercel pointing at a stub.
- **P2 (1–2d):** deploy the **core backend set** (gateway, auth, project, product, org, agent) to Cloud Run; wire all `*_SERVICE_URL` + `REDIS_URL`; set Vercel env to the Cloud Run URLs → full A&F journey runs on real hosts.
- **P3 (½d):** GitHub Actions path-filtered matrix; warm-ping; custom domains; repoint Stripe/WhatsApp webhooks.
- **P4 (later):** IAM inter-service auth (option B), **startup DB-connect retry** (the crash we hit — matters more with cold starts + M0), analytics/data/lead, staging project.

**Artifacts — copy from Metafy (`metafyai-aeo/metafy-ai-platform`), change only the marked bits:**
| Copy this Metafy file | Into JourneyAX | Change |
|---|---|---|
| `Dockerfile.template` | repo root | swap `nest build` for JourneyAX's build script if different; keep multi-stage + non-root + `node apps/${SERVICE_NAME}/dist/main.js` |
| `cloudbuild.yaml` | repo root | rename tags; timeouts fine as-is (fewer services) |
| `scripts/cloudbuild-detect.sh` | `scripts/` | replace `ALL_SVCS` list with JourneyAX's 6 core services; set `ARTIFACT_REPO=journeyax-services`; branch names `journeyax-qa`/`journeyax-production` |
| `scripts/cloudbuild-build-push.sh` | `scripts/` | none (reads the service list) |
| `scripts/cloudbuild-deploy.sh` | `scripts/` | rewrite the per-service `case` (min/max/mem/cpu/port §3a) + the per-service **secrets** map (§4) for JourneyAX's keys |
| `scripts/cloudbuild-update-urls.sh` | `scripts/` | map JourneyAX's `*_SERVICE_URL` env names |
| `vercel.json` | `apps/journeyax-web/` + `apps/backoffice-admin/` | point build/output at each app |
| `.dockerignore` | repo root | node_modules, .next, .turbo, .env |

Plus a **secrets manifest** (names → Secret Manager), per §4. **No `output: 'standalone'` needed** — Vercel handles the Next apps. **No GitHub Actions file needed** unless you want the Cloud Build trigger to live in GitHub.

**JourneyAX deltas vs Metafy** (both are npm-workspaces + Turbo NestJS/Next monorepos, so ~95% is identical): fewer services (6 core vs 22); no Python `agents-runtime-py`; no WorkOS (JourneyAX uses its own JWT auth); add `REDIS_URL` (Upstash) + `INTERNAL_API_KEY` + `STRIPE_*` to the secrets map; fold in the **startup DB-connect retry** so cold-started services survive an Atlas TLS blip (the crash we hit).

---

## 10. Open decisions

1. **Frontends → Vercel, backends → Cloud Run scale-to-zero, via the Metafy Cloud Build pattern** ✔ (locked in — same process as Metafy).
2. **Cache → Upstash Redis** (serverless free) vs skip Redis for now (memory fallback still works)? → **Upstash** — cheap and you asked for it.
3. **Cold-start stance:** warm-ping during demos vs pay for min-instances? → **warm-ping** for now.
4. **Internal-service auth:** ship option **A** (INTERNAL_API_KEY, zero-code) now, IAM (B) as fast-follow? → **yes.**
5. **v1 scope:** 6 core services (gateway/auth/project/product/org/agent) + 2 Vercel apps; defer analytics/data/lead? → **yes.**

Give me your calls (2–5) and I'll produce the Dockerfiles, the `deploy-services.yml`, and a P0 setup checklist you can run.

---

## §retexture — deploying the CDL 3D bake service (P5)

`retexture-service` is the only **Python** service. It bakes a customer's design
onto the real per-SKU 3D mesh (render each view → Gemini paints it → back-project
into a UV atlas → `retextured.glb`). It rides the **same 4-step Cloud Build
pipeline** as the NestJS services, with three deltas already wired into the scripts:

1. **Own Dockerfile** — `apps/retexture-service/Dockerfile` (python:3.12-slim +
   `libgomp1/libgl1/libglib2.0-0` for onnxruntime/pillow; pre-downloads the rembg
   `u2net` model; runs `uvicorn app.main:app --port $PORT`). `cloudbuild-build-push.sh`
   auto-uses a per-service `Dockerfile` (with the **service dir** as context) when
   present, else the shared Node `Dockerfile.template`.
2. **Resources** (`cloudbuild-deploy.sh` case) — **2 vCPU / 2Gi**, `--timeout=900s`
   (a 4096 quality bake runs ~2–3 min), **`--concurrency=1`** (one bake saturates
   the CPU), `--min-instances=0` (scale-to-zero), `PORT=8091`.
3. **Public + URL wiring** — retexture-service is `--allow-unauthenticated` because
   the browser loads the baked GLB/atlas directly from `…/jobs/<id>/…` (cross-origin,
   no Google ID token possible). `cloudbuild-update-urls.sh` injects
   `RETEXTURE_SERVICE_URL` into **product-service** so `bake3d` can reach it.
   Secrets it needs: `GEMINI_API_KEY`, `INTERNAL_API_KEY` (both already in Secret
   Manager). Hardened by `X-Internal-Key` on `/retexture` + opaque job ids on `/jobs`.

### Deploy caveats (UAT-acceptable; fix before production)
- **Ephemeral `/jobs`.** Cloud Run's filesystem is per-instance and ephemeral, so a
  baked GLB is only served by the instance that made it (fine for the immediate
  load right after a bake, at concurrency 1). **Production:** write outputs to a
  per-project **GCS bucket** and return **signed URLs** (then retexture-service can
  go private again).
- **Web → product-service reachability for `bake3d`.** The storefront BFF
  `/api/cdl/bake3d` calls `PRODUCT_SERVICE_URL` **directly** (same pattern as
  `/cdl/flat` and `/cdl/decompose`), but product-service is private. Unlike those
  two, `bake3d` is **JSON in/out**, so the clean fix is to route it **through the
  public gateway** (`/api/v1/{project}/cdl/bake3d`) rather than direct — or make
  product-service reachable from Vercel via an ID token. Pre-existing for the CDL
  binary routes; not introduced by P5.
- **Cold start.** First request boots Python + loads the model (~10–20s) before the
  ~2–3 min bake. Acceptable for UAT; set `min-instances=1` if a warm bake path is
  wanted (costs ~always-on CPU).

### One-time GCP setup for this service
- Ensure `GEMINI_API_KEY` + `INTERNAL_API_KEY` exist in Secret Manager (they do —
  product/agent already mount them).
- The Artifact Registry repo (`journeyax-services`) and Cloud Build trigger already
  cover it — `retexture-service` is now in `ALL_SVCS` (`cloudbuild-detect.sh`), so a
  push to the QA branch builds+deploys it automatically.

### Local verification done (this pass)
- Dockerfile paths + all 4 pipeline scripts syntax-checked; `requirements.txt`
  proven installable on Python 3.12 (P1). **A local `docker build` was NOT run
  here** (no Docker daemon in this environment) — run `docker build -f
  apps/retexture-service/Dockerfile apps/retexture-service` once on a Docker host to
  confirm the image before the first cloud deploy.
