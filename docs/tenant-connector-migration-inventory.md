# JourneyAX Tenant Connector Migration Inventory & Truthful Audit

**Audit Timestamp**: `2026-09-28T20:12:06.166Z`
**Portfolio Manifest Version**: `1.0.0`
**Audit Mode**: Read-Only Architecture Enforcement & Evidence-Backed Verification

> **MIGRATION STATUS NOTICE**: Parked tenants do not affect active-portfolio readiness. Synthetic fixtures are excluded from readiness counts. Undiscovered active-portfolio tenants fail closed as `NOT_DISCOVERED` / `BLOCKED`. Any discovered tenant absent from the portfolio manifest is classified as `UNREGISTERED` and `BLOCKED`.

---

## 1. Executive Summary

| Metric | Value |
| :--- | :--- |
| Configured active portfolio tenants | 4 |
| Discovered active tenants (on disk) | 4 / 4 |
| Undiscovered active tenants (pending authoring) | 0 / 4 |
| Immutable release ready (active) | 0 / 4 |
| Configured parked tenants (excluded from readiness) | 5 |
| Discovered parked tenants (on disk) | 1 / 5 |
| Undiscovered parked tenants | 4 / 5 |
| Configured synthetic fixtures (excluded from readiness) | 5 |
| Discovered synthetic fixtures (on disk) | 0 / 5 |
| Discovered unregistered tenants (governance violations) | 0 |

## 2. Active Portfolio Readiness Matrix

| Tenant ID | Display Name | Discovered | Schema | Semantics | Isolation | Status | Notes |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `abercrombie` | Abercrombie & Fitch | ✅ | PASS | PASS | YES | `BLOCKED` | Business Pack discovered on filesystem. Remaining gates computed from evidence. |
| `caroma` | Caroma Australia | ✅ | PASS | PASS | YES | `BLOCKED` | Business Pack discovered on filesystem. Remaining gates computed from evidence. |
| `placemakers` | PlaceMakers New Zealand | ✅ | PASS | PASS | YES | `BLOCKED` | First canonical migration. LOCAL_CANARY_PASSED. Production cutover pending DurableCutoverRecord approval. |
| `workweargroup` | Workwear Group | ✅ | PASS | PASS | YES | `BLOCKED` | Business Pack discovered on filesystem. Remaining gates computed from evidence. |

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
