"use client";

/**
 * Notifications — Persistent per-project alert preferences and delivery channels.
 * Supports SendGrid email templates, webhooks with HMAC signatures, delivery audits, and retries.
 */
import React, { useEffect, useState } from "react";
import {
  Save,
  BellRing,
  Mail,
  Webhook,
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
} from "lucide-react";
import { projectApi, type Project } from "../lib/api";
import { authedFetch } from "../lib/authed-fetch";

const EVENTS: { id: string; label: string; desc: string; default: boolean }[] = [
  { id: "quoteBuilt", label: "Quote built", desc: "A customer completes a quote / bill of materials with the agent", default: true },
  { id: "orderPlaced", label: "Order placed", desc: "A journey reaches the ordered stage", default: true },
  { id: "journeyAbandoned", label: "Journey abandoned", desc: "A session with items goes quiet for 24h", default: true },
  { id: "highValue", label: "High-value quote", desc: "Quote total exceeds the project's alert threshold", default: true },
  { id: "ingestFinished", label: "Knowledge ingest finished", desc: "A corpus ingest completes or fails", default: false },
  { id: "configPublished", label: "Config published", desc: "Someone publishes a new config version", default: false },
  { id: "weeklyDigest", label: "Weekly digest", desc: "Sessions, funnel and quote summary every Monday", default: true },
];

