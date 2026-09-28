# JourneyAX — Canonical Pack Dry-Run Evaluation Report

**Generated At**: `2026-09-28T11:15:16.911Z`

**Branch / Commit**: `JourneyAX-dev-v4` / `d7ac843727e9a63d497b16aa523a62b52e77a8c6`

**Portfolio Manifest Version**: `1.0.0`

**Evaluation Mode**: Offline Filesystem Dry-Run — schema compilation and canonical conformance.

**Active Portfolio**: placemakers, workweargroup, abercrombie, caroma

**Parked (excluded)**: royalcyber, caroma-nz, momentec, garts, dragonshield

> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack schema compilation and semantic integrity. It does **not** grant cutover approval. Production routing strictly requires an approved, signed `DurableCutoverRecord` in `tenant_cutovers`. Any discovered tenant absent from the portfolio manifest is classified as `UNREGISTERED` and `BLOCKED`.

---

## 1. Executive Summary

| Category | Configured | Discovered on Disk | Status / Count |
| :--- | :---: | :---: | :--- |
| Active portfolio tenants | 4 | 2 | 2 passed, 2 pending authoring / blocked |
| Parked tenants (excluded from readiness) | 5 | 1 | 1 discovered, 4 pending authoring |
| Synthetic fixtures (excluded from readiness) | 5 | 0 | 5 configured |
| Unregistered tenants (governance violations) | — | 0 | 0 violations |

## 2. Active Portfolio Dry-Run Results

| Tenant ID | Version | Schema | Semantic | Checksum (SHA-256, first 16) | Status |
| :--- | :---: | :---: | :---: | :--- | :---: |
| `placemakers` | `1.0.0` | ✅ PASS | ✅ PASS | `3f66adbae9468d3d...` | 🟢 DRY_RUN_PASSED |
| `workweargroup` | `1.0.0` | ✅ PASS | ✅ PASS | `fb5133ff8f2e7f93...` | 🟢 DRY_RUN_PASSED |
| `abercrombie` | `` | ❌ FAIL | ❌ FAIL | — | 🔴 BLOCKED |
| `caroma` | `` | ❌ FAIL | ❌ FAIL | — | 🔴 BLOCKED |

## 3. Validation Issues

### `abercrombie`
- Pack not found on filesystem

### `caroma`
- Pack not found on filesystem

## 4. Parked Tenants (Excluded)

| Tenant ID | Source | Reason |
| :--- | :---: | :--- |
| `royalcyber` | `filesystem_pack` | Parked pending business prioritisation. Do not count as active blocker. |
| `caroma-nz` | `not_discovered` | Parked — will follow caroma (AU) once AU is migrated. |
| `momentec` | `not_discovered` | Parked pending stakeholder sign-off. |
| `garts` | `not_discovered` | Parked pending stakeholder sign-off. |
| `dragonshield` | `not_discovered` | Parked pending stakeholder sign-off. |

## 5. Synthetic Fixtures (Excluded from Readiness)

| Fixture ID | Source | Schema | Checksum | Note |
| :--- | :---: | :---: | :--- | :--- |
| `placemakers_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `abercrombie_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `caroma_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `momentec_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `dragonshield_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |

---

*This report was generated automatically from the canonical filesystem packs. It is a dry-run evaluation only — not a production cutover approval.*
