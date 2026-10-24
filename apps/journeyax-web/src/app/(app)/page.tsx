'use client';

import AppGate from '@/components/shell/AppGate';
import ChatPanel from '@/components/ChatPanel';
import EasySwitchToast from '@/components/EasySwitchToast';

/**
 * The chat. Single-column conversation inside the shared app shell (docs/v3-card-cms-architecture.md, "PlaceMakers
 * Conversation" mockup): ChatPanel IS the page — the conversation, its inline cards, and the still-bespoke legacy panels
 * (3D configurator, …) all render inside its own scrolling thread. No separate stage column. The sign-in gate and the
 * providers are shared with the Customize page (components/shell/AppGate, AppProviders).
 */
export default function Home() {
  return (
    <AppGate>
      {({ embed }) => (
        <>
          <ChatPanel embed={embed} />
          {!embed && <EasySwitchToast />}
        </>
      )}
    </AppGate>
  );
}
