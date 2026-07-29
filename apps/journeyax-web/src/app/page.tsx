'use client';

import { useEffect, useState } from 'react';
import { JourneyProvider } from '@/context/JourneyContext';
import { StorefrontConfigProvider } from '@/context/StorefrontConfigContext';
import ChatPanel from '@/components/ChatPanel';
import ProjectPanel from '@/components/ProjectPanel';
import EasySwitchToast from '@/components/EasySwitchToast';

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
      <JourneyProvider>
        <div className={`app-layout${embed ? ' app-layout--embed' : ''}`}>
          <ChatPanel />
          <ProjectPanel />
          {!embed && <EasySwitchToast />}
        </div>
      </JourneyProvider>
    </StorefrontConfigProvider>
  );
}
