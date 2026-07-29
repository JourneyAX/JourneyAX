# JourneyAX — Enterprise Agentic Commerce Platform

An AI-powered, multi-tenant commerce platform built on a microservices monorepo. JourneyAX guides customers through conversational product journeys — from discovery and design through to quoting and checkout — powered by a ReAct AI agent, MongoDB Atlas Vector Search, and a JWT-secured API gateway.

---

## 🚀 Key Features

- **Conversational AI Agent** — ReAct loop (Thought → Action → Observation) with gpt-4o-mini, grounded in real product catalog data via RAG
- **Multi-Tenant Projects** — Every deployment is isolated by `projectId` at the MongoDB level. One platform, many brands (Caroma AU, Caroma NZ, Dorf Trade, etc.)
- **JWT Auth** — bcrypt + access/refresh token rotation. Anonymous chat allowed; backoffice requires a valid JWT
- **3-Tier API Gateway** — Single entry point (`:3010`) enforcing Public / Anonymous / Protected access per route
- **Real-Time Quoting** — Structured BOM with live pricing, tax, and discount rules per project
- **Backoffice Console** — Brand admin panel for config, members, channels, and branding

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), React, Vanilla CSS |
| **API Gateway** | NestJS (Node.js) |
| **AI Agent** | OpenAI gpt-4o-mini, ReAct loop |
| **Vector Search** | MongoDB Atlas `$vectorSearch` |
| **Auth** | bcrypt (12 rounds) + JWT (15min access / 7d refresh) |
| **Database** | MongoDB Atlas (multi-collection, projectId-isolated) |
| **Monorepo** | Turborepo + npm workspaces |
| **Language** | TypeScript throughout |

---

## 🏗 Monorepo Structure

```
journeyAX/
├── apps/
│   ├── journeyax-web/          # Customer chat UI         :3008
│   ├── backoffice-admin/       # Brand admin console      :3009
│   ├── api-gateway/            # Auth + routing gateway   :3010
│   ├── agent-commerce-service/ # AI ReAct agent           :3004
│   ├── auth-service/           # JWT auth (bcrypt)        :8080
│   ├── project-service/        # Tenant/project config    :8082
│   ├── product-service/        # Vector + RAG search      :8083
│   ├── data-service/           # Catalog sync             :8084
│   ├── organization-service/   # Billing container        :8085
│   ├── analytics-service/      # Commerce metrics         :8086
│   └── lead-service/           # CRM push                 :8087
└── packages/
    ├── shared-types/           # Shared TypeScript types
    ├── database/               # MongoDB connection pool
    ├── configurator-core/      # BOM/pricing calculations
    └── integration/            # External integrations
```

---

## 🌐 URLs

### Frontend

| App | URL | Purpose |
|---|---|---|
| **Customer Chat** | http://localhost:3008 | AI commerce chat for end customers |
| **Backoffice Admin** | http://localhost:3009 | Brand config, members, channels |

### API Gateway (Single Entry Point)

| | URL |
|---|---|
| **Gateway** | http://localhost:3010 |
| All frontend → backend traffic routes **only** through here | |

### Backend Services

| Service | URL | Status |
|---|---|---|
| auth-service | http://localhost:8080 | ✅ Live |
| project-service | http://localhost:8082 | ✅ Live |
| product-service | http://localhost:8083 | ✅ Live |
| data-service | http://localhost:8084 | ✅ Live |
| organization-service | http://localhost:8085 | ✅ Live |
| analytics-service | http://localhost:8086 | ⚠️ Stub |
| lead-service | http://localhost:8087 | ⚠️ Stub |
| agent-commerce-service | http://localhost:3004 | ✅ Live |

### Next.js Proxy Routes (web → gateway)

| Route | Proxies To |
|---|---|
| `POST /api/chat` | `gateway/api/v1/commerce/chat` |
| `GET /api/chat/stream` | `gateway/api/v1/commerce/chat/stream` |
| `POST /api/auth/[action]` | `gateway/api/v1/auth/[action]` |

---

## ⚙️ Getting Started

### Prerequisites

- Node.js v18+
- npm v10+
- MongoDB Atlas cluster (with Vector Search index configured)
- OpenAI API key