export function NotificationsConfig({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Normalize existing notification settings (support boolean map or structured object)
  const existingNotifications = (project as any).notifications || {};
  const initialEvents = () => {
    if (existingNotifications.events) return existingNotifications.events;
    return Object.fromEntries(EVENTS.map((e) => [e.id, existingNotifications[e.id] ?? e.default]));
  };

  const [activeTab, setActiveTab] = useState<"events" | "sendgrid" | "webhook" | "audit">("events");
  const [events, setEvents] = useState<Record<string, boolean>>(initialEvents);

  const emailChannel = existingNotifications.channels?.email;
  const webhookChannel = existingNotifications.channels?.webhook;

  // SendGrid Channel State
  const [sendGridEnabled, setSendGridEnabled] = useState(
    Boolean(emailChannel?.enabled ?? false)
  );
  const [sendGridApiKey, setSendGridApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState(
    emailChannel?.fromEmail || "alerts@journeyax.com"
  );
  const [fromName, setFromName] = useState(
    emailChannel?.fromName || `${project.companyName || "JourneyAX"} Alerts`
  );
  const [emailRecipients, setEmailRecipients] = useState(
    (emailChannel?.defaultRecipients || []).join(", ")
  );
  const [templateIds, setTemplateIds] = useState<Record<string, string>>(
    emailChannel?.templateIds || {}
  );

  // Webhook Channel State
  const [webhookEnabled, setWebhookEnabled] = useState(
    Boolean(webhookChannel?.enabled ?? false)
  );
  const [webhookUrl, setWebhookUrl] = useState(
    webhookChannel?.url || ""
  );
  const [webhookSecret, setWebhookSecret] = useState("");

  // Audit Logs State
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Status & Testing State
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadAudit = React.useCallback(async () => {
    setLoadingAudit(true);
    try {
      const r = await authedFetch(`/api/notifications?tenantId=${encodeURIComponent(project.projectId)}`);
      const d = await r.json();
      if (r.ok && d.deliveries) {
        setDeliveries(d.deliveries);
      }
    } catch {
      // ignore
    } finally {
      setLoadingAudit(false);
    }
  }, [project.projectId]);

  useEffect(() => {
    if (activeTab === "audit") {
      loadAudit();
    }
  }, [activeTab, loadAudit]);

  const assembleConfig = () => {
    const recipientsList = emailRecipients
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    const emailCfg: any = {
      enabled: sendGridEnabled,
      provider: "sendgrid" as const,
      fromEmail,
      fromName,
      defaultRecipients: recipientsList,
      templateIds,
    };
    if (sendGridApiKey && sendGridApiKey.trim()) {
      emailCfg.apiKey = sendGridApiKey.trim();
    }
    if (emailChannel?.apiKeyRef) {
      emailCfg.apiKeyRef = emailChannel.apiKeyRef;
    }

    const webhookCfg: any = {
      enabled: webhookEnabled,
      url: webhookUrl,
    };
    if (webhookSecret && webhookSecret.trim()) {
      webhookCfg.secret = webhookSecret.trim();
    }
    if (webhookChannel?.secretRef) {
      webhookCfg.secretRef = webhookChannel.secretRef;
    }

    return {
      ...events,
      events,
      channels: {
        email: emailCfg,
        webhook: webhookCfg,
      },
    };
  };

  async function save() {
    setSaving(true);
    setStatusMessage(null);
    try {
      const payload = assembleConfig();
      await projectApi.update(project.projectId, { notifications: payload as any });
      setSendGridApiKey("");
      setWebhookSecret("");
      setSaved(true);
      onSaved();
      setStatusMessage({ type: "success", text: "Notification settings saved successfully." });
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setStatusMessage({ type: "error", text: e.message || "Failed to save notifications" });
    } finally {
      setSaving(false);
    }
  }

  async function sendTestNotification() {
    setTesting(true);
    setStatusMessage(null);
    try {
      // Production security: Never pass raw secret tokens in the test dispatch request.
      // The server resolves tenant credentials securely from encrypted tenant configuration.
      const r = await authedFetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: project.projectId,
          eventId: "highValue",
          payload: {
            quoteId: "Q-TEST-8891",
            totalCents: 125000,
            currency: "AUD",
            summary: "High-value quote generated for customer review",
            operatorUrl: `https://${project.domain || "app.journeyax.com"}/orders`,
          },
        }),
      });

      const d = await r.json();
      if (!r.ok) throw new Error(d.error || d.message || "Failed to dispatch test notification");

      setStatusMessage({
        type: "success",
        text: `Test notification sent (${d.deliveries?.length || 0} delivery attempts recorded).`,
      });
      if (activeTab === "audit") {
        await loadAudit();
      }
    } catch (err: any) {
      setStatusMessage({ type: "error", text: err.message || "Test notification failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="ctop">
        <div>
          <h1 className="pageh">Notifications &amp; Alerts</h1>
          <p className="pagesub">
            Configure event alert triggers, SendGrid email delivery, webhooks, and audit logs for <b>{project.companyName}</b>.
          </p>
        </div>
        <div className="actions" style={{ display: "flex", gap: "8px" }}>
          <button className="btn" onClick={sendTestNotification} disabled={testing || saving}>
            <Send size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {testing ? "Sending Test…" : "Send Test Alert"}
          </button>
          <button className="btn y" onClick={save} disabled={saving}>
            <Save size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save Changes"}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          className="panel"
          style={{
            borderColor: statusMessage.type === "success" ? "var(--jx-success)" : "var(--jx-destructive)",
            color: statusMessage.type === "success" ? "var(--jx-success)" : "var(--jx-destructive)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "16px",
          }}
        >
          {statusMessage.type === "success" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {statusMessage.text}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", borderBottom: "1px solid var(--jx-gray-200)", paddingBottom: "8px" }}>
        <button
          className={`btn ${activeTab === "events" ? "y" : ""}`}
          onClick={() => setActiveTab("events")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <BellRing size={13} />
          Event Alerts
        </button>
        <button
          className={`btn ${activeTab === "sendgrid" ? "y" : ""}`}
          onClick={() => setActiveTab("sendgrid")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <Mail size={13} />
          SendGrid Email
        </button>
        <button
          className={`btn ${activeTab === "webhook" ? "y" : ""}`}
          onClick={() => setActiveTab("webhook")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <Webhook size={13} />
          Webhooks
        </button>
        <button
          className={`btn ${activeTab === "audit" ? "y" : ""}`}
          onClick={() => setActiveTab("audit")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <Clock size={13} />
          Delivery Audits
        </button>
      </div>

      {/* ── Event Alerts Tab ─────────────────────────────────────────────────── */}
      {activeTab === "events" && (
        <div className="panel">
          <div className="micro">
            <BellRing size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />
            EVENT ALERT TRIGGERS
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: "8px" }}>
            {EVENTS.map((e) => (
              <div key={e.id} className="between" style={{ padding: "12px 6px", borderBottom: "1px solid var(--jx-gray-200)" }}>
                <div>
                  <b style={{ fontSize: 13 }}>{e.label}</b>
                  <div className="role" style={{ fontSize: 12 }}>{e.desc}</div>
                </div>
                <div
                  className={`switch ${events[e.id] ? "on" : ""}`}
                  onClick={() => setEvents((p) => ({ ...p, [e.id]: !p[e.id] }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SendGrid Email Tab ──────────────────────────────────────────────── */}
      {activeTab === "sendgrid" && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <b style={{ fontSize: 14 }}>SendGrid Delivery Channel</b>
              <div className="role" style={{ fontSize: 12 }}>
                Deliver automated email notifications to operations and sales teams via SendGrid.
              </div>
            </div>
            <div
              className={`switch ${sendGridEnabled ? "on" : ""}`}
              onClick={() => setSendGridEnabled(!sendGridEnabled)}
            />
          </div>

          {sendGridEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "16px", borderTop: "1px solid var(--jx-gray-200)", paddingTop: "16px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  SendGrid API Key
                </label>
                <input
                  type="password"
                  placeholder={
                    emailChannel?.apiKeyConfigured
                      ? `${emailChannel.apiKeyHint || "••••••••"} (Stored securely in Vault)`
                      : "SG.xxxxxxxxxxxxxxxx"
                  }
                  value={sendGridApiKey}
                  onChange={(e) => setSendGridApiKey(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "13px",
                  }}
                />
                <span style={{ fontSize: "11px", color: "var(--jx-gray-500)", display: "block", marginTop: "4px" }}>
                  {emailChannel?.apiKeyConfigured ? (
                    <span style={{ color: "var(--jx-success, #16a34a)" }}>
                      ✓ Secret Reference: <code>{emailChannel.apiKeyRef || `vault://tenants/${project.projectId}/sendgrid-api-key`}</code>. Enter a new key only to rotate credentials.
                    </span>
                  ) : (
                    <span>
                      Credentials stored per-tenant via vault reference <code>vault://tenants/{project.projectId}/sendgrid-api-key</code>.
                    </span>
                  )}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                    From Email
                  </label>
                  <input
                    type="email"
                    placeholder="alerts@yourdomain.com"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid var(--jx-gray-300)",
                      fontSize: "13px",
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                    From Name
                  </label>
                  <input
                    type="text"
                    placeholder="Caroma Order Desk"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      border: "1px solid var(--jx-gray-300)",
                      fontSize: "13px",
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Default Recipients (comma-separated)
                </label>
                <input
                  type="text"
                  placeholder="orders@company.com, alerts@company.com"
                  value={emailRecipients}
                  onChange={(e) => setEmailRecipients(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "13px",
                  }}
                />
              </div>

              <div>
                <b style={{ fontSize: "13px", display: "block", marginBottom: "8px" }}>
                  SendGrid Dynamic Template ID Overrides (Optional)
                </b>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  {EVENTS.slice(0, 4).map((ev) => (
                    <div key={ev.id}>
                      <label style={{ display: "block", fontSize: "11px", color: "var(--jx-gray-600)", marginBottom: "3px" }}>
                        {ev.label} Template ID
                      </label>
                      <input
                        type="text"
                        placeholder="d-xxxxxxxxxxxxxxxxxxxxxxxx"
                        value={templateIds[ev.id] || ""}
                        onChange={(e) =>
                          setTemplateIds((prev) => ({ ...prev, [ev.id]: e.target.value }))
                        }
                        style={{
                          width: "100%",
                          padding: "6px 10px",
                          borderRadius: "6px",
                          border: "1px solid var(--jx-gray-300)",
                          fontSize: "12px",
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Webhooks Tab ────────────────────────────────────────────────────── */}
      {activeTab === "webhook" && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <b style={{ fontSize: 14 }}>Webhook Delivery Channel</b>
              <div className="role" style={{ fontSize: 12 }}>
                Push real-time signed JSON payloads to your CRM, ERP, Slack, or Zapier endpoint.
              </div>
            </div>
            <div
              className={`switch ${webhookEnabled ? "on" : ""}`}
              onClick={() => setWebhookEnabled(!webhookEnabled)}
            />
          </div>

          {webhookEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "16px", borderTop: "1px solid var(--jx-gray-200)", paddingTop: "16px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Webhook Target URL
                </label>
                <input
                  type="url"
                  placeholder="https://api.yourcompany.com/webhooks/journeyax"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "13px",
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Signing Secret (HMAC-SHA256)
                </label>
                <input
                  type="password"
                  placeholder={
                    webhookChannel?.secretConfigured
                      ? `${webhookChannel.secretHint || "••••••••"} (Stored securely in Vault)`
                      : "whsec_xxxxxxxxxxxxxxxxxxxxxxxx"
                  }
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--jx-gray-300)",
                    fontSize: "13px",
                  }}
                />
                <span style={{ fontSize: "11px", color: "var(--jx-gray-500)", display: "block", marginTop: "4px" }}>
                  {webhookChannel?.secretConfigured ? (
                    <span style={{ color: "var(--jx-success, #16a34a)" }}>
                      ✓ Secret Reference: <code>{webhookChannel.secretRef || `vault://tenants/${project.projectId}/webhook-secret`}</code>. Verified via <code>x-journeyax-signature</code>.
                    </span>
                  ) : (
                    <span>
                      Secret stored per-tenant via vault reference <code>vault://tenants/{project.projectId}/webhook-secret</code>.
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Delivery Audits Tab ──────────────────────────────────────────────── */}
      {activeTab === "audit" && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div className="micro">RECENT DELIVERY ATTEMPTS</div>
            <button className="btn" onClick={loadAudit} disabled={loadingAudit}>
              <RefreshCw size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
              {loadingAudit ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div className="tblwrap">
            <div className="theadr" style={{ gridTemplateColumns: "1.4fr 1.2fr 0.8fr 2fr 0.8fr" }}>
              <span>Timestamp</span>
              <span>Event</span>
              <span>Channel</span>
              <span>Recipient / Target</span>
              <span>Status</span>
            </div>

            {deliveries.map((del) => (
              <div key={del.deliveryId || del._id} className="trow" style={{ gridTemplateColumns: "1.4fr 1.2fr 0.8fr 2fr 0.8fr", alignItems: "center" }}>
                <span className="role">{del.createdAt ? new Date(del.createdAt).toLocaleString() : "—"}</span>
                <b>{del.eventId}</b>
                <span style={{ textTransform: "uppercase", fontSize: "11px", fontWeight: 600 }}>{del.channel}</span>
                <span className="role" style={{ wordBreak: "break-all" }}>{del.recipient}</span>
                <div>
                  <span
                    className={`pill ${
                      del.status === "delivered" ? "p-active" : del.status === "retrying" ? "p-warning" : "p-offline"
                    }`}
                  >
                    {del.status}
                  </span>
                </div>
              </div>
            ))}

            {deliveries.length === 0 && !loadingAudit && (
              <div style={{ padding: "24px", textAlign: "center", color: "var(--jx-gray-500)" }}>
                No delivery attempts recorded yet. Use &ldquo;Send Test Alert&rdquo; above to verify your channels.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
