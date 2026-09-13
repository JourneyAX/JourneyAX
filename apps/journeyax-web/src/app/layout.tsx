import type { Metadata } from "next";
import "./globals.css";
// Card CMS (v3) base styles for the neutral primitive catalog — see
// docs/v3-card-cms-architecture.md. Tenants restyle via --jx-* tokens
// (StorefrontConfigContext's applyCardTheme), never by editing this file.
import "@journeyax/ui-cards/styles.css";

export const metadata: Metadata = {
  title: "JourneyAX",
  description: "AI-powered conversational commerce — understand the goal, curate the plan, and order in one conversation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
