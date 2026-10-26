"use client";

/**
 * Connectors gallery — the visual front door for platform adapters & channels.
 *
 * Logo-card grid (ChatGPT connector-picker style) sitting above the existing
 * platform-dropdown form in IntegrationsConfig. Purely a nicer way to see and
 * jump to what's already configurable there (+ Channels for WhatsApp/Web) —
 * it does not introduce new save/config logic of its own.
 *
 * Status badges are ground truth, not vibes — checked against the adapters in
 * packages/integration/src/adapters/ on 2026-08-24:
 *   - standalone (commerce + knowledge): fully wired            → Live
 *   - commercetools (knowledge): real OAuth2 + live API calls   → Live (knowledge adapter)
 *   - commercetools (commerce): NO commerce adapter file exists → not claimed as live
 *   - shopify (commerce): adapter file exists but every method throws
 *     "not implemented" (explicit "skeleton" stub)              → Coming soon
 *   - salesforce (crm): same situation, stub adapter             → Coming soon
 *   - woocommerce: no adapter code anywhere, only a config type  → Not yet built
 *   - whatsapp (channel): real Cloud API config, saves to
 *     project.channels.whatsapp / integrations.whatsapp          → Live
 *   - web storefront (channel): always-on, no config             → Live
 *
 * Never upgrade a badge below without re-verifying the adapter file itself.
 *
 * Updated 2026-10-26: the cards above are the PLATFORM'S OWN adapters. The assistant also reaches some systems directly, through its own
 * connected-systems list (project extensions.connectors: Salesforce, commercetools, the ticket desk...), which is a different thing and is
 * live for Salesforce and commercetools. A card whose system the assistant reaches says so, read from the project, and the section under
 * the grid lists every connected system with its switch. That list is edited on the storefront's Customize page (Connectors tab).
 */
import React, { useState } from "react";
import { Globe, Plug } from "lucide-react";
import type { Project } from "../lib/api";
import { ASSISTANT_SYSTEM_OF_CARD, describeAssistantSystem, readAssistantSystems } from "../lib/assistantSystems";

type ConnectorStatus = "live" | "coming-soon" | "not-built" | "assistant";

type Connector = {
  id: string;
  name: string;
  category: "Commerce" | "CRM" | "ERP" | "Channel";
  status: ConnectorStatus;
  logo?: string; // path under /assets/connectors, omit to use an inline lucide icon
  blurb: string;
  /** activeTab id to jump to when the card is clickable (status === 'live') */
  navTarget?: "integrations" | "channels";
};

const CONNECTORS: Connector[] = [
  {
    id: "standalone",
    name: "JourneyAX (internal)",
    category: "Commerce",
    status: "live",
    blurb: "Own catalogue, orders & cart — the default backend.",
    navTarget: "integrations",
  },
  {
    id: "commercetools",
    name: "commercetools",
    category: "Commerce",
    status: "live",
    logo: "/assets/connectors/commercetools.svg",
    blurb: "Knowledge/retrieval adapter is live (OAuth2 + real API calls). The platform has no commerce (cart/checkout) adapter for it; the assistant reaches commercetools directly instead (see below).",
    navTarget: "integrations",
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "Commerce",
    status: "coming-soon",
    logo: "/assets/connectors/shopify.svg",
    blurb: "Adapter scaffolded, methods not yet implemented.",
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    category: "Commerce",
    status: "not-built",
    logo: "/assets/connectors/woocommerce.svg",
    blurb: "No adapter exists yet — config type only.",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    category: "CRM",
    status: "coming-soon",
    logo: "/assets/connectors/salesforce.svg",
    blurb: "The platform's own CRM adapter is scaffolded, methods not yet implemented. The assistant's direct Salesforce connection (accounts, cases, deals, campaigns) is separate: see below.",
  },
  {
    id: "sap",
    name: "SAP",
    category: "ERP",
    status: "not-built",
    logo: "/assets/connectors/sap.svg",
    blurb: "Generic ERP representative — no adapter exists yet.",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    category: "Channel",
    status: "live",
    logo: "/assets/connectors/whatsapp.svg",
    blurb: "Cloud API channel — phone/WABA/token configured per workspace.",
    navTarget: "channels",
  },
  {
    id: "web",
    name: "Web storefront",
    category: "Channel",
    status: "live",
    blurb: "Always-on embedded journey chat — no config needed.",
    navTarget: "channels",
  },
];

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  live: "Live",
  "coming-soon": "Coming soon",
  "not-built": "Not yet built",
  assistant: "Live for the assistant",
};

const STATUS_PILL: Record<ConnectorStatus, string> = {
  live: "p-active",
  "coming-soon": "p-draft",
  "not-built": "p-offline",
  assistant: "p-active",
};

