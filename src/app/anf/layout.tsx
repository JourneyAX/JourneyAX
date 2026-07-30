import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Abercrombie & Fitch — AI Personal Stylist',
  description:
    'Shop Abercrombie & Fitch in one conversation. Tell the AI stylist your occasion, fit and palette and get a personalized edit, full-look styling, and instant checkout.',
};

export default function AnfLayout({ children }: { children: React.ReactNode }) {
  return children;
}
