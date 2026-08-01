'use client';

/**
 * Hero — CONFIG-DRIVEN per tenant (multi-storefront). Brand, vocabulary and
 * pitch all come from the project's published config; nothing brand-specific
 * lives in code.
 */
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function HeroPanel() {
  const cfg = useStorefrontConfig();
  const items = (cfg.labels.items || 'Products').toLowerCase();
  // Closing-pitch word follows the commerce surface: a retail bag "complete look",
  // a B2B project "complete quote". No brand string in code — driven by config.
  const closing = cfg.commerceMode === 'cart' ? 'One complete look' : 'One complete quote';
  const features = ['Expert guidance', 'Real catalogue data', closing];

  return (
    <div className="hero-panel">
      <div className="hero-panel__eyebrow">{cfg.companyName}</div>
      <h1 className="hero-panel__heading">
        {cfg.intro?.heroHeadline || `${cfg.labels.headerTitle || `Find the right ${items}`} — in one conversation.`}
      </h1>
      <p className="hero-panel__desc">
        {cfg.intro?.heroSubtitle
          || `Tell ${cfg.systemName || 'our consultant'} what you're trying to achieve. I'll ask the right questions, match the right ${items} from ${cfg.companyName}'s real catalogue, and bring it together as one plan you can adjust.`}
      </p>
      <div className="hero-panel__features">
        {features.map(f => (
          <div key={f} className="hero-panel__feature">
            <span className="hero-panel__feature-dot" />
            <span className="hero-panel__feature-text">{f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
