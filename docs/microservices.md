# JourneyAX Microservices Architecture Specification

This document details the backend microservices architecture for the **JourneyAX Enterprise Agentic Commerce Platform**. Inspired by robust multi-tenant SaaS structures (like the Metafy AI Platform), JourneyAX is designed to support **both B2C retail experiences** (e.g., brand storefronts, consumer design packages) and **B2B trade commerce** (e.g., plumbing contractors, architects, ERP volume pricing).

---

## 🏗️ Architecture Blueprint

JourneyAX is built on a modular microservices model. Each domain service manages its own data scope through isolated database connections (MongoDB or Redis), routed via a centralized API Gateway.

```text
                                 ┌──────────────────────────────┐
                                 │ B2C Consumers & B2B Builders │
                                 └──────────────┬───────────────┘
                                                │
                                                ▼
                                     ┌─────────────────────┐
                                     │  Kong API Gateway   │ (Port 9000)
                                     └──────────┬──────────┘
                                                │
         ┌──────────────┬───────────────┬───────┴───────┬───────────────┬──────────────┐
         ▼              ▼               ▼               ▼               ▼              ▼
   ┌───────────┐  ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐  ┌───────────┐
   │   Auth    │  │   Org     │   │  Project  │   │  Product  │   │   Agent   │  │   Lead    │
   │  Service  │  │  Service  │   │  Service  │   │  Service  │   │ Commerce  │  │  Service  │
   └───────────┘  └───────────┘   └───────────┘   └───────────┘   └───────────┘  └───────────┘
    (Port 8080)    (Port 8081)     (Port 8082)     (Port 8083)     (Port 3004)    (Port 8090)
```

---

## 📋 Microservices Directory

| Microservice | Port | Purpose | Target Database | Key Domains (B2C & B2B) |
|:---|:---|:---|:---|:---|
| **Kong Gateway** | `9000` | Ingress proxy, CORS control, rate limiting, and JWT offloading. | None | Edge routing |
| **Auth Service** | `8080` | Handles SSO logins, JWT tokens, and user identities. | `journeyax_auth` | User sessions, contractor credentials |
| **Organization Service** | `8081` | Manages SaaS tenant boundaries, project workspaces, and RBAC memberships. | `journeyax_orgs` | Multi-tenancy, partner access controls |
| **Project Service** | `8082` | Stores project/brand settings, custom styling variables, cost budgets, and LLM preferences. | `journeyax_projects`| LLM routing, theme variables, prompt rules |
| **Product Service** | `8083` | Houses the canonical product catalog, variant indices, and vector embeddings. | `journeyax_products`| Vector Search, RAG chunking, collections |
| **Data Service** | `8084` | Synchronization pipeline pulling feeds from external platforms. | `journeyax_data` | Shopify (B2C), SAP/commercetools (B2B) |
| **Agent Commerce** | `3004` | ReAct conversational agent runtime, stream handling, and MCP tool execution. | `journeyax_agents` | SSE chat delivery, WELS audits, pricing rules |
| **Lead & Order Service** | `8090` | Captures configurations and BOMs, converting them to orders or CRM leads. | `journeyax_leads` | CRM (HubSpot/Salesforce), Checkout APIs |
| **Analytics Service**| `8086` | Metrics reporting on conversation funnels, average order values, and token costs. | `journeyax_analytics`| Business intelligence dashboards |

---

## 🔍 Service Deep Dive & SaaS Capabilities

### 1. Gateway Service (Port 9000)
* **Purpose:** Single point of entry for all API requests. 
* **Role:** Intercepts client subdomains (e.g. `abercombie.journeyax.com` or `admin.journeyax.com`), runs CORS, rate limits requests, and offloads JWT signature verification. It passes a verified `X-Tenant-ID` header to downstream services.

### 2. Organization Service (Port 8081)
* **Purpose:** Multi-tenant boundaries.
* **Role:** Governs the parent organizations, tenant accounts, and memberships. It controls which operators (CS reps, estimators) belong to which company and enforces Tenant-level logical scoping.

### 3. Project Service (Port 8082)
* **Purpose:** Configures custom brand workspaces.
* **Role:** Configures LLM parameters per project. For B2C retail projects, it routes to models like `gpt-4o-mini` optimized for conversational styling advice. For B2B projects, it coordinates complex parameter matching, cost thresholds, and custom system prompts.

### 4. Product Service (Port 8083)
* **Purpose:** Canonical product catalog and vector knowledge base.
* **Role:** Stores rich catalog data (dimensions, finishes, technical PDFs). Incorporates vector search to power product discovery. In B2C, it enables visual recommendation searches; in B2B, it queries engineering manuals for compatibility checking.

### 5. Data Ingestion Service (Port 8084)
* **Purpose:** Continuous catalog synchronization.
* **B2C & B2B Connectors:** Syncs consumer-facing store catalogs (e.g., from Shopify) and B2B transactional inventories (e.g., from commercetools, Hybris, or directly from SAP ERPs). Normalizes raw data feeds into a unified schema.

### 6. Agent Commerce Service (Port 3004) ⭐ **Core Conversational Engine**
* **Purpose:** Runs the autonomous AI agent loop.
* **ReAct Reasoning Loop:** Decides when to query products, request technical parameters, or calculate prices based on user inputs.
* **MCP Tool Integration:** Integrates calculators and compliance checkers:
  * `welsAuditor`: Enforce regulatory flow rates on tapware.
  * `b2cStyleGuards`: Match products against designed collections (e.g. Luna or Liano).
  * `b2bDiscountCalculator`: Look up contractor-specific discount tiers from ERP database collections.

### 7. Lead & Order Service (Port 8090)
* **Purpose:** Connects conversation sessions to transactional checkouts.
* **Dual Flows:** 
  * **B2C Flow:** Triggers direct storefront checkouts, processing carts via payment services (e.g., Stripe).
  * **B2B Flow:** Converts configured BOM sheets into active sales leads, automatically pushing the customer requirements to HubSpot/Salesforce CRM pipelines for representative review.

---

## 🔄 Multi-Tenant Data Isolation Policy

To support true SaaS scalability without isolated infrastructure footprints:
1. **Shared Database, Shared Collection:** Tenant records are hosted within shared MongoDB collections. 
2. **Mandatory Repository-Level Scoping:** All database queries must run through a custom repository layer (like Metafy's `BaseRepository`) that automatically appends the active tenant and project IDs to the query filter:
   ```typescript
   // Automatically scoping query filters
   const filter = { tenantId, projectId, ...userQuery };
   ```
3. **No Direct Inter-Service Database Access:** If the `Agent Commerce Service` needs tenant rules, it calls the `Project Service` API. Direct cross-database querying is strictly prohibited.
