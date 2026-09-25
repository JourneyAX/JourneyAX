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
import { requireAuth, scopeTenant, isPlatformIdentity } from "../../../../lib/require-auth";
import { connectToDatabase } from "@journeyax/database";
import { can } from "@journeyax/shared-types";
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

    // Validate storage is configured first
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

    // Tenant admins remain strictly tenant-scoped unless they hold a dedicated platform identity
    // or active project membership in the requested project
    const isPlatform = isPlatformIdentity(auth.identity);
    const requested = body.projectId || body.tenantId;
    const targetProject = requested && typeof requested === 'string' && requested.trim() ? requested.trim() : auth.identity.tenantId;

    let tenantId = auth.identity.tenantId;
    if (isPlatform) {
      tenantId = targetProject;
    } else if (targetProject !== auth.identity.tenantId) {
      tenantId = targetProject;
    }

    if (!tenantId) {
      return NextResponse.json({ ok: false, message: "Missing authenticated tenant context" }, { status: 400 });
    }

    // Verify membership if not a dedicated platform identity
    let memberRole = auth.identity.role;
    if (!isPlatform) {
      const member = await db.collection('project_members').findOne({
        projectId: tenantId,
        email: auth.identity.email,
      });

      if (!member) {
        return NextResponse.json(
          { ok: false, message: `Access denied: user is not a member of project '${tenantId}'` },
          { status: 403 }
        );
      }

      // Require accepted/active/non-revoked membership lifecycle
      const memberStatus = (member.status || '').toLowerCase();
      if (
        !['active', 'accepted'].includes(memberStatus) ||
        ['pending', 'revoked', 'suspended', 'invited'].includes(memberStatus)
      ) {
        return NextResponse.json(
          { ok: false, message: `Access denied: membership for project '${tenantId}' is in '${memberStatus || 'inactive'}' state` },
          { status: 403 }
        );
      }

      // Require project-scoped permission for config.edit
      memberRole = member.role || auth.identity.role;
      if (!can(memberRole, 'config.edit')) {
        return NextResponse.json(
          { ok: false, message: `Access denied: role '${memberRole}' lacks required 'config.edit' permission to test connectors` },
          { status: 403 }
        );
      }
    }

    // Derive environment strictly from server-side project configuration (never trust caller body/query)
    const projectConfig =
      (await db.collection('tenant_configs').findOne({ projectId: tenantId })) ||
      (await db.collection('projects').findOne({ projectId: tenantId }));

    if (!projectConfig) {
      return NextResponse.json(
        { ok: false, message: `Project configuration not found for '${tenantId}'; failing closed.` },
        { status: 412 }
      );
    }

    const environmentId: "production" | "staging" | "dev" | "test" =
      projectConfig?.environment ||
      projectConfig?.defaultEnvironment ||
      (process.env.APP_ENV === "staging" ? "staging" : "production");

    const isProduction =
      process.env.NODE_ENV === "production" ||
      environmentId === "production";

    const { connectionRef, flowId } = body;
    if (!connectionRef || !String(connectionRef).trim()) {
      return NextResponse.json(
        { ok: false, message: "Please select an installed Activepieces connection reference (connectionRef)." },
        { status: 400 }
      );
    }
    const normConn = String(connectionRef).trim();

    // Do not accept or default arbitrary flowId: require explicit non-empty flowId
    if (!flowId || typeof flowId !== 'string' || !flowId.trim()) {
      return NextResponse.json(
        { ok: false, message: "A specific flowId must be provided; arbitrary or default flowId is not permitted." },
        { status: 400 }
      );
    }
    const normFlowId = flowId.trim();

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

    // Require the selected tenant_connection to match canonical commercetools piece
    const CANONICAL_COMMERCETOOLS_PIECES = new Set([
      '@activepieces/piece-commercetools',
      'commercetools',
      'piece-commercetools',
    ]);
    const actualPiece = (connDoc.pieceName || connDoc.provider || connDoc.pieceId || '').trim().toLowerCase();
    if (!CANONICAL_COMMERCETOOLS_PIECES.has(actualPiece)) {
      return NextResponse.json(
        {
          ok: false,
          message: `Connection '${normConn}' uses piece '${actualPiece}', which does not match canonical commercetools piece '@activepieces/piece-commercetools'`,
        },
        { status: 400 }
      );
    }

    // Require the selected tenant_connection to explicitly allow that flow
    if (!Array.isArray(connDoc.allowedFlows) || !connDoc.allowedFlows.includes(normFlowId)) {
      return NextResponse.json(
        {
          ok: false,
          message: `Flow '${normFlowId}' is not explicitly allowed for connection '${normConn}' (allowedFlows: ${connDoc.allowedFlows?.join(', ') || 'none'})`,
        },
        { status: 403 }
      );
    }

    // Resolve tenant-scoped activepieces API key — fail closed with NO global fallbacks
    const apKeyDoc = await db.collection("tenant_secrets").findOne({
      tenantId,
      environmentId: { $in: [environmentId, "all"] },
      secretRef: "activepieces_api_key",
    });
    if (!apKeyDoc?.value) {
      return NextResponse.json(
        {
          ok: false,
          message: `Activepieces API key is not configured for tenant '${tenantId}' in environment '${environmentId}'. Failing closed (no global fallback).`,
        },
        { status: 403 }
      );
    }
    const tenantApiKey = apKeyDoc.value;

    const apWebhookDoc = await db.collection("tenant_secrets").findOne({
      tenantId,
      environmentId: { $in: [environmentId, "all"] },
      secretRef: "activepieces_webhook_secret",
    });
    const tenantWebhookSecret = apWebhookDoc?.value || "";

    // Dispatch via shared CapabilityDispatcher with verified connection ownership
    const dispatcher = new CapabilityDispatcher({
      activepiecesApiUrl: activepiecesUrl,
      activepiecesApiKey: tenantApiKey,
      activepiecesWebhookSecret: tenantWebhookSecret,
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

    // Authoritative active business pack release pointer lookup strictly scoped to tenant and environment (NO cross-environment fallback)
    const releasePointer = await db.collection('business_pack_pointers').findOne({
      tenantId,
      $or: [{ channel: environmentId }, { environmentId }],
    });

    const targetVersion = releasePointer?.activeVersionId || releasePointer?.activeVersion;
    if (!targetVersion) {
      return NextResponse.json(
        { ok: false, message: `Active business pack release pointer not found for tenant '${tenantId}' (${environmentId}); failing closed.` },
        { status: 412 }
      );
    }

    // Require published/active immutable release scoped to tenant and environment with valid checksum
    const activeRelease = await db.collection('business_pack_releases').findOne({
      tenantId,
      environmentId: { $in: [environmentId, 'all'] },
      $or: [{ versionId: targetVersion }, { version: targetVersion }],
      status: { $in: ['published', 'active'] },
    });

    if (!activeRelease) {
      return NextResponse.json(
        { ok: false, message: `Published business pack release '${targetVersion}' not found for tenant '${tenantId}' (${environmentId}); failing closed.` },
        { status: 412 }
      );
    }

    const packChecksum = typeof activeRelease.checksum === 'string' ? activeRelease.checksum.trim() : '';
    if (!packChecksum) {
      return NextResponse.json(
        { ok: false, message: `Business pack release '${targetVersion}' lacks mandatory checksum; failing closed.` },
        { status: 412 }
      );
    }

    const packVersionId = activeRelease.versionId || activeRelease.version || targetVersion;

    // Resolve durable workspace record strictly scoped by tenantId and environmentId (no cross-environment leaks)
    const workspaceDoc = await db.collection('workspaces').findOne({
      tenantId,
      environmentId,
      ...(projectConfig.workspaceId ? { workspaceId: projectConfig.workspaceId } : {}),
    });

    if (!workspaceDoc) {
      return NextResponse.json(
        { ok: false, message: `Durable workspace record not found for tenant '${tenantId}' (${environmentId}); failing closed.` },
        { status: 412 }
      );
    }

    const stageId = workspaceDoc.currentStage || workspaceDoc.stageId;
    if (!stageId) {
      return NextResponse.json(
        { ok: false, message: `Durable workspace '${workspaceDoc.workspaceId}' lacks required currentStage; failing closed.` },
        { status: 412 }
      );
    }

    const toolDef: ToolDefinition = {
      toolId: "connector.health_check",
      version: packVersionId,
      displayName: "Connector Health Check",
      description: "Dedicated read-only connector health check",
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
      toolId: "connector.health_check",
      bindingVersion: packVersionId,
      executor: {
        type: "activepieces_flow",
        flowId: normFlowId,
        connectionRef: normConn,
      },
      enabled: true,
      policy: {
        requiredRole: memberRole || "admin",
        requiresConfirmation: false,
        idempotencyRequired: false,
        timeoutMs: 15000,
        retryAttempts: 0,
      },
    };

    // Trusted execution context strictly bound to the authenticated backoffice identity and project role
    const ctx: ExecutionContext = {
      workspaceId: workspaceDoc.workspaceId,
      tenantId,
      environmentId,
      sessionId: workspaceDoc.activeSessionId || `backoffice_test_${auth.identity.email}`,
      stageId,
      packVersionId,
      correlationId: `test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      principalRole: memberRole || "admin",
      principalId: auth.identity.email,
    };

    const result = await dispatcher.dispatch(
      toolDef,
      toolBinding,
      {
        toolId: "connector.health_check",
        input: { pieceName: "@activepieces/piece-commercetools", test: true },
        userConfirmationConfirmed: false,
      },
      ctx
    );

    // Accept only dispatcher status success
    if (result.status !== "success") {
      return NextResponse.json(
        {
          ok: false,
          message: `Activepieces capability test did not succeed (status: '${result.status}'): ${result.error || "Execution error"}`,
        },
        { status: result.status === 'requires_approval' || result.status === 'denied' ? 403 : 502 }
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
