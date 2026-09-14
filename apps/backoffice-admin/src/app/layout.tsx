import type { Metadata } from "next";
import "./globals.css";
// Card CMS (v3) base styles for the Cards & Theme studio's live previews —
// see docs/v3-card-cms-architecture.md. Namespaced under .jx-root / --jx-color-*
// (distinct from this app's own --jx-yellow/--jx-black brand tokens).
import "@journeyax/ui-cards/styles.css";

export const metadata: Metadata = {
  title: "JourneyAX | Back-Office Console",
  description: "Enterprise Journey Orchestration & Conversational Sales Analytics",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body style={{ margin: 0, padding: 0, minHeight: "100vh", background: "var(--surface-base)" }}>
        {children}
      </body>
    </html>
  );
}
