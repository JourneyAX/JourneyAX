
## 1. CONFIRMED SERVICE ARCHITECTURE (as of 2026-07-07)

### Data Isolation Model — THE MOST IMPORTANT RULE

```
Organization  →  just a billing/naming container (name + billing + list of projectIds)
Project       →  THE data isolation unit. ALL data is scoped by projectId.

Org
└── [projectId, projectId, ...]   ← refs only, no data here

Project (caroma)
├── product knowledge docs   filtered by { projectId: "caroma" }
├── quotes                   filtered by { projectId: "caroma" }
├── user accounts            filtered by { projectId: "caroma" }
├── member roles             filtered by { projectId: "caroma" }
└── config (scope/pricing/persona/theme/channels)
```

**THE ISOLATION RULE — NEVER BREAK:**
Every MongoDB query in every service MUST include `{ projectId }` in the filter.
Use `getIsolationContext(projectId)` from project-service to get the filter object.

```typescript
// In any service — always do this first:
const ctx = await projectService.getIsolationContext(projectId);
// ctx.mongoFilter = { projectId: 'caroma' }
// Apply ctx.mongoFilter on EVERY MongoDB query
const docs = await col.find({ ...ctx.mongoFilter, ...otherFilters }).toArray();
```

### MongoDB Collections — Isolation Fields

| Collection | Isolation Key | Example Filter |
|---|---|---|
| `documents` (product chunks) | `projectId` | `{ projectId: 'caroma' }` |
| `quotes` | `projectId` | `{ projectId: 'caroma' }` |
| `users` | `projectId` | `{ projectId: 'caroma', email }` |
| `project_members` | `projectId` | `{ projectId: 'caroma', email }` |
| `tenant_configs` | `projectId` (unique) | `{ projectId: 'caroma' }` |
| `organizations` | `orgId` (unique) | `{ orgId: 'org-gwa' }` |
| `refresh_tokens` | `email` (→ user → projectId) | `{ email }` |

### Verified Running Services & Ports


| Service | Port | Role | Status |
|---|---|---|---|
| `api-gateway` | **3010** | Single entrypoint — proxies ALL traffic. Owns auth + tenant resolution | ✅ Live |
| `journeyax-web` | **3008** | Next.js chat UI — thin proxy to gateway only | ✅ Live |
| `backoffice-admin` | **3009** | Brand admin console (Next.js) — JWT protected | ✅ Live |
| `agent-commerce-service` | **3004** | JourneyAXController + AgentService — AI ReAct loop | ✅ Live |
| `product-service` | **8083** | MongoDB Atlas vector search + RAG token budgeting | ✅ Live |
| `project-service` | **8082** | Dynamic tenant config from MongoDB | ✅ Live |
| `auth-service` | **8080** | Real JWT auth: bcrypt + MongoDB users + refresh tokens | ✅ Live |
| `data-service` | **8084** | ConnectorRegistry — catalog sync (Shopify) | ✅ Live |
| `organization-service` | **8085** | Org/tenant management | ⚠️ Stub |
| `analytics-service` | **8086** | Commerce metrics | ⚠️ Stub |
| `lead-service` | **8087** | CRM lead push — HubSpot/Salesforce | ⚠️ Stub |

### Confirmed End-to-End Flow (VERIFIED WORKING)

```
Browser (anonymous OR authenticated)
  │
  │  POST /api/chat  (no token = anonymous guest, with token = enriched user)
  ▼
journeyax-web :3008  (Next.js thin proxy)
  │
  │  POST /api/v1/commerce/chat  +  X-Tenant-ID  +  Authorization: Bearer <token> (optional)
  ▼
api-gateway :3010  ← THE SINGLE INTEGRATION POINT
  │  ┌─ TenantMiddleware   (extract X-Tenant-ID from header or subdomain)
  │  ├─ AuthGuard          (3-tier: public / anonymous / protected — see §2)
  │  └─ GatewayService     (resolve route from SERVICE_REGISTRY, proxy via fetch)
  │
  │  Forwards to: http://localhost:3004/api/v1/commerce/chat
  │  With headers: X-Tenant-ID, X-User-Email, X-User-Role, X-Auth-Type
  ▼
agent-commerce-service :3004  (JourneyAXController)
  │  AgentService.processChat() → ReAct loop (Thought→Action→Observation)
  │  Tool: searchKnowledge(query, brand, type, category)
  ▼
product-service :8083  (ProductService)
  │  embedText()    → OpenAI text-embedding-3-small
  │  vectorSearch() → MongoDB Atlas $vectorSearch
  │  regexSearch()  → Fallback regex match
  │  Token Budget   → Max 1,500 tokens returned
  ▼
MongoDB Atlas  (journeyx DB → documents collection)
```

