/**
 * The mark and name of the AI strategy brand, drawn with the same shapes and type as the website's header: two overlapping squares (lime and
 * blue) and "AI strategy" over "& enablement". It is drawn here, not shown as a picture, so it stays sharp at any size and takes the page's
 * ink colour in the dark theme. Only used when a brand overlay is on.
 */
export default function BrandLockup({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-lockup${className ? ` ${className}` : ''}`} role="img" aria-label="AI strategy and enablement">
      <span className="brand-lockup__symbol" aria-hidden="true"><i /><i /></span>
      <span className="brand-lockup__text" aria-hidden="true">AI strategy<br /><b>&amp; enablement</b></span>
    </span>
  );
}
