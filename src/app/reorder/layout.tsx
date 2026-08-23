import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Smart Team Reorder POC | JourneyAX',
  description: 'A JourneyAX proof of concept that lets returning teams change only what changed and preserve the approved order.',
  robots: { index: false, follow: false },
};

export default function ReorderLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
