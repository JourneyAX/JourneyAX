/**
 * POST /api/integrations/test-commercetools — authenticated Activepieces test capability
 * invocation server-side.
 *
 * Rules:
 * 1. Derives tenant and environment strictly from authenticated server context (never trusts body).
 * 2. Never falls back to arbitrary tenant_secrets for connectionRef ownership.
 * 3. Never omits environment when resolving credentials/auth.
 * 4. Never defaults to localhost in production; fails closed if external URL is missing.
 * 5. Uses shared CapabilityDispatcher with signing, connection ownership, and idempotency.
 */
import { NextResponse } from "next/server";
import { requireAuth, scopeTenant } from "../../../../lib/require-auth";
import { connectToDatabase } from "@journeyax/database";
import {
  CapabilityDispatcher,
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
} from "@journeyax/capability-sdk";

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

    // Derive tenantId strictly from authenticated server identity (never trust unauthenticated caller)
    const tenantId = scopeTenant(auth.identity, body.projectId || body.tenantId);
    if (!tenantId) {
      return NextResponse.json({ ok: false, message: "Missing authenticated tenant context" }, { status: 400 });
    }

    // Derive environment strictly: validate against allowed enum and prevent unverified body override
    const rawEnv = typeof body.environmentId === "string" ? body.environmentId.trim() : "";
    const validEnvironments = ["production", "staging", "dev", "test"] as const;
    const environmentId: "production" | "staging" | "dev" | "test" = validEnvironments.includes(
      rawEnv as any
    )
      ? (rawEnv as any)
      : process.env.APP_ENV === "staging"
      ? "staging"
      : "production";

    const isProduction =
      process.env.NODE_ENV === "production" ||
      environmentId === "production";

    const { connectionRef, flowId, pieceId = "@activepieces/piece-commercetools" } = body;
    if (!connectionRef || !String(connectionRef).trim()) {
      return NextResponse.json(
        { ok: false, message: "Please select an installed Activepieces connection reference (connectionRef)." },
        { status: 400 }
      );
    }

    const normConn = String(connectionRef).trim();

    // Activepieces base URL validation: Never default to localhost in production
    const activepiecesUrl = process.env.ACTIVEPIECES_API_URL ? process.env.ACTIVEPIECES_API_URL.trim() : "";
    if (isProduction && (!activepiecesUrl || activepiecesUrl.includes("localhost") || activepiecesUrl.includes("127.0.0.1"))) {
      return NextResponse.json(
        {
          ok: false,
          message: "Configuration error: Explicit external ACTIVEPIECES_API_URL is required in production; localhost is forbidden.",
        },
        { status: 500 }
      );
    }

    if (!activepiecesUrl) {
      return NextResponse.json(
        {
          ok: false,
          message: "Configuration error: Missing required ACTIVEPIECES_API_URL; failing closed.",
        },
        { status: 500 }
      );
    }

    // Validate ownership strictly against tenant_connections (no fallback to arbitrary tenant_secrets)
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      return NextResponse.json(
        {
          ok: false,
          message: "Durable storage unconfigured: MONGODB_URI is required to verify connection ownership",
        },
        { status: 503 }
      );
    }

    const dbName = process.env.MONGODB_DB_NAME || "journeyx";
    const { db } = await connectToDatabase(mongoUri, dbName);

    const connDoc = await db.collection("tenant_connections").findOne({
      tenantId,
      environmentId: { $in: [environmentId, "all"] },
      connectionRef: normConn,
    });

    if (!connDoc) {
      return NextResponse.json(
        {
          ok: false,
          message: `Access denied: connectionRef '${normConn}' is not registered to tenant '${tenantId}' (${environmentId})`,
        },
        { status: 403 }
      );
    }

    if (connDoc.status === "revoked" || connDoc.status === "inactive" || connDoc.enabled === false) {
      return NextResponse.json(
        {
          ok: false,
          message: `Access denied: connectionRef '${normConn}' is in '${connDoc.status || "disabled"}' state`,
        },
        { status: 403 }
      );
    }

    // Resolve tenant-scoped activepieces API key and webhook secret with environment scope
    let tenantApiKey: string | null = null;
    let tenantWebhookSecret: string | null = null;

    const apKeyDoc = await db.collection("tenant_secrets").findOne({
      tenantId,
      environmentId: { $in: [environmentId, "all"] },
      secretRef: "activepieces_api_key",
    });
    if (apKeyDoc?.value) {
      tenantApiKey = apKeyDoc.value;
    }

    const apWebhookDoc = await db.collection("tenant_secrets").findOne({
      tenantId,
      environmentId: { $in: [environmentId, "all"] },
      secretRef: "activepieces_webhook_secret",
    });
    if (apWebhookDoc?.value) {
      tenantWebhookSecret = apWebhookDoc.value;
    }

    // Dispatch via shared CapabilityDispatcher with full ownership, signing, and idempotency
    const dispatcher = new CapabilityDispatcher({
      activepiecesApiUrl: activepiecesUrl,
      activepiecesApiKey: tenantApiKey || process.env.ACTIVEPIECES_API_KEY,
      activepiecesWebhookSecret: tenantWebhookSecret || process.env.ACTIVEPIECES_WEBHOOK_SECRET,
      validateConnectionOwnership: async (tId, envId, cRef) => {
        const found = await db.collection("tenant_connections").findOne({
          tenantId: tId,
          environmentId: { $in: [envId, "all"] },
          connectionRef: cRef,
          status: { $nin: ["revoked", "inactive"] },
          enabled: { $ne: false },
        });
        return Boolean(found);
      },
    });

    const toolDef: ToolDefinition = {
      toolId: "commercetools.test_connection",
      version: "1.0.0",
      displayName: "Test Connection",
      description: "Server-side test connection via Activepieces",
      inputSchema: {},
      outputSchema: {},
      sideEffect: "read",
      risk: "low",
      timeoutPolicy: { timeoutMs: 15000, retryAttempts: 0 },
      idempotencyPolicy: { required: false, ttlSeconds: 60 },
      approvalPolicy: { requiresApproval: false, ttlMinutes: 10 },
      dataClassification: "internal",
    };

    const toolBinding: ToolBinding = {
      tenantId,
      environmentId,
      toolId: "commercetools.test_connection",
      bindingVersion: "1.0.0",
      executor: {
        type: "activepieces_flow",
        flowId: flowId || "ap_flow_test_connection",
        connectionRef: normConn,
      },
      enabled: true,
      policy: {
        requiredRole: "admin",
        requiresConfirmation: false,
        idempotencyRequired: false,
        timeoutMs: 15000,
        retryAttempts: 0,
      },
    };

    const ctx: ExecutionContext = {
      workspaceId: `ws_${tenantId}`,
      tenantId,
      environmentId,
      sessionId: `sess_test_${Date.now()}`,
      stageId: "stage_test",
      packVersionId: "active",
      correlationId: `test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      principalRole: "admin",
    };

    const result = await dispatcher.dispatch(
      toolDef,
      toolBinding,
      { toolId: "commercetools.test_connection", input: { pieceName: pieceId, test: true } },
      ctx
    );

    if (result.status === "failure") {
      return NextResponse.json(
        {
          ok: false,
          message: `Activepieces capability test failed: ${result.error || "Unknown execution error"}`,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: `Connected via Activepieces connection '${normConn}'. Capability verified server-side.`,
      details: result.output,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: `Connection test error: ${e.message}` }, { status: 500 });
  }
}
