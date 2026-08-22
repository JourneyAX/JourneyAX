import { Suspense } from 'react';
import LoginForm from './LoginForm';

export const metadata = {
  title: 'Sign in — JourneyAX',
};

export default function LoginPage() {
  return (
    <main className="login-shell">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
