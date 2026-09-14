'use client';

import { useEffect, useState } from 'react';
import { JourneyProvider } from '@/context/JourneyContext';
import { StorefrontConfigProvider } from '@/context/StorefrontConfigContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import ChatPanel from '@/components/ChatPanel';
import ProjectPanel from '@/components/ProjectPanel';
import EasySwitchToast from '@/components/EasySwitchToast';
import LoginScreen from '@/components/LoginScreen';

/**
 * Sign-in gate. Anonymous access is off: no valid session → the login screen,
 * never the chat. While the first session check is in flight we render nothing
 * rather than flashing the login form at a customer who is already signed in.
 */
function Gate({ embed }: { embed: boolean }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <LoginScreen />;
  return (
    <JourneyProvider>
      <div className={`app-layout${embed ? ' app-layout--embed' : ''}`}>
        <ChatPanel />
        <ProjectPanel />
        {!embed && <EasySwitchToast />}
      </div>
    </JourneyProvider>
  );
}

export default function Home() {
  // Embed mode (?embed=1): the AX surface renders compact + single-column so it
  // works inside an iframe dropped onto any e-commerce site. Detected client-side
  // to avoid a Suspense boundary around useSearchParams.
  const [embed, setEmbed] = useState(false);
  useEffect(() => {
    setEmbed(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);

  return (
    <StorefrontConfigProvider>
      <AuthProvider>
        <Gate embed={embed} />
      </AuthProvider>
    </StorefrontConfigProvider>
  );
}
