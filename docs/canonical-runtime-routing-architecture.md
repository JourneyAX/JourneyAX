# JourneyAX — Canonical Runtime Routing & Cutover Architecture

**Status**: Active Production Specification
**Version**: 2.0.0
**Last Updated**: 2026-09-27

---

## 1. Executive Summary

This document specifies the routing, cutover governance, and execution architecture for JourneyAX.
The platform operates on a **canonical runtime** powered by declarative **Business Packs**, with strict, fail-closed cutover routing enforced at the boundary.

Legacy `AgentService` (`apps/agent-commerce-service`) is **frozen legacy compatibility**, reserved exclusively for explicitly unmigrated tenants (where no cutover record exists in `tenant_cutovers`).

---

## 2. End-to-End Request Flow

```
                      [ Incoming User Request ]
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │      API Gateway      │
                     │  (or Ingress Boundary)│
                     └───────────┬───────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │   Cutover Decision    │
                     │  (CutoverProxyService)│
                     └───────────┬───────────┘
                                 │
       ┌─────────────────────────┴─────────────────────────┐
       │                                                   │
  [No Cutover Record]                             [Cutover Record Exists]
       │                                                   │
       │ (404 / Unmigrated Tenant)                         ▼
       ▼                                         ┌───────────────────┐
┌──────────────┐                                 │ Fail-Closed Checks│
│ AgentService │                                 └─────────┬─────────┘
│   (Frozen    │                                           │
│    Legacy    │                  ┌────────────────────────┴────────────────────────┐
│Compatibility)│                  │                                                 │
└──────────────┘           [Record Invalid, Stale,                          [Record Approved &
                           Checksum Mismatch, Timeout,                       Canary Selected]
                           or Rollback State]                                       │
                                  │                                                 ▼
                                  ▼                                      ┌───────────────────────┐
                           ┌──────────────┐                              │   Canonical Runtime   │
                           │ 500 / Error  │                              │(journey-runtime-serv.)│
                           │(Fail Closed; │                              └──────────┬────────────┘
                           │ NEVER Legacy)│                                         │
                           └──────────────┘                                         ▼
                                                                         ┌───────────────────────┐
                                                                         │     Business Pack     │
                                                                         │  (Immutable Release)  │
                                                                         └──────────┬────────────┘
                                                                                    │
                                                          ┌─────────────────────────┴─────────────────────────┐
                                                          │                                                   │
                                                          ▼                                                   ▼
                                               ┌────────────────────┐                              ┌────────────────────┐
                                               │    Model Policy    │                              │ Dynamic Connector  │
                                               │ (Provider/Fallback)│                              │      Bindings      │
                                               └────────────────────┘                              └────────────────────┘
```

---

## 3. Core Architectural Stages

### 3.1 Gateway Ingress & Cutover Decision
Every incoming request (turn or SSE stream) passes through the cutover evaluation before any business logic or legacy session state is initialized:
- The decision queries `tenant_cutovers` for `(tenantId, environmentId)`.
- If **no record exists** (404 / tenant unmigrated), request routes to legacy `AgentService`.
- If a record **exists**, the request is strictly governed by canonical cutover policies.

### 3.2 Fail-Closed Invariants
To guarantee tenant security and operational safety:
1. **Any failure fails closed**: If the cutover lookup experiences a timeout, database disconnect, malformed record, or checksum mismatch, the request returns HTTP 500 / error. It **never falls back to legacy `AgentService`**.
2. **Checksum Verification**: The Business Pack executable checksum must match the approved cutover record checksum exactly.
3. **Rollback Safety**: If a cutover record status is `rolled_back`, traffic is pinned to the declared rollback baseline version.
4. **Deterministic Canary**: When `status === 'canary'`, traffic is split deterministically using `@journeyax/journey-core`'s shared `evaluateCanaryCutover` hashing `(tenantId, environmentId, sessionOrWorkspaceId)` against `canaryPercentage`.

### 3.3 Canonical Runtime (`journey-runtime-service`)
The canonical runtime is a stateless execution engine:
- Loads the immutable Business Pack from disk or cache using the validated checksum.
- Evaluates conversation policies, fencing rules, and escalation thresholds.
- Orchestrates multi-stage journeys (`stage_discovery`, `stage_checkout`, etc.).
- Executes capabilities strictly bounded to tenant isolation policies.

### 3.4 Business Pack release structure
A Business Pack contains the complete declarative tenant configuration:
- `manifest`: Versioning, metadata, authoring, and cryptographic checksum.
- `profile`: Company name, brand values, supported currencies, locales.
- `conversationPolicy`: Fencing rules, prohibited topics, sentiment escalation thresholds.
- `modelPolicy`: Priority candidate list of models (`custom`, `openai`, `anthropic`, `google`, `open-model`) with per-model residency and token budgets.
- `capabilities & toolBindings`: Dynamic bindings mapping tool definitions to native capabilities or Activepieces flows with risk policies, timeouts, and idempotency guarantees.

### 3.5 Frozen Legacy Compatibility (`AgentService`)
`AgentService` in `apps/agent-commerce-service` is **frozen legacy compatibility**:
- Maintained solely for existing unmigrated tenants.
- Must not receive new tenant logic, feature expansion, or ad-hoc routing conditions.
- Cutover logic is decoupled into `CutoverProxyService` to keep `AgentService` strictly as an adapter.

---

## 4. Portfolio Governance & Discovery

Packs are dynamically discovered from `packs/` and governed by `config/portfolio-manifest.json`:
- **ACTIVE_PORTFOLIO**: Tenants actively in scope for migration (`placemakers`, `workweargroup`, `abercrombie`, `caroma`).
- **PARKED**: Tenants on hold (`royalcyber`, `dragonshield`, `momentec`, `garts`, `caroma-nz`). Parked tenants are excluded from active-portfolio readiness metrics and do not block releases.
- **SYNTHETIC_FIXTURE**: Test fixtures (identified by `_fixture` suffix) used for isolated topology verification; strictly excluded from customer readiness counts.
