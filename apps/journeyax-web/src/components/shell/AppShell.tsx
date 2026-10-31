'use client';

/**
 * AppShell — the frame every signed-in page lives in: a collapsible sidebar (new chat, search, navigation, recents, the
 * signed-in person) and one main area. The chat and the Customize page both render inside it, so the sidebar is the same
 * everywhere and keeps its open/closed state as people move between them.
 *
 * Theming: a warm light palette with a dark variant lives in shell.css (`--ax-*` tokens on `.ax-shell`). The tenant's own
 * colours, when it has set any, are passed in here as `--ax-*-tenant` custom properties (see lib/shell/theme.ts).
 *
 * The sidebar is open by default on a wide screen and a slide-over drawer on a phone (<= 860px). This component only ever
 * renders after sign-in has resolved (the gate renders nothing before that), so it can read storage and the window in its
 * initial state without a server/client mismatch.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { deriveShellTheme } from '@/lib/shell/theme';
import { readStored, writeStored } from '@/lib/shell/storage';
import { SHEET_BREAKPOINT } from '@/lib/shell/panel';
import AppSidebar, { type SidebarConversation } from './AppSidebar';
import { SIDEBAR_WIDTH, ShellContext, type ShellContextValue } from './ShellContext';

const COLLAPSED_KEY = 'ax:sidebar-collapsed';
const MOBILE_QUERY = `(max-width: ${SHEET_BREAKPOINT}px)`;

export interface AppShellProps {
  /** Which page is showing, for the sidebar's navigation. */
  active: 'chat' | 'customize';
  conversations: SidebarConversation[];
  /** The open conversation (chat page); empty on pages that have none. */
  activeConversationId?: string;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** The ?embed=1 surface: no Customize link. */
  embed?: boolean;
  /** Extra control above the person's name (the sample-customer picker). */
  footerExtra?: ReactNode;
  className?: string;
  children: ReactNode;
}

export default function AppShell({
  active, conversations, activeConversationId = '', onNewChat, onOpenConversation, onDeleteConversation,
  embed = false, footerExtra, className, children,
}: AppShellProps) {
  const cfg = useStorefrontConfig();
  const theme = useMemo(() => deriveShellTheme(cfg), [cfg]);

  const [collapsed, setCollapsed] = useState<boolean>(() => readStored(COLLAPSED_KEY) === '1');
  const [isMobile, setIsMobile] = useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => { setIsMobile(mql.matches); if (!mql.matches) setMobileOpen(false); };
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const visible = isMobile ? mobileOpen : !collapsed;

  const toggleSidebar = useCallback(() => {
    if (isMobile) { setMobileOpen((open) => !open); return; }
    setCollapsed((was) => { writeStored(COLLAPSED_KEY, was ? '0' : '1'); return !was; });
  }, [isMobile]);
  const closeSidebar = useCallback(() => { if (isMobile) setMobileOpen(false); }, [isMobile]);

  // The phone drawer: Escape closes it, and focus moves into it when it opens.
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    shellRef.current?.querySelector<HTMLElement>('.ax-sidebar button:not([disabled])')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [isMobile, mobileOpen]);

  const ctx = useMemo<ShellContextValue>(() => ({
    sidebarVisible: visible,
    sidebarWidth: !isMobile && visible ? SIDEBAR_WIDTH : 0,
    isMobile,
    toggleSidebar,
    closeSidebar,
  }), [visible, isMobile, toggleSidebar, closeSidebar]);

  return (
    <ShellContext.Provider value={ctx}>
      <div
        ref={shellRef}
        className={['ax-shell', className].filter(Boolean).join(' ')}
        data-sidebar={theme.sidebarTone}
        data-collapsed={!isMobile && collapsed ? 'true' : 'false'}
        data-mobile-open={isMobile && mobileOpen ? 'true' : 'false'}
        style={theme.vars as CSSProperties}
      >
        <AppSidebar
          active={active}
          hidden={!visible}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onNewChat={() => { onNewChat(); closeSidebar(); }}
          onOpenConversation={(id) => { onOpenConversation(id); closeSidebar(); }}
          onDeleteConversation={onDeleteConversation}
          onToggle={toggleSidebar}
          onNavigate={closeSidebar}
          embed={embed}
          footerExtra={footerExtra}
        />
        {isMobile && mobileOpen && (
          <button type="button" className="ax-scrim" aria-label="Close sidebar" tabIndex={-1} onClick={closeSidebar} />
        )}
        <div className="ax-main">{children}</div>
      </div>
    </ShellContext.Provider>
  );
}
