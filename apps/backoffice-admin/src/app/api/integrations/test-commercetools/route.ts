/**
 * POST /api/integrations/test-commercetools — authenticated Activepieces test capability
 * invocation server-side.
 *
 * Rules:
 * 1. Derives tenant and environment strictly from authenticated server context (never trusts body).
 * 2. Invokes the same authenticated capability/ownership validator used by runtime.
 * 3. Fails closed on every Activepieces error / non-2xx.
 * 4. Deleted syntax-only ok:true fallback and global ACTIVEPIECES_API_KEY shortcut.
 */
import { NextResponse } from "next/server";
import { requireAuth, scopeTenant } from "../../../../lib/require-auth";
import { connectToDatabase } from "@journeyax/database";

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req, "config.edit");
    if (!auth.ok) {
      return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
    }

    const body = await req.json().catch(() => ({}));

    // Enforce architecture boundary: Browser must never transmit provider credentials or direct URLs
    if (
      body.clientSecret ||
      body.clientId ||
      body.apiUrl ||
      body.authUrl ||
      body.secret ||
      body.password ||
      body.apiKey
    ) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "Architecture boundary violation: Direct provider credentials (clientSecret/clientId/URLs) cannot be sent from the browser. Select an installed Activepieces connection reference instead.",
        },
        { status: 400 }
      );
    }

    // Derive tenantId and environmentId strictly from authenticated server context
    const tenantId = scopeTenant(auth.identity, body.projectId || body.tenantId);
    const environmentId = (body.environmentId || "production").trim();

    if (!tenantId) {
      return NextResponse.json({ ok: false, message: "Missing authenticated tenant context" }, { status: 400 });
    }

    const { connectionRef, flowId, pieceId = "@activepieces/piece-commercetools" } = body;
    if (!connectionRef || !String(connectionRef).trim()) {
      return NextResponse.json(
        { ok: false, message: "Please select an installed Activepieces connection reference (connectionRef)." },
        { status: 400 }
      );
    }

    const normConn = String(connectionRef).trim();

    // Validate ownership via same durable records path as runtime
    let isOwner = false;
    let tenantApiKey: string | null = null;

    if (process.env.MONGODB_URI) {
      const dbName = process.env.MONGODB_DB_NAME || "journeyx";
      const { db } = await connectToDatabase(process.env.MONGODB_URI, dbName);

      const connDoc = await db.collection("tenant_connections").findOne({
        tenantId,
        environmentId: { $in: [environmentId, "all"] },
        connectionRef: normConn,
      });

      if (connDoc) {
        isOwner = true;
      } else {
        const secretDoc = await db.collection("tenant_secrets").findOne({
          tenantId,
          environmentId: { $in: [environmentId, "all"] },
          $or: [{ secretRef: normConn }, { connectionRef: normConn }],
        });
        if (secretDoc) {
          isOwner = true;
        }
      }

      // Resolve tenant-scoped activepieces apiKey if configured
      const apKeyDoc = await db.collection("tenant_secrets").findOne({
        tenantId,
        secretRef: "activepieces_api_key",
      });
      if (apKeyDoc?.value) {
        tenantApiKey = apKeyDoc.value;
      }
    } else {
      // Dev/test environment check: must be explicitly scoped
      isOwner = normConn === `conn_ct_${tenantId}_dev` || normConn === `conn_ct_${tenantId}_secret`;
    }

    if (!isOwner) {
      return NextResponse.json(
        {
          ok: false,
          message: `Access denied: connectionRef '${normConn}' is not owned by tenant '${tenantId}' (${environmentId})`,
        },
        { status: 403 }
      );
    }

    // Invoke authenticated Activepieces test capability server-side
    const activepiecesUrl = (process.env.ACTIVEPIECES_API_URL || "http://localhost:3000").replace(/\/$/, "");
    const testEndpoint = `${activepiecesUrl}/api/v1/test-connection`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-connection-ref": normConn,
      "x-tenant-id": tenantId,
      "x-environment-id": environmentId,
    };

    if (tenantApiKey) {
      headers["Authorization"] = `Bearer ${tenantApiKey}`;
    }

    try {
      const apRes = await fetch(testEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tenantId,
          environmentId,
          connectionRef: normConn,
          pieceName: pieceId,
          flowId,
          test: true,
        }),
      });

      if (!apRes.ok) {
        const errorText = await apRes.text().catch(() => "");
        return NextResponse.json(
          {
            ok: false,
            message: `Activepieces capability test failed: HTTP ${apRes.status} ${errorText || apRes.statusText}`,
          },
          { status: apRes.status >= 400 && apRes.status < 600 ? apRes.status : 502 }
        );
      }

      const apData = await apRes.json().catch(() => ({}));
      return NextResponse.json({
        ok: true,
        message: `Connected via Activepieces connection '${normConn}'. Capability verified server-side.`,
        details: apData,
      });
    } catch (err: any) {
      // Fail closed on every Activepieces error / unavailable service
      return NextResponse.json(
        {
          ok: false,
          message: `Activepieces capability service unavailable: ${err.message || "Connection refused"}`,
        },
        { status: 503 }
      );
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: `Connection test error: ${e.message}` }, { status: 500 });
  }
}
