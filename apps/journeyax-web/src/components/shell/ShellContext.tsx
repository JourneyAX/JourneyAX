'use client';

import { createContext, useContext } from 'react';

/** What the shell shares with the page inside it: whether the sidebar is showing, and how to toggle it. */
export interface ShellContextValue {
  /** The sidebar is on screen right now (open on desktop, or its drawer is open on a phone). */
  sidebarVisible: boolean;
  /** Width the sidebar takes from the layout, in px: 0 when hidden or when it floats over the page (phone). */
  sidebarWidth: number;
  isMobile: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
}

/** Width of the desktop sidebar; keep in step with `--ax-sidebar-w` in shell.css. */
export const SIDEBAR_WIDTH = 272;

export const ShellContext = createContext<ShellContextValue>({
  sidebarVisible: true,
  sidebarWidth: SIDEBAR_WIDTH,
  isMobile: false,
  toggleSidebar: () => {},
  closeSidebar: () => {},
});

export const useShell = () => useContext(ShellContext);
