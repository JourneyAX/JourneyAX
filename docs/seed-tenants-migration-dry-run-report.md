# JourneyAX — Canonical Pack Dry-Run Evaluation Report

**Generated At**: `2026-09-28T03:48:58.091Z`

**Branch / Commit**: `JourneyAX-dev-v4` / `0101e1311764e4c2e8c4ff6a79a3a5fa8299e599`

**Portfolio Manifest Version**: `1.0.0`

**Evaluation Mode**: Offline Filesystem Dry-Run — schema compilation and canonical conformance.

**Active Portfolio**: placemakers, workweargroup, abercrombie, caroma

**Parked (excluded)**: royalcyber, caroma-nz, momentec, garts, dragonshield

> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack schema compilation and semantic integrity. It does **not** grant cutover approval. Production routing strictly requires an approved, signed `DurableCutoverRecord` in `tenant_cutovers`.

---

## 1. Executive Summary

| Category | Count |
| :--- | :---: |
| Active portfolio tenants | 4 |
| Dry-run passed (schema + semantic valid) | 2 |
| Requires remediation | 2 |
| Parked tenants (excluded) | 1 |
| Synthetic fixtures (excluded) | 0 |

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

| Tenant ID | Reason |
| :--- | :--- |
| `royalcyber` | Parked pending business prioritisation. Do not count as active blocker. |

## 5. Synthetic Fixtures (Excluded from Readiness)

No synthetic fixtures found.

---

*This report was generated automatically from the canonical filesystem packs. It is a dry-run evaluation only — not a production cutover approval.*
