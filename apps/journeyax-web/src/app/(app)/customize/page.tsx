'use client';

import AppGate from '@/components/shell/AppGate';
import CustomizePage from '@/components/customize/CustomizePage';

/** Customize: the tenant's agents, skills, knowledge and connectors, inside the same shell as the chat. */
export default function Customize() {
  return (
    <AppGate journey={false}>
      {({ embed }) => <CustomizePage embed={embed} />}
    </AppGate>
  );
}
