'use client';

import { JourneyProvider } from '@/context/JourneyContext';
import ChatPanel from '@/components/ChatPanel';
import ProjectPanel from '@/components/ProjectPanel';
import { APPAREL_TENANT } from '@/lib/tenants';

/**
 * The apparel journey.
 *
 * Same JourneyAX shell as the bathroom one — chat left, model-driven panel
 * right — pointed at /api/shop instead. The Fit Advisor lives here and only
 * here: it is a clothing feature and has no business on a tapware quote.
 */
export default function ShopPage() {
  return (
    <JourneyProvider>
      <div className="app-layout">
        <ChatPanel tenant={APPAREL_TENANT} />
        <ProjectPanel />
      </div>
    </JourneyProvider>
  );
}
