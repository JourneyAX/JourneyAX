import type { Metadata } from "next";
import { Newsreader } from "next/font/google";
import "./globals.css";
// The app shell (sidebar, chat column, composer, side panel, Customize page): warm light tokens with a dark variant.
// Imported after globals.css so it can restyle the chat classes that file defines.
import "./shell.css";
import "./customize.css";
// Card CMS (v3) base styles for the neutral primitive catalog — see
// docs/v3-card-cms-architecture.md. Tenants restyle via --jx-* tokens
// (StorefrontConfigContext's applyCardTheme), never by editing this file.
import "@journeyax/ui-cards/styles.css";

// Display face for greetings and page headings (own choice of an open-licence serif; the body font stays as it was).
const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-serif-next",
  fallback: ["Iowan Old Style", "Palatino Linotype", "Georgia", "Times New Roman", "serif"],
});

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
    <html lang="en" className={serif.variable}>
      <body>{children}</body>
    </html>
  );
}
