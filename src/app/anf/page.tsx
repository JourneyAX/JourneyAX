'use client';

import '@/anf/anf.css';
import { AnfProvider } from '@/anf/AnfContext';
import AnfChat from '@/anf/components/AnfChat';
import AnfShowcase from '@/anf/components/AnfShowcase';

export default function AnfPage() {
  return (
    <AnfProvider>
      <div className="anf-app">
        <AnfChat />
        <AnfShowcase />
      </div>
    </AnfProvider>
  );
}
