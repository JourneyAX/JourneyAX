# JourneyAX Tenant Connector Migration Inventory & Truthful Audit

**Audit Timestamp**: `2026-09-28T03:48:57.516Z`
**Portfolio Manifest Version**: `1.0.0`
**Audit Mode**: Read-Only Architecture Enforcement & Evidence-Backed Verification

> **MIGRATION STATUS NOTICE**: Parked tenants do not affect active-portfolio readiness. Synthetic fixtures are excluded from readiness counts. Undiscovered active-portfolio tenants fail closed as `NOT_DISCOVERED` / `BLOCKED`.

---

## 1. Executive Summary

| Metric | Value |
| :--- | :--- |
| Active portfolio tenants | 4 |
| Discovered active tenants | 2 / 4 |
| Undiscovered active tenants | 2 / 4 |
| Immutable release ready (active) | 0 / 4 |
| Parked tenants (not counted) | 5 |
| Synthetic test fixtures (excluded) | 5 |

## 2. Active Portfolio Readiness Matrix

| Tenant ID | Display Name | Discovered | Schema | Semantics | Isolation | Status | Notes |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `placemakers` | PlaceMakers New Zealand | ✅ | PASS | PASS | YES | `BLOCKED` | First canonical migration. LOCAL_CANARY_PASSED. Production cutover pending DurableCutoverRecord approval. |
| `workweargroup` | Workwear Group | ✅ | PASS | PASS | YES | `BLOCKED` | Business Pack discovered on filesystem. Remaining gates computed from evidence. |
| `abercrombie` | Abercrombie & Fitch | ❌ | FAIL | FAIL | NO | `BLOCKED` | Not yet discovered. Business Pack authoring pending. |
| `caroma` | Caroma Australia | ❌ | FAIL | FAIL | NO | `BLOCKED` | Not yet discovered. Business Pack authoring pending. |

## 3. Parked Tenants (Not Counted in Active Readiness)

| Tenant ID | Display Name | Reason |
| :--- | :--- | :--- |
| `royalcyber` | Royal Cyber Digital | Parked pending business prioritisation. Do not count as active blocker. |
| `caroma-nz` | Caroma New Zealand | Parked — will follow caroma (AU) once AU is migrated. |
| `momentec` | Momentec Brands | Parked pending stakeholder sign-off. |
| `garts` | Gart Sports & Outdoor | Parked pending stakeholder sign-off. |
| `dragonshield` | Dragon Shield (Arcane Tinmen) | Parked pending stakeholder sign-off. |

## 4. Synthetic Test Fixtures (Topology Matrix Only)

| Tenant ID | Schema | Status |
| :--- | :---: | :---: |
| `placemakers_fixture` | PASS | `FIXTURE_EVALUATION_ONLY` |
| `abercrombie_fixture` | PASS | `FIXTURE_EVALUATION_ONLY` |
| `caroma_fixture` | PASS | `FIXTURE_EVALUATION_ONLY` |
| `momentec_fixture` | PASS | `FIXTURE_EVALUATION_ONLY` |
| `dragonshield_fixture` | PASS | `FIXTURE_EVALUATION_ONLY` |
