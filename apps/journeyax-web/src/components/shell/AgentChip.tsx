'use client';

/**
 * The agent chip in the composer: which agent is answering. It lists the tenant's agents (from the active pack, via the
 * Customize overview) with what each is for.
 *
 * Today the chat request carries no agent id (see lib/shell/capabilities.ts): the runtime picks the agent for each message,
 * so the chip is read-only. It names the agent that answered last, or the pack's default before the first answer, and the
 * popover says the assistant chooses on its own. When the request starts accepting an agent id, `onSelect` makes it a picker.
 */
import { useCallback, useId, useRef, useState } from 'react';
import { useOverview } from '@/components/customize/useOverview';
import { AgentIcon, CheckIcon, ChevronDownIcon } from './icons';
import { useDismiss } from './useDismiss';

export default function AgentChip({ answeringAgentId, selectedAgentId, onSelect }: {
  /** The agent that answered the latest turn, when known. */
  answeringAgentId?: string;
  /** Picker mode only: the agent the person chose. */
  selectedAgentId?: string;
  /** Present only when the chat request can carry an agent id. */
  onSelect?: (agentId: string) => void;
}) {
  const { data } = useOverview();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);

  const agents = data?.agents ?? [];
  if (agents.length === 0) return null;
  const picker = typeof onSelect === 'function';
  const current = agents.find((a) => a.agentId === (picker ? selectedAgentId : answeringAgentId))
    || agents.find((a) => a.isDefault)
    || agents[0];

  return (
    <div className="ax-agentchip" ref={rootRef}>
      <button
        type="button"
        className="ax-chip"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`Agent: ${current.name}. ${picker ? 'Choose an agent' : 'Show agents'}`}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentIcon size={15} />
        <span className="ax-chip__label">{current.name}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="ax-popover ax-popover--up" id={popId} role={picker ? 'menu' : 'group'} aria-label="Agents">
          <p className="ax-popover__title">Agents</p>
          <ul className="ax-agentlist">
            {agents.map((a) => {
              const active = a.agentId === current.agentId;
              const body = (
                <>
                  <span className="ax-agentlist__name">{a.name}{a.isDefault && <span className="ax-badge">Default</span>}</span>
                  {a.purpose && <span className="ax-agentlist__purpose">{a.purpose}</span>}
                </>
              );
              return (
                <li key={a.agentId} data-active={active}>
                  {picker ? (
                    <button type="button" role="menuitemradio" aria-checked={active} className="ax-agentlist__row" onClick={() => { onSelect(a.agentId); setOpen(false); }}>
                      <span className="ax-agentlist__text">{body}</span>
                      {active && <CheckIcon size={15} />}
                    </button>
                  ) : (
                    <div className="ax-agentlist__row">
                      <span className="ax-agentlist__text">{body}</span>
                      {active && <CheckIcon size={15} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {!picker && <p className="ax-popover__note">The assistant picks the best agent for each message.</p>}
        </div>
      )}
    </div>
  );
}
