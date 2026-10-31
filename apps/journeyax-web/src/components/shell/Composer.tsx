'use client';

/**
 * The composer: one large rounded box with the message field on top and, underneath, the "+" menu, the agent chip and a
 * round send button (a stop button while a reply is on its way). The field grows with what is typed; Enter sends and
 * Shift+Enter starts a new line.
 *
 * The field keeps the old `chat-input` class and the send button `chat-send-btn`, which the Playwright scripts in the repo
 * select by; shell.css restyles both.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpIcon, PlusIcon, StopIcon } from './icons';
import { useDismiss } from './useDismiss';

const MAX_HEIGHT = 220;

export default function Composer({ value, onChange, onSubmit, onStop, busy, placeholder, agentChip, autoFocus, plusExtra }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** A reply is on its way. */
  busy: boolean;
  placeholder: string;
  agentChip?: ReactNode;
  autoFocus?: boolean;
  /** More for the "+" menu below the attachment entry (skills, connectors, plugins). A function gets a way to close the menu. */
  plusExtra?: ReactNode | ((menu: { close: () => void }) => ReactNode);
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const closePlus = useCallback(() => setPlusOpen(false), []);
  useDismiss(plusRef, plusOpen, closePlus);
  const plusId = useId();
  const hasText = value.trim().length > 0;

  // Grow with the text, up to a limit (then scroll inside the field).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    // A scrollbar only once the text is taller than the field's limit (a wrapped placeholder must not draw one).
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (hasText) onSubmit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="ax-composer" onSubmit={submit} data-busy={busy}>
      <textarea
        id="chat-input-field"
        ref={ref}
        className="ax-composer__text chat-input"
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Message"
        autoFocus={autoFocus}
        enterKeyHint="send"
      />
      <div className="ax-composer__bar">
        <div className="ax-composer__left">
          <div className="ax-plus" ref={plusRef}>
            <button
              type="button"
              className="ax-iconbtn ax-iconbtn--ring"
              aria-label="Add to the message"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              aria-controls={plusOpen ? plusId : undefined}
              onClick={() => setPlusOpen((v) => !v)}
            >
              <PlusIcon size={18} />
            </button>
            {plusOpen && (
              <div className="ax-popover ax-popover--up" id={plusId} role="menu" aria-label="Add to the message">
                <button type="button" role="menuitem" className="ax-menu__item" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                  Add files or photos <span className="ax-badge">Soon</span>
                </button>
                <p className="ax-popover__note">Attachments are not available yet.</p>
                {typeof plusExtra === 'function' ? plusExtra({ close: closePlus }) : plusExtra}
              </div>
            )}
          </div>
          {agentChip}
        </div>
        {busy ? (
          <button type="button" id="chat-stop-btn" className="ax-send ax-send--stop chat-send-btn" onClick={onStop} aria-label="Stop response" title="Stop response">
            <StopIcon size={16} />
          </button>
        ) : (
          <button id="chat-send-btn" type="submit" className="ax-send chat-send-btn" aria-label="Send message" title="Send message" disabled={!hasText}>
            <ArrowUpIcon size={17} />
          </button>
        )}
      </div>
    </form>
  );
}
