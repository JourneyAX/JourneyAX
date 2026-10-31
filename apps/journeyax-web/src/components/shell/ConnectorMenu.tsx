'use client';

/**
 * The connectors section of the "+" menu: what the signed-in person may use, each with a switch for this conversation. The server
 * decides what is listed (it is exactly what the assistant may use for that person); a switch can only turn one off. An ask-first
 * connector is marked, so nobody is surprised that it will ask before it changes anything.
 */
import { tidyName } from '@/lib/customize/connectorPage';
import type { ConnectorItem } from '@/lib/connectors/connectors';

/** The connector rows and their note: one switch each, for this conversation. */
export function ConnectorRows({ items, off, onToggle }: { items: ConnectorItem[]; off: string[]; onToggle: (connector: string) => void }) {
  return (
    <>
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
          >
            <span className="ax-connector__text">
              <span className="ax-connector__name">{tidyName(item.name)}</span>
            </span>
            <span className="ax-switch" data-on={on ? 'true' : 'false'} aria-hidden="true"><span className="ax-switch__knob" /></span>
          </button>
        );
      })}
    </>
  );
}

export default function ConnectorMenu({ items, off, onToggle }: { items: ConnectorItem[]; off: string[]; onToggle: (connector: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ax-connectors" role="group" aria-label="Connectors">
      <div className="ax-popover__title">Connectors</div>
      <ConnectorRows items={items} off={off} onToggle={onToggle} />
    </div>
  );
}
