/**
 * POST /api/integrations/test-commercetools — live connection check for the
 * Integrations editor. Does the real OAuth2 client-credentials handshake and a
 * 1-item product query so "Connected" means CONNECTED (unlike the old static board).
 * Credentials come from the request (the form being edited); nothing is stored here.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/require-auth";

export async function POST(req: Request) {
  try {
    // Exercising connector credentials is an integration-config action.
    const auth = await requireAuth(req, "config.edit");
    if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
    const { projectKey, clientId, clientSecret, apiUrl, authUrl } = await req.json();
    if (!projectKey || !clientId || !clientSecret || !apiUrl || !authUrl) {
      return NextResponse.json({ ok: false, message: "Fill in projectKey, clientId, clientSecret, apiUrl and authUrl first." }, { status: 400 });
    }

    // 1) OAuth2 client-credentials
    const tokenRes = await fetch(`${String(authUrl).replace(/\/$/, "")}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&scope=view_products:${projectKey}`,
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      return NextResponse.json({ ok: false, message: `Auth failed (HTTP ${tokenRes.status}) — check clientId/secret, projectKey and that the API client has the view_products scope. ${body.slice(0, 140)}` }, { status: 200 });
    }
    const { access_token } = await tokenRes.json();

    // 2) 1-item product query proves API URL + project access
    const prodRes = await fetch(`${String(apiUrl).replace(/\/$/, "")}/${projectKey}/product-projections?limit=1&staged=false`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!prodRes.ok) {
      return NextResponse.json({ ok: false, message: `Auth OK but product query failed (HTTP ${prodRes.status}) — check the API URL region and project key.` }, { status: 200 });
    }
    const data = await prodRes.json();
    return NextResponse.json({
      ok: true,
      message: `Connected — project "${projectKey}" reachable, ${data.total ?? 0} product(s) in catalogue.`,
      total: data.total ?? 0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: `Connection error: ${e.message}` }, { status: 200 });
  }
}
