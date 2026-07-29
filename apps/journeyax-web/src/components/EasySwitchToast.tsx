'use client';

import { useJourney } from '@/context/JourneyContext';

import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function EasySwitchToast() {
  // Caroma-specific (EasySwitch in-wall bodies) — only for fixtures tenants.
  const cfg = useStorefrontConfig();
  if (cfg.configurator && cfg.configurator.productType === 'garment') return null;
  const { state } = useJourney();

  if (!state.showToast) return null;

  return (
    <div className="easyswitch-toast">
      <svg className="easyswitch-toast__icon" width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" stroke="#C6A060" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <div>
        <div className="easyswitch-toast__title">EasySwitch in-wall bodies added</div>
        <div className="easyswitch-toast__text">
          Liano II mixers and showers install onto universal in-wall bodies. Adding them now prevents an incomplete order — and a return trip to site.
        </div>
      </div>
    </div>
  );
}
