'use client';

/**
 * The connectors section of the "+" menu: what the signed-in person may use, each with a switch for this conversation. The server
 * decides what is listed (it is exactly what the assistant may use for that person); a switch can only turn one off. An ask-first
 * connector is marked, so nobody is surprised that it will ask before it changes anything.
 */
import { connectorCapability, type ConnectorItem } from '@/lib/connectors/connectors';

export default function ConnectorMenu({ items, off, onToggle }: { items: ConnectorItem[]; off: string[]; onToggle: (connector: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ax-connectors" role="group" aria-label="Connectors">
      <div className="ax-popover__title">Connectors</div>
      {items.map((item) => {
        const on = !off.includes(item.connector);
        return (
          <button
            key={item.connector}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            className="ax-menu__item ax-connector"
            onClick={() => onToggle(item.connector)}
            title={item.description}
          >
            <span className="ax-connector__text">
              <span className="ax-connector__name">
                {item.sample ? item.name.replace(/\s*\(sample\)\s*$/i, '') : item.name}
                {item.sample && <span className="ax-badge">Sample data</span>}
              </span>
              <span className="ax-connector__line">{connectorCapability(item)}</span>
            </span>
            <span className="ax-switch" data-on={on ? 'true' : 'false'} aria-hidden="true"><span className="ax-switch__knob" /></span>
          </button>
        );
      })}
      <p className="ax-popover__note">Switch one off to keep the assistant from using it in this chat.</p>
    </div>
  );
}