### 1. Install Dependencies

```bash
git clone https://github.com/JourneyAX/caroma-poc.git
cd caroma-poc/journeyAX
npm install
```

### 2. Environment Variables

Create a `.env` file at the **monorepo root** (`journeyAX/.env`):

```env
# LLM
OPENAI_API_KEY=sk-your-openai-api-key
LLM_MODEL=gpt-4o-mini

# Database
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/?appName=JourneyAX

# Auth (generate with: openssl rand -hex 32)
JWT_SECRET=your-256-bit-secret
JWT_REFRESH_SECRET=your-different-256-bit-secret

# Service URLs (defaults — change for cloud)
GATEWAY_URL=http://localhost:3010
AGENT_SERVICE_URL=http://localhost:3004
AUTH_SERVICE_URL=http://localhost:8080
PROJECT_SERVICE_URL=http://localhost:8082
PRODUCT_SERVICE_URL=http://localhost:8083
DATA_SERVICE_URL=http://localhost:8084
ORG_SERVICE_URL=http://localhost:8085
ANALYTICS_SERVICE_URL=http://localhost:8086
LEAD_SERVICE_URL=http://localhost:8087
```

---

## 🔨 Build Commands

### Run Everything (Recommended)

```bash
# Start all services in dev/watch mode
npm run dev

# Build all services (production)
npm run build

# Start all services from built dist/
npm run start
```

### Single Service

```bash
# Dev mode (hot reload)
npm run dev --workspace=auth-service
npm run dev --workspace=journeyax-web

# Build one service
npm run build --workspace=agent-commerce-service

# Start from built dist
npm run start --workspace=api-gateway
```

### Per-Service Scripts

| App | Dev | Build | Start |
|---|---|---|---|
| `api-gateway` | `tsx watch src/main.ts` | `tsc` | `node dist/main.js` |
| `journeyax-web` | `next dev -p 3008` | `next build` | `next start -p 3008` |
| `backoffice-admin` | `next dev -p 3009` | `next build` | `next start -p 3009` |
| All NestJS services | `tsx watch src/main.ts` | `tsc` | `node dist/main.js` |

> **Note:** Turbo builds shared packages (`@journeyax/database`, `@journeyax/shared-types`, etc.) before the apps that depend on them — dependency order is handled automatically.

---

## 🔐 Auth & Access Model

| Tier | Routes | Behaviour |
|---|---|---|
| **Public** | `/api/v1/auth/*`, `/health` | No token required |
| **Anonymous** | `/api/v1/commerce/chat`, `/api/v1/products` | Token optional — enriches session if present, never blocks |
| **Protected** | `/api/v1/analytics`, `/api/v1/leads`, `/api/v1/organizations`, etc. | JWT required — 401 if missing or invalid |

---

## 🗄 Data Isolation

All data is scoped by `projectId` at the MongoDB level:

```
Organization  →  billing container (name + billing info + list of projectIds)
Project       →  THE isolation unit — all data lives here

MongoDB filter applied to EVERY query:
  { projectId: "caroma" }
```

Collections and their isolation key:

| Collection | Isolation Key |
|---|---|
| `documents` (product knowledge) | `projectId` |
| `quotes` | `projectId` |
| `users` | `projectId` |
| `project_members` | `projectId` |
| `tenant_configs` | `projectId` (unique) |
| `organizations` | `orgId` (unique) |

---

## 📁 Key Files

| Purpose | File |
|---|---|
| Gateway route registry | `apps/api-gateway/src/gateway.registry.ts` |
| 3-tier AuthGuard | `apps/api-gateway/src/auth.guard.ts` |
| AI ReAct agent | `apps/agent-commerce-service/src/agent.service.ts` |
| Product vector search | `apps/product-service/src/product.service.ts` |
| JWT auth service | `apps/auth-service/src/auth.service.ts` |
| Project isolation context | `apps/project-service/src/project.service.ts` |
| Auth context (web) | `apps/journeyax-web/src/context/AuthContext.tsx` |
| Architecture skill | `skills/journeyax-enterprise/SKILL.md` |

---

*Built by JourneyAX — Enterprise Agentic Commerce Platform*
