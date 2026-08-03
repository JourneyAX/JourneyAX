'use client';

export default function HeroPanel() {
  const features = ['Rule-based matching', 'Fixed catalog pricing', 'Zero AI tokens'];

  return (
    <div className="hero-panel">
      <div className="hero-panel__eyebrow">Caroma · Made For Life</div>
      <h1 className="hero-panel__heading">
        Configure your bathroom in one conversation.
      </h1>
      <p className="hero-panel__desc">
        Tell me about your project — the style, the scope, and the finish. I&apos;ll match the right Caroma collection, validate every hidden in-wall component, price it, and confirm stock — as one quote you can adjust.
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
