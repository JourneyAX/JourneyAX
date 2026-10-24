/**
 * The right-hand side panel: how wide it may be, how it is laid out, and how the keyboard resizes it.
 *
 * Three layouts, picked from the window width:
 *   sheet    a phone or narrow window: the panel takes the whole screen
 *   docked   room for the thread (at least PANEL_MIN_MAIN_WIDTH) and the panel side by side
 *   overlay  not enough room for both: the panel floats over the right of the thread, the thread keeps its width
 * Width is always clamped, so a stored or dragged value can never squeeze the thread to nothing or run off the screen.
 */
export const PANEL_MIN_WIDTH = 340;
export const PANEL_DEFAULT_WIDTH = 480;
export const PANEL_MAX_WIDTH = 960;
/** The conversation column is never squeezed below this when the panel is docked. */
export const PANEL_MIN_MAIN_WIDTH = 440;
/** At or below this window width the panel becomes a full-screen sheet. */
export const SHEET_BREAKPOINT = 860;
/** Overlay panels leave at least this much of the thread visible to their left. */
const OVERLAY_PEEK = 96;

export const PANEL_STEP = 16;
export const PANEL_STEP_LARGE = 64;
export const PANEL_STORAGE_KEY = 'ax:side-panel-width';

export type PanelMode = 'sheet' | 'docked' | 'overlay';

export function panelMode(viewport: number, sidebarWidth: number): PanelMode {
  if (!(viewport > SHEET_BREAKPOINT)) return 'sheet';
  return viewport - Math.max(0, sidebarWidth) - PANEL_MIN_MAIN_WIDTH >= PANEL_MIN_WIDTH ? 'docked' : 'overlay';
}

/** The widest the panel may be in the current layout. */
export function maxPanelWidth(viewport: number, sidebarWidth: number): number {
  const side = Math.max(0, sidebarWidth);
  const mode = panelMode(viewport, side);
  if (mode === 'sheet') return Math.max(0, viewport);
  const room = mode === 'docked' ? viewport - side - PANEL_MIN_MAIN_WIDTH : viewport - side - OVERLAY_PEEK;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, room));
}

export function clampPanelWidth(width: number, viewport: number, sidebarWidth: number): number {
  if (panelMode(viewport, sidebarWidth) === 'sheet') return Math.max(0, Math.round(viewport));
  const wanted = Number.isFinite(width) ? width : PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(maxPanelWidth(viewport, sidebarWidth), Math.max(PANEL_MIN_WIDTH, wanted)));
}

/** A stored value ("512") back to a width, or null when it is missing or not a sensible number. */
export function parseStoredWidth(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The width after a key press on the resize handle. The panel is on the right, so the handle moves left as the panel grows:
 * ArrowLeft widens, ArrowRight narrows (the handle goes where the arrow points). Home = narrowest, End = widest.
 * Returns null for a key the handle does not use.
 */
export function stepPanelWidth(current: number, key: string, large: boolean, viewport: number, sidebarWidth: number): number | null {
  const step = large ? PANEL_STEP_LARGE : PANEL_STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampPanelWidth(current + step, viewport, sidebarWidth);
    case 'ArrowRight':
    case 'ArrowDown':
      return clampPanelWidth(current - step, viewport, sidebarWidth);
    case 'Home':
      return clampPanelWidth(PANEL_MIN_WIDTH, viewport, sidebarWidth);
    case 'End':
      return clampPanelWidth(Number.MAX_SAFE_INTEGER, viewport, sidebarWidth);
    default:
      return null;
  }
}

/** The width while dragging: the panel's left edge follows the pointer. */
export function widthFromDrag(startX: number, startWidth: number, pointerX: number, viewport: number, sidebarWidth: number): number {
  return clampPanelWidth(startWidth + (startX - pointerX), viewport, sidebarWidth);
}
