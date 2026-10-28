'use client';

/**
 * The sidebar: sidebar toggle, new chat, search, navigation (Chats, Customize), recents grouped by day, and the signed-in
 * person with their menu. Everything shown is the tenant's own: its logo or name at the top, the person's name at the
 * bottom, the chats in between. No business is named here.
 */
import BrandLockup from '@/components/brand/BrandLockup';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { groupRecents } from '@/lib/shell/recents';
import { shellHref } from '@/lib/shell/nav';
import { initials } from '@/lib/shell/theme';
import { ChatIcon, CustomizeIcon, NewChatIcon, SearchIcon, SidebarIcon, SignOutIcon, TrashIcon, ChevronDownIcon } from './icons';
import { useDismiss } from './useDismiss';

export interface SidebarConversation {
  id: string;
  title: string;
  updatedAt: number;
}

export interface AppSidebarProps {
  active: 'chat' | 'customize';
  /** Not showing: the sidebar is closed (collapsed on desktop, drawer shut on a phone). Its controls leave the tab order. */
  hidden: boolean;
  conversations: SidebarConversation[];
  activeConversationId: string;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onToggle: () => void;
  /** Called after a navigation link is followed (closes the phone drawer). */
  onNavigate: () => void;
  embed: boolean;
  footerExtra?: ReactNode;
}

export default function AppSidebar({
  active, hidden, conversations, activeConversationId, onNewChat, onOpenConversation, onDeleteConversation, onToggle, onNavigate, embed, footerExtra,
}: AppSidebarProps) {
  const cfg = useStorefrontConfig();
  const { user, logout } = useAuth();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(menuRef, menuOpen, closeMenu);

  const search = typeof window !== 'undefined' ? window.location.search : '';
  // "Today" and "Yesterday" move at midnight: keep the clock fresh enough for the groups to follow it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const groups = useMemo(() => groupRecents(conversations, now, query), [conversations, now, query]);

  // A broken logo URL falls back to the name, as the old header did, so the tenant never loses its identity at the top.
  const logo = cfg.theme?.logoUrl && !logoFailed ? cfg.theme.logoUrl : null;
  const brand = cfg.companyName || 'JourneyAX';
  const login = String(user?.email || '').split('@')[0];
  const personName = login || user?.fullName || '';

  const signOut = async () => {
    setMenuOpen(false);
    await logout();
  };

  return (
    <aside className="ax-sidebar" aria-label="Sidebar" inert={hidden || undefined} data-hidden={hidden ? 'true' : 'false'}>
      <div className="ax-sidebar__top">
        <button type="button" className="ax-iconbtn" onClick={onToggle} aria-label="Close sidebar" title="Close sidebar">
          <SidebarIcon />
        </button>
        <div className="ax-sidebar__brand">
          {cfg.brandOverlay ? (
            <BrandLockup />
          ) : logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={brand}
              className={`ax-sidebar__logo${cfg.theme?.sidebarStyle === 'dark' ? ' ax-sidebar__logo--on-brand' : ''}`}
              style={cfg.theme?.sidebarStyle === 'dark' ? { background: cfg.theme?.sidebarColor || cfg.theme?.primaryColor || undefined } : undefined}
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="ax-sidebar__wordmark">{brand}</span>
          )}
        </div>
      </div>

      <nav className="ax-nav" aria-label="Main">
        <button id="new-convo-btn" type="button" className="ax-nav__item ax-nav__item--primary" onClick={onNewChat}>
          <span className="ax-nav__badge"><NewChatIcon size={16} /></span>
          <span>New chat</span>
        </button>
        <label className="ax-search">
          <SearchIcon size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            autoComplete="off"
          />
        </label>
        <Link
          href={shellHref('/', search)}
          className="ax-nav__item"
          aria-current={active === 'chat' ? 'page' : undefined}
          onClick={onNavigate}
        >
          <ChatIcon size={17} />
          <span>Chats</span>
        </Link>
        {!embed && (
          <Link
            href={shellHref('/customize', search)}
            className="ax-nav__item"
            aria-current={active === 'customize' ? 'page' : undefined}
            onClick={onNavigate}
          >
            <CustomizeIcon size={17} />
            <span>Customize</span>
          </Link>
        )}
      </nav>

      <div className="ax-recents" role="region" aria-label="Recent chats">
        {groups.map((group) => (
          <section key={group.id} className="ax-recents__group" aria-label={group.label}>
            <h2 className="ax-recents__label">{group.label}</h2>
            <ul className="ax-recents__list">
              {group.items.map((c) => (
                <li key={c.id} className={`ax-recent${c.id === activeConversationId ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="ax-recent__open"
                    onClick={() => onOpenConversation(c.id)}
                    aria-current={c.id === activeConversationId ? 'true' : undefined}
                    title={c.title}
                  >
                    <span className="ax-recent__title">{c.title || 'New chat'}</span>
                  </button>
                  <button
                    type="button"
                    className="ax-recent__del"
                    onClick={() => onDeleteConversation(c.id)}
                    aria-label={`Delete chat: ${c.title || 'New chat'}`}
                    title="Delete chat"
                  >
                    <TrashIcon size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && (
          <p className="ax-recents__empty">{query.trim() ? 'No chats match your search.' : 'Your chats will appear here.'}</p>
        )}
      </div>

      <div className="ax-sidebar__footer" ref={menuRef}>
        {footerExtra}
        {menuOpen && (
          <div className="ax-menu ax-menu--up" role="menu" aria-label="Account">
            <div className="ax-menu__who">
              <strong>{user?.fullName || personName || 'Signed in'}</strong>
              {user?.email && <span>{user.email}</span>}
            </div>
            {!embed && (
              <Link role="menuitem" href={shellHref('/customize', search)} className="ax-menu__item" onClick={() => { setMenuOpen(false); onNavigate(); }}>
                <CustomizeIcon size={16} /> Customize
              </Link>
            )}
            <button type="button" role="menuitem" className="ax-menu__item" onClick={signOut}>
              <SignOutIcon size={16} /> Sign out
            </button>
          </div>
        )}
        <button
          type="button"
          className="ax-user"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="ax-user__avatar" aria-hidden="true">{initials(personName, '·')}</span>
          <span className="ax-user__meta">
            <span className="ax-user__name">{personName || 'Signed in'}</span>
            {user?.role && <span className="ax-user__sub">{user.role}</span>}
          </span>
          <ChevronDownIcon size={16} className="ax-user__chev" />
        </button>
      </div>
    </aside>
  );
}
