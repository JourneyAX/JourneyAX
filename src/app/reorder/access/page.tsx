import { Suspense } from 'react';
import AccessForm from './AccessForm';
import './access.css';

export const metadata = {
  title: 'Confirm your email — Momentec reorder',
};

export default function CoachAccessPage() {
  return (
    <main className="ca-shell">
      <Suspense fallback={null}>
        <AccessForm />
      </Suspense>
    </main>
  );
}