### Key Architecture Rules — NEVER BREAK THESE
1. **UI NEVER calls backend services directly** — ALL traffic goes through `api-gateway :3010`
2. **`route.ts` in journeyax-web ONLY calls** `GATEWAY_URL` (default: `http://localhost:3010`)
3. **Anonymous chat is allowed** — `/api/v1/commerce/chat` does not require a token
4. **Backoffice requires JWT** — all non-public gateway routes require `Authorization: Bearer <token>`
5. **AuthGuard calls auth-service `/verify`** on every token — never validates JWT locally in the gateway
6. **ProductService** owns all MongoDB product access — agent calls it via HTTP, never directly

---

## 2. THREE-TIER AUTH SYSTEM (API Gateway)

**CRITICAL**: The gateway `auth.guard.ts` implements exactly three access tiers. Never collapse these.

### Tier 1 — PUBLIC (no token required, not even checked)
```
/api/v1/auth/login
/api/v1/auth/register
/api/v1/auth/refresh
/api/v1/auth/logout
/health
```

### Tier 2 — ANONYMOUS_ROUTES (token OPTIONAL)
```
/api/v1/commerce/chat     ← customer chat: anyone can chat
/api/v1/commerce/health
/api/v1/products          ← product search: public read-only
```
- **No token** → proceeds with `x-user-role: guest`, `x-auth-type: anonymous`
- **Valid token** → claims injected, `x-auth-type: jwt` (enriched session — saved quotes, personalization)
- **Bad/expired token** → falls through as guest (never blocks chat)

### Tier 3 — PROTECTED (token REQUIRED)
```
/api/v1/analytics/*
/api/v1/leads/*
/api/v1/organizations/*
/api/v1/projects/*
/api/v1/data/*
... all other routes
```
- No token → `401 Unauthorized` (in production) / dev passthrough with warning
- Invalid token → `401 Unauthorized`
- Auth-service unreachable → `503 Service Unavailable` (in production) / dev passthrough

### Headers Injected by AuthGuard (downstream services receive these)
```
X-User-Email:  test@caroma.com  (or "guest@anonymous")
X-User-Role:   buyer | admin | manager | guest
X-User-Name:   Full Name
X-Tenant-ID:   caroma           (from JWT claim — authoritative)
X-Auth-Type:   jwt | anonymous
```

---

## 3. AUTH SERVICE IMPLEMENTATION (auth-service :8080)

