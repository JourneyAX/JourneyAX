# PlaceMakers Live Rollback Note (T0)

> [!IMPORTANT]
> This document records the pre-agent production baseline state for the live **PlaceMakers** project and defines the exact back-office rollback procedure to revert to this baseline if required.

---

## 1. Active Production Baseline State

| Component | Identifier / Version | Details |
|---|---|---|
| **Tenant ID** | `placemakers` | Live PlaceMakers production tenant |
| **Environment** | `production` | Live production environment |
| **Active Business Pack** | `1.3.17` | Checksum: `2a1a26e60501d7cd91601e31d70b945b7eb08e87bc34b4f4aff3ffcd0ef36553` |
| **Pointer Revision** | `37` | Active pointer record in `business_pack_pointers` collection |
| **Published Timestamp** | `2026-10-13T19:27:25.066Z` | Promoted by `process:claude-code` |
| **Active OKF Release** | `okf-placemakers-production-1.7.0` | Version `1.7.0`, Checksum: `4b0e1c8d619cd952d914ea2bcceb2d2a34e08b6408eb939cce3453754865d7a7` |
| **Engine Mode** | `rule-based` | Legacy rule-based engine (agent mode disabled) |

---

## 2. Step-by-Step Back-Office Rollback Procedure

In the event of an operational anomaly, unintended conversational behavior, or degradation during agent mode execution, follow either of the verified rollback methods below:

### Method A: Via Backoffice Admin Web UI (Recommended)

1. **Access Backoffice Admin**:
   - Open browser and navigate to the admin portal: `http://localhost:3009` (or production portal URL).
2. **Select PlaceMakers Project**:
   - Navigate to `/projects/placemakers`.
3. **Open Version History**:
   - Click the **"Version history & rollback"** button in the header `PublishControl` panel.
4. **Locate Baseline Release**:
   - Find version **`1.3.17`** (Revision 37, published 2026-10-13).
5. **Execute Rollback**:
   - Click the **"Rollback"** button adjacent to version `1.3.17`.
   - Confirm the confirmation dialog.
6. **Automatic Cutover**:
   - The UI dispatches `POST /api/v1/projects/placemakers/rollback/1.3.17` to the project service.
   - The atomic pointer in MongoDB (`business_pack_pointers`) is CAS-updated to point back to release `1.3.17`.
   - The runtime outbox worker and `BusinessPackLoader.invalidateAll('placemakers', 'production')` invalidate cached releases across all runtime nodes immediately.

---

### Method B: Emergency API / CLI Execution

If the Backoffice Admin web portal is inaccessible, execute the rollback directly against the API gateway or database:

#### Option 1: Direct Service API Call
```bash
curl -X POST http://localhost:3011/api/v1/projects/placemakers/rollback/1.3.17 \
  -H "Content-Type: application/json" \
  -H "X-User-Role: platform_admin" \
  -H "Authorization: Bearer ${ADMIN_JWT}"
```

#### Option 2: Programmatic Pack Rollback Script
Run using the canonical `@journeyax/business-pack` publisher:
```bash
node -e '
const { MongoClient } = require("mongodb");
const { rollbackBusinessPack } = require("./packages/business-pack");
require("dotenv").config({ path: ".env" });

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "journeyx");
  const res = await rollbackBusinessPack(db, "placemakers", "production", {
    targetVersion: "1.3.17",
    rolledBackBy: "operator:emergency",
  });
  console.log("Rollback completed successfully:", res);
  await client.close();
}
run().catch(console.error);
'
```

---

## 3. Post-Rollback Verification Checklist

After performing a rollback to `1.3.17`, verify the following indicators:

1. **Query Runtime Engine Mode Endpoint**:
   ```bash
   curl http://localhost:3012/api/v1/runtime/engine-mode/placemakers?environmentId=production
   ```
   **Expected Response**:
   ```json
   {
     "status": "ok",
     "tenantId": "placemakers",
     "environmentId": "production",
     "engineMode": "rule-based",
     "packVersion": "1.3.17"
   }
   ```

2. **Verify Runtime Startup & Cache Invalidation Log**:
   Runtime console output will log:
   ```
   [BusinessPackLoader] Loaded active release: source=database tenant='placemakers' env='production' version='1.3.17' checksum='2a1a26e60501d7cd...' engineMode='rule-based'
   [EngineStatus] Active engine mode for tenant='placemakers' (production): mode='rule-based'
   ```

3. **Verify Web Chat**:
   Send a message in the storefront chat (`http://localhost:3008/placemakers`). With `NEXT_PUBLIC_DEBUG_ENGINE=true`, the debug badge displays `Engine: rule-based | Pack: 1.3.17`.
