import { Suspense } from 'react';
import AccountPanel from './AccountPanel';

export const metadata = {
  title: 'Your account — JourneyAX',
};

export default function AccountPage() {
  return (
    <main className="login-shell">
      <Suspense fallback={null}>
        <AccountPanel />
      </Suspense>
    </main>
  );
}