### Endpoints
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/register` | Public | bcrypt hash, MongoDB user store, tenant-scoped |
| POST | `/api/v1/auth/login` | Public | Verify password, issue Access (15min) + Refresh (7d) JWT pair |
| POST | `/api/v1/auth/verify` | Public | Verify JWT — called by API Gateway AuthGuard on every request |
| POST | `/api/v1/auth/refresh` | Public | Rotate tokens — old refresh revoked, new pair issued |
| POST | `/api/v1/auth/logout` | Public | Revoke refresh token from MongoDB |
| GET  | `/api/v1/auth/health` | Public | Health check |

### Security Design
- **bcrypt (12 rounds)** — passwords never stored in plain text
- **Access token**: 15 minutes, signed with `JWT_SECRET`, audience=`journeyax-api`, issuer=`journeyax-auth`
- **Refresh token**: 7 days, stored in MongoDB `refresh_tokens` collection with TTL auto-delete index
- **Token rotation**: every refresh issues a new pair, old token deleted from DB
- **Tenant isolation**: `tenantId` embedded in JWT claim — authoritative for all downstream routing

### JWT Token Payload Shape
```typescript
interface TokenPayload {
  sub: string;        // user email
  tenantId: string;   // e.g. "caroma"
  role: 'admin' | 'buyer' | 'manager';
  fullName: string;
  iat: number;
  exp: number;
  aud: 'journeyax-api';
  iss: 'journeyax-auth';
}
```

### MongoDB Collections (auth-service)
- `users`: `{ email (unique index), passwordHash, tenantId, role, fullName, isActive, createdAt, lastLoginAt }`
- `refresh_tokens`: `{ token (unique), email, expiresAt }` — TTL index auto-deletes expired tokens

---

## 4. FRONTEND AUTH PATTERNS

### journeyax-web (Chat — Anonymous + Optional Auth)

**File structure:**
```
src/context/AuthContext.tsx          ← JWT state, auto-refresh, localStorage persistence
src/app/api/auth/[action]/route.ts   ← Proxy: /api/auth/login → gateway → auth-service
src/app/api/chat/route.ts            ← Proxy: /api/chat → gateway (attaches token if present)
src/components/ChatPanel.tsx         ← getAccessToken() before every fetch, falls back to anon
```

**AuthContext responsibilities:**
- Persists `{ user, tokens }` to `localStorage` keys `jax_user` / `jax_tokens`
- `getAccessToken()` → returns valid token, auto-refreshes 60s before expiry
- Refresh singleton lock — prevents concurrent refresh race conditions
- `login(email, password, tenantId)` → calls `/api/auth/login` proxy
- `logout()` → calls `/api/auth/logout` to revoke server-side, clears localStorage

**ChatPanel pattern — always use this for every chat fetch:**
```typescript
const { getAccessToken } = useAuth();

const token = await getAccessToken(); // null if anonymous — that's fine
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (token) headers['Authorization'] = `Bearer ${token}`;

