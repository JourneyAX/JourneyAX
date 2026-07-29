import type { Metadata } from "next";
import "./globals.css";

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
