'use client';

/**
 * The right-hand side panel: product details and comparisons open here instead of inline when there is room.
 *
 * One panel at a time. It renders the same json-render card (CardTile) the thread uses, so its actions behave identically.
 *   docked    beside the thread, resizable by dragging the handle or with the arrow keys; width remembered per browser
 *   overlay   floats over the right of the thread when docking would squeeze it
 *   sheet     a full-screen dialog on a phone (<= 860px)
 * Esc and the close button close it; focus moves in on open and goes back to what was pressed on close. Width and layout
 * rules live in lib/shell/panel.ts (unit tested).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CardTile } from '@/components/cards/CardStage';
import { readStored, writeStored } from '@/lib/shell/storage';
import {
  PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_STORAGE_KEY, clampPanelWidth, maxPanelWidth, panelMode, parseStoredWidth,
  stepPanelWidth, widthFromDrag,
} from '@/lib/shell/panel';
import { isPanelCardType, panelCardCopy } from '@/lib/shell/panelCards';
import { closePanelCard, resolvePanelCard, useCanvas, useOpenPanel } from '@/lib/shell/sidePanelStore';
import { drawCanvas } from '@/components/canvas/registry';
import { canvasHeading, canvasMinWidth } from '@/lib/shell/canvasRegistry';
import type { CardInstance } from '@/lib/types';
import { CloseIcon, PanelIcon } from './icons';
import { useShell } from './ShellContext';

type Action = (name: string, params?: Record<string, unknown>) => void;

/** The narrowest a surface nobody registered is drawn at. */
const CANVAS_FALLBACK_MIN_WIDTH = 560;

/** The card the panel is showing right now, or null. Shared by the host and by the thread (which marks its note "showing"). */
export function useShownPanelCard(cards: CardInstance[], enabled: boolean): CardInstance | null {
  const open = useOpenPanel();
  if (!enabled) return null;
  return resolvePanelCard(cards.filter((card) => isPanelCardType(card.cardType)), open);
}

export default function SidePanelHost({ cards, onAction, enabled, composerSelector = '#chat-input-field' }: {
  cards: CardInstance[];
  onAction: Action;
  /** False in the embedded surface, where cards stay inline. */
  enabled: boolean;
  composerSelector?: string;
}) {
  const shownCard = useShownPanelCard(cards, enabled);
  const canvas = useCanvas();
  // A working surface (cart, payment, order) takes the panel; otherwise the card that was opened.
  const card = canvas && enabled ? null : shownCard;
  const { sidebarWidth } = useShell();
  const [viewport, setViewport] = useState<number>(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  const [wanted, setWanted] = useState<number>(() => parseStoredWidth(readStored(PANEL_STORAGE_KEY)) ?? PANEL_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const mode = panelMode(viewport, sidebarWidth);
  const showCanvas = !!canvas && enabled;
  const width = clampPanelWidth(showCanvas ? Math.max(wanted, canvasMinWidth(canvas!, CANVAS_FALLBACK_MIN_WIDTH)) : wanted, viewport, sidebarWidth);
  const isOpen = !!card || showCanvas;

  const close = useCallback(() => {
    const back = closePanelCard();
    const target = back ?? document.querySelector<HTMLElement>(composerSelector);
    // Let the panel unmount first, so focus is not handed to something about to disappear.
    window.setTimeout(() => target?.focus(), 0);
  }, [composerSelector]);

  // Focus moves into the panel when it opens (not again when one card replaces another).
  useEffect(() => {
    if (isOpen && !wasOpen.current) closeRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);

  // Escape closes; on a phone the sheet also keeps Tab inside itself.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab' && mode === 'sheet' && panelRef.current) {
        const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, mode, close]);

  const remember = (value: number) => { writeStored(PANEL_STORAGE_KEY, String(value)); };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWanted(widthFromDrag(drag.current.startX, drag.current.startWidth, event.clientX, viewport, sidebarWidth));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = widthFromDrag(drag.current.startX, drag.current.startWidth, event.clientX, viewport, sidebarWidth);
    drag.current = null;
    setDragging(false);
    setWanted(next);
    remember(next);
  };
  const onHandleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = stepPanelWidth(width, event.key, event.shiftKey, viewport, sidebarWidth);
    if (next === null) return;
    event.preventDefault();
    setWanted(next);
    remember(next);
  };
  const resetWidth = () => { setWanted(PANEL_DEFAULT_WIDTH); remember(PANEL_DEFAULT_WIDTH); };

  if (!card && !showCanvas) return null;
  const copy = card ? panelCardCopy(card) : { kind: canvasHeading(canvas!), title: canvasHeading(canvas!), note: '' };
  const sheet = mode === 'sheet';

  return (
    <>
      <aside
        ref={panelRef}
        className="ax-panel"
        data-canvas={showCanvas ? canvas!.kind : undefined}
        data-mode={mode}
        data-dragging={dragging}
        style={sheet ? undefined : { width }}
        aria-label={copy.title === copy.kind ? copy.kind : `${copy.kind}: ${copy.title}`}
        role={sheet ? 'dialog' : 'complementary'}
        aria-modal={sheet ? true : undefined}
      >
        {!sheet && (
          <div
            className="ax-panel__handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize side panel"
            aria-valuemin={PANEL_MIN_WIDTH}
            aria-valuemax={maxPanelWidth(viewport, sidebarWidth)}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onHandleKey}
            onDoubleClick={resetWidth}
            title="Drag to resize. Double-click to reset."
          />
        )}
        <header className="ax-panel__head">
          {/* The card below carries the product's own name; the heading says what this panel is. */}
          <h2 className="ax-panel__title">{copy.kind}</h2>
          <button ref={closeRef} type="button" className="ax-iconbtn" onClick={close} aria-label="Close side panel" title="Close (Esc)">
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="ax-panel__body">
          {card ? <CardTile key={card.id} card={card} onAction={onAction} /> : null}
          {showCanvas ? drawCanvas(canvas!) : null}
        </div>
      </aside>
    </>
  );
}

/** The line the thread keeps where a panel card was: what opened, plus a way to reopen it or show it inline. */
export function PanelNote({ card, showing, inline, onOpen, onToggleInline }: {
  card: CardInstance;
  showing: boolean;
  inline: boolean;
  onOpen: () => void;
  onToggleInline: () => void;
}) {
  const copy = panelCardCopy(card);
  return (
    <div className="ax-panelnote" data-showing={showing}>
      <PanelIcon size={16} />
      <span className="ax-panelnote__text">{copy.note}</span>
      <span className="ax-panelnote__actions">
        {showing ? (
          <span className="ax-panelnote__state">Open</span>
        ) : (
          <button type="button" className="ax-linkbtn" onClick={onOpen}>Open</button>
        )}
        <button type="button" className="ax-linkbtn" aria-expanded={inline} onClick={onToggleInline}>{inline ? 'Hide here' : 'Show here'}</button>
      </span>
    </div>
  );
}