const res = await fetch('/api/chat', { method: 'POST', headers, body: ... });
```

**Token storage locations:**
- `localStorage.jax_user` — `{ email, tenantId, role, fullName }`
- `localStorage.jax_tokens` — `{ accessToken, refreshToken, expiresIn, expiresAt }`

### backoffice-admin (Always Protected — JWT Required)

**Auth guard pattern:**
- Check `localStorage.jax_tokens` on mount
- If no token or expired → redirect to login page / show login wall
- All API calls include `Authorization: Bearer <token>`
- On 401 response → clear tokens, redirect to login
- Same `AuthContext` pattern as journeyax-web

---

## 5. SERVICE REGISTRY (gateway.registry.ts)

```typescript
'/api/v1/commerce'      → AGENT_SERVICE_URL      (default: http://localhost:3004)
'/api/v1/products'      → PRODUCT_SERVICE_URL    (default: http://localhost:8083)
'/api/v1/projects'      → PROJECT_SERVICE_URL    (default: http://localhost:8082)
'/api/v1/auth'          → AUTH_SERVICE_URL       (default: http://localhost:8080)
'/api/v1/organizations' → ORG_SERVICE_URL        (default: http://localhost:8085)
'/api/v1/analytics'     → ANALYTICS_SERVICE_URL  (default: http://localhost:8086)
'/api/v1/leads'         → LEAD_SERVICE_URL       (default: http://localhost:8087)
'/api/v1/data'          → DATA_SERVICE_URL       (default: http://localhost:8084)
```

### Environment Variables (root .env)
```bash
# Gateway
GATEWAY_URL=http://localhost:3010

# Service URLs
AGENT_SERVICE_URL=http://localhost:3004
PRODUCT_SERVICE_URL=http://localhost:8083
PROJECT_SERVICE_URL=http://localhost:8082
AUTH_SERVICE_URL=http://localhost:8080
DATA_SERVICE_URL=http://localhost:8084
ORG_SERVICE_URL=http://localhost:8085
ANALYTICS_SERVICE_URL=http://localhost:8086
LEAD_SERVICE_URL=http://localhost:8087

# Auth
JWT_SECRET=<256-bit random string — never commit to git>
JWT_REFRESH_SECRET=<different 256-bit random string>
AUTH_SERVICE_PORT=8080

# LLM
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=<key>
MONGODB_URI=<atlas-connection-string>
```

---

## 6. Monorepo & Workspace Management

**Apps (`apps/`)** — all Turborepo workspaces:
- `api-gateway/` — NestJS API Gateway, owns ALL external routing
- `journeyax-web/` — Next.js chat UI, thin proxy only
- `backoffice-admin/` — Brand console (Next.js)
- `agent-commerce-service/` — AI commerce orchestration
- `product-service/` — MongoDB product knowledge search
- `project-service/` — Tenant config service
- `auth-service/` — JWT auth (real bcrypt + MongoDB)
- `data-service/` — Catalog sync ConnectorRegistry
- `lead-service/` — CRM push
- `analytics-service/` — Commerce metrics
- `organization-service/` — Org/tenant management

**Packages (`packages/`):**
- `configurator-core/` — business calculation logic
- `shared-types/` — shared TypeScript interfaces
- `database/` — MongoDB connection pool (used by auth-service, product-service, project-service)

**Imports — always use package namespace:**
```typescript
import { connectToDatabase } from '@journeyax/database';
import { Quote, BomItem } from '@journeyax/shared-types';
import { calculateTotals } from '@journeyax/configurator-core';
```

### NestJS DI Rule for tsx watch — CRITICAL
When using `tsx watch`, always use explicit `@Inject(ServiceClass)` on every constructor parameter:
```typescript
// ✅ CORRECT — always do this
constructor(@Inject(AuthService) private readonly authService: AuthService) {}

// ❌ WRONG — breaks with tsx watch (emitDecoratorMetadata not honoured)
constructor(private readonly authService: AuthService) {}
```

---

## 7. Frontend Design & Theming Guidelines

### Color & Styling System
- **Brand Colors:** Signal Yellow (`#FFD600`), near-black (`#0A0A0A`), white. No gradients on content cards.
- **Typography:** Space Grotesk (headings, 700/800 weight, -0.02em tracking) + DM Sans (body, 400/500 weight, 1.65 line-height)
- **Sharp corners:** `border-radius: 0` on all standard buttons, inputs, tags, stat blocks, containers
- **Rounded exception:** chat bubbles (16px), plan cards (12px), chat shell (16px)

### Customer Journey Studio Layout
- Desktop: fixed `40% / 60%` split (Chat left, Configurator/Product canvas right)
- Responsive: single column under `880px`

---

## 8. Multi-Tenant MongoDB Standards

### Rules — NEVER violate tenant isolation
1. Every MongoDB query **MUST** include `tenantId` filter:
   ```typescript
   const filter = { tenantId: activeTenantId };
   ```
2. Embedded BOMs — store BOM rows directly inside `quotes` collection as subdocument arrays
3. Soft category filtering — use `$or` to allow missing `metadata.category`:
   ```typescript
   filter['$or'] = [
     { 'metadata.category': category },
     { 'metadata.category': { $exists: false } },
     { 'metadata.category': null },
   ];
   ```
4. Never expose raw MongoDB `_id` to clients — always map to string

---

## 9. Dynamic Configuration & Theme Customization

1. **Adding Tenants:** Create `/config/tenants/{tenantId}.yaml`
2. **Reading Configs:** Use `getTenantConfig(tenantId)` — cached, never hardcode in TS/React
3. **CSS Theming:** Always `var(--primary-color)`, `var(--accent-color)` — never hardcode hex values

---

## 10. Observability & Logging Standards

1. JSON logging via Pino/Winston to stdout
2. Required fields on every log: `tenantId`, `correlationId`, `timestamp`, `message`
3. Wrap all LLM tool calls and vector searches in OTel trace spans

---

## 11. Weaviate Context Engineering — 6 Pillars Applied

All agents must adhere to the **Weaviate Context Engineering 6-Pillar Framework**:

### Pillar 1: Agentic Orchestration
- ReAct loop (Thought→Action→Observation) in `AgentService`
- Self-healing: if tool call fails, agent reformulates and retries
- Decoupled: routing logic in `OrchestratorService`, not in the controller

### Pillar 2: Query Augmentation (before hitting vector store)
1. **Rewrite** — restructure vague queries into search-optimized keywords
2. **Expand** — add synonyms and related terminology
3. **Decompose** — split multi-faceted requests into parallel sub-queries

### Pillar 3: Retrieval & Chunking
- **Max 1,500 tokens** per search response — enforced in `ProductService.search()`
- Vector search first → regex fallback if vector index unavailable
- High-precision data (SKUs, dimensions): 50-100 token atomic chunks
- Rich context (install guides, brochures): recursive header-based chunking

### Pillar 4: Prompting & Tool Hygiene
- **HALLUCINATION RULE**: Agent MUST NEVER invent products, prices, or SKUs. ALL product data MUST come from `searchKnowledge` tool results. This is non-negotiable.
- Prompt structure: System rules (top) → Compacted history (middle) → Retrieved facts + user query (bottom)
- All tool parameters documented with active verbs, types, JSON return schemas

### Pillar 5: Hybrid Memory Tiers
- **Working memory**: request state object (current phase, BOM, finish, qty)
- **Long-term semantic**: MongoDB `quotes` collection (embedded BOM arrays)
- **Episodic**: interaction logs — prune after 90 days, keep summaries only

### Pillar 6: Tool Protocols (MCP)
- All external integrations (CRM, ERP, PIM) exposed as MCP servers
- JSON-RPC standard over MCP — decouples agent logic from API updates

---

## 12. Modular Service Layer Pattern

```
[Browser — anonymous or JWT authenticated]
         │
         │  HTTPS (optional: Authorization: Bearer <token>)
         ▼
[API Gateway :3010]  ← SINGLE ENTRY POINT
  ├─ TenantMiddleware   → extract X-Tenant-ID
  ├─ AuthGuard          → 3-tier (public / anonymous / protected)
  │    PUBLIC:     /auth/*, /health
  │    ANONYMOUS:  /commerce/chat, /products  ← CHAT IS OPEN TO EVERYONE
  │    PROTECTED:  /analytics, /leads, /orgs, /data (backoffice routes)
  └─ GatewayService     → service registry proxy
         │
    ┌────┴────────────────────────────────┐
    │                                     │
    ▼                                     ▼
[JourneyAXController :3004]       [Other Services :80xx]
 AgentService (ReAct)              auth :8080 (real JWT)
    │                              product :8083
    │  HTTP searchKnowledge()      project :8082
    ▼                              data :8084
[ProductService :8083]             lead :8087
  embedText() → OpenAI             analytics :8086
  vectorSearch() → MongoDB         org :8085
  Token budget: 1,500 tokens
    │
    ▼
[MongoDB Atlas — journeyx DB]
  documents collection (product knowledge chunks)
  quotes collection    (embedded BOM arrays)
  users collection     (bcrypt hashed, tenantId scoped)
  refresh_tokens       (TTL auto-delete after 7 days)
```

---

## 13. Key Files Quick Reference

| What | File |
|---|---|
| Gateway entry | `apps/api-gateway/src/main.ts` |
| Route registry | `apps/api-gateway/src/gateway.registry.ts` |
| **3-tier auth guard** | `apps/api-gateway/src/auth.guard.ts` |
| Web proxy (calls gateway) | `apps/journeyax-web/src/app/api/chat/route.ts` |
| Auth proxy (web → gateway) | `apps/journeyax-web/src/app/api/auth/[action]/route.ts` |
| **AuthContext (auto-refresh)** | `apps/journeyax-web/src/context/AuthContext.tsx` |
| Commerce controller | `apps/agent-commerce-service/src/agent.controller.ts` |
| AI ReAct loop | `apps/agent-commerce-service/src/agent.service.ts` |
| Product vector search | `apps/product-service/src/product.service.ts` |
| **JWT auth service** | `apps/auth-service/src/auth.service.ts` |
| Auth controller | `apps/auth-service/src/auth.controller.ts` |
| Tenant config | `apps/project-service/src/project.service.ts` |
| Root env | `.env` (never commit JWT_SECRET) |
| This skill | `skills/journeyax-enterprise/SKILL.md` |
