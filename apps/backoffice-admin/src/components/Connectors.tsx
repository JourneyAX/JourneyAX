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
 */
import React, { useState } from "react";
import { Globe, Plug } from "lucide-react";

type ConnectorStatus = "live" | "coming-soon" | "not-built";

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
    blurb: "Knowledge/retrieval adapter is live (OAuth2 + real API calls). Commerce (cart/checkout) adapter isn't built yet.",
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
    blurb: "Adapter scaffolded, methods not yet implemented.",
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
};

const STATUS_PILL: Record<ConnectorStatus, string> = {
  live: "p-active",
  "coming-soon": "p-draft",
  "not-built": "p-offline",
};

const STATUS_NOTE: Record<Exclude<ConnectorStatus, "live">, string> = {
  "coming-soon": "Adapter in development.",
  "not-built": "Not yet available.",
};

export function Connectors({ onNavigate }: { onNavigate?: (tab: "integrations" | "channels") => void }) {
  const [note, setNote] = useState<string | null>(null);

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
        {CONNECTORS.map((c) => {
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
              {note === c.id && c.status !== "live" && (
                <span className="micro" style={{ color: "#8A6D00", textTransform: "none", letterSpacing: 0, fontFamily: "inherit", fontSize: 11.5 }}>
                  {STATUS_NOTE[c.status]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
