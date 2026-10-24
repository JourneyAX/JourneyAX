'use client';

import { useState, type ReactNode } from 'react';
import { JourneyProvider } from '@/context/JourneyContext';
import { useAuth } from '@/context/AuthContext';
import LoginScreen from '@/components/LoginScreen';

/**
 * Sign-in gate. Anonymous access is off: no valid session → the login screen, never the page. While the first session check
 * is in flight nothing renders, rather than flashing the login form at a customer who is already signed in.
 *
 * Embed mode (?embed=1): the surface renders compact and single-column so it works inside an iframe dropped onto any
 * e-commerce site. Detected client-side to avoid a Suspense boundary around useSearchParams.
 *
 * `journey` wraps the page in the journey (cart, cards, phase) state: the chat needs it, the Customize page does not.
 */
export default function AppGate({ journey = true, children }: { journey?: boolean; children: (ctx: { embed: boolean }) => ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  // Read once, on the client. Nothing below renders on the server (the gate renders nothing until the session check has
  // run in the browser), so the first client value is never compared with server markup.
  const [embed] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embed') === '1');

  if (isLoading) return null;
  if (!isAuthenticated) return <LoginScreen />;

  const page = <div className={`app-layout${embed ? ' app-layout--embed' : ''}`}>{children({ embed })}</div>;
  return journey ? <JourneyProvider>{page}</JourneyProvider> : page;
}