const STATUS_NOTE: Record<Exclude<ConnectorStatus, "live">, string> = {
  "coming-soon": "Adapter in development.",
  "not-built": "Not yet available.",
  assistant: "The platform's own adapter is not built; the assistant reaches this system directly.",
};

export function Connectors({ onNavigate, project }: { onNavigate?: (tab: "integrations" | "channels") => void; project?: Project | null }) {
  const [note, setNote] = useState<string | null>(null);
  const assistant = readAssistantSystems(project);
  const assistantOf = (cardId: string) => assistant.find((system) => system.id === ASSISTANT_SYSTEM_OF_CARD[cardId]);
  // A card the platform has no adapter for, but whose system the assistant reaches (and has switched on), is live for the assistant.
  const statusOf = (c: Connector): ConnectorStatus => (c.status !== "live" && assistantOf(c.id)?.enabled ? "assistant" : c.status);

  function onCardClick(c: Connector) {
    if (c.status === "live") {
      if (c.navTarget && onNavigate) onNavigate(c.navTarget);
      setNote(null);
      return;
    }
    setNote(c.id);
  }

  return (
    <div className="panel">
      <div className="between">
        <h4><Plug size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Connectors</h4>
        <span className="micro" style={{ color: "var(--jx-gray-500)" }}>{CONNECTORS.length} platforms</span>
      </div>
      <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "0 0 4px", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 12 }}>
        Every backend & channel JourneyAX can plug into. Live cards jump to their config below — everything else is
        exactly what it says on the badge.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
          gap: 12,
        }}
      >
        {CONNECTORS.map((card) => {
          const c = { ...card, status: statusOf(card) };
          const clickable = c.status === "live" && !!c.navTarget;
          return (
            <div
              key={c.id}
              onClick={() => onCardClick(c)}
              style={{
                border: "1.5px solid var(--jx-gray-200)",
                borderRadius: 12,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                cursor: clickable || c.status !== "live" ? "pointer" : "default",
                background: "#fff",
                transition: "border-color 0.15s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--jx-gray-400)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--jx-gray-200)")}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: c.logo ? "#fff" : "var(--jx-black)",
                    border: c.logo ? "1px solid var(--jx-gray-200)" : "none",
                    flexShrink: 0,
                  }}
                >
                  {c.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.logo} alt={`${c.name} logo`} width={36} height={36} style={{ display: "block" }} />
                  ) : (
                    <Globe size={18} color="#fff" />
                  )}
                </div>
                <span className={`pill ${STATUS_PILL[c.status]}`}>{STATUS_LABEL[c.status]}</span>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</div>
                <div className="micro" style={{ color: "var(--jx-gray-500)", margin: "2px 0 0", textTransform: "none", letterSpacing: 0, fontFamily: "inherit" }}>
                  {c.category}
                </div>
              </div>
              <p className="micro" style={{ color: "var(--jx-gray-600)", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 11.5, lineHeight: 1.4, margin: 0 }}>
                {c.blurb}
              </p>
              {ASSISTANT_SYSTEM_OF_CARD[c.id] && project && (
                <span className="micro" style={{ color: "var(--jx-gray-600)", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 11.5 }}>
                  {describeAssistantSystem(assistantOf(c.id))}
                </span>
              )}
              {note === c.id && c.status !== "live" && (
                <span className="micro" style={{ color: "#8A6D00", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 11.5 }}>
                  {STATUS_NOTE[c.status]}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <h4 style={{ margin: "18px 0 4px" }}>Systems your assistant reaches</h4>
      <p className="micro" style={{ color: "var(--jx-gray-600)", margin: "0 0 8px", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 12 }}>
        What the assistant can look things up in (and, with a person&apos;s yes, change), as saved in this project. Who may do what with each tool is set on the
        storefront&apos;s Customize page, under Connectors; changes reach customers after Publish.
      </p>
      {assistant.length === 0 ? (
        <p className="micro" style={{ color: "var(--jx-gray-600)", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 12 }}>
          This project&apos;s configuration lists no connected systems.
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
          {assistant.map((system) => (
            <div key={system.id} style={{ border: "1.5px solid var(--jx-gray-200)", borderRadius: 10, padding: 10, background: "#fff", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{system.name}</strong>
                <span className={`pill ${system.enabled ? "p-active" : "p-offline"}`}>{system.enabled ? "On" : "Switched off"}</span>
              </div>
              <span className="micro" style={{ color: "var(--jx-gray-600)", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 11.5 }}>
                {system.sample ? "Sample data" : "Real data"} · {system.tools} tool{system.tools === 1 ? "" : "s"}{system.writes ? ` · ${system.writes} change data` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
