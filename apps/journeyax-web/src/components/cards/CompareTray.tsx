'use client';

/**
 * The products ticked for comparison, kept just above the composer so the customer always sees what they are about to compare and
 * can open it, drop one, or start over. Appears only while something is ticked.
 */
import { MAX_COMPARE, clearCompare, toggleCompare, useCompareSelection } from '@/lib/cards/compareStore';

export default function CompareTray({ onCompare }: { onCompare: (skus: string[]) => void }) {
  const items = useCompareSelection();
  if (items.length === 0) return null;
  const ready = items.length >= 2;
  return (
    <div className="compare-tray" role="region" aria-label="Products to compare">
      <div className="compare-tray__items">
        {items.map((item) => (
          <span className="compare-tray__chip" key={item.sku} title={item.title}>
            <span className="compare-tray__name">{item.title}</span>
            <button type="button" className="compare-tray__remove" aria-label={`Remove ${item.title} from the comparison`} onClick={() => toggleCompare(item)}>×</button>
          </span>
        ))}
      </div>
      <div className="compare-tray__actions">
        <span className="compare-tray__hint">{ready ? (items.length >= MAX_COMPARE ? 'Ready to compare' : 'Add one more, or compare now') : 'Tick one more to compare'}</span>
        <button type="button" className="compare-tray__go" disabled={!ready} onClick={() => onCompare(items.map((item) => item.sku))}>Compare</button>
        <button type="button" className="compare-tray__clear" onClick={clearCompare}>Clear</button>
      </div>
    </div>
  );
}
