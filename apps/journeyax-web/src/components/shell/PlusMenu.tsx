'use client';

/**
 * The lists in the chat's "+" menu, the way Claude lays them out: Skills, Connectors and Plugins, each opening a small list beside the
 * menu with "Manage" and "Browse" at the bottom that lead to the Customize page.
 *
 *   Skills      pick one to ask the assistant to use it (the words go in the message box); always-on skills are only listed.
 *   Connectors  one switch each for this chat (what the server lets this person use, as before), plus Manage and Add.
 *   Plugins     the bundles the assistant has, with what each brings.
 *
 * Skills and plugins are listed only for people who manage the assistant (see lib/shell/plusMenu.ts).
 */
import Link from 'next/link';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { customizeHref, type CustomizeTab } from '@/lib/customize/deepLink';
import type { ConnectorItem } from '@/lib/connectors/connectors';
import type { PlusModel, PlusSkill } from '@/lib/shell/plusMenu';
import { ConnectorRows } from './ConnectorMenu';
import { BlocksIcon, ChevronRightIcon, PlugIcon, SkillIcon } from './icons';

type Section = 'skills' | 'connectors' | 'plugins';

export default function PlusMenu({ model, connectors, off, search, onToggleConnector, onPickSkill, onClose, initialOpen }: {
  model: PlusModel;
  connectors: ConnectorItem[];
  /** Ids of the connectors this chat has switched off. */
  off: string[];
  /** The page's query string, so links keep the storefront. */
  search: string;
  onToggleConnector: (connector: string) => void;
  onPickSkill: (skill: PlusSkill) => void;
  onClose: () => void;
  /** Which list starts open (only the tests use this; a person opens one by clicking its row). */
  initialOpen?: 'skills' | 'connectors' | 'plugins';
}) {
  const [open, setOpen] = useState<Section | null>(initialOpen ?? null);
  if (!model.showLists && connectors.length === 0) return null;

  const link = (tab: CustomizeTab, label: string, scope?: 'discover') => (
    <Link role="menuitem" href={customizeHref(search, { tab, scope })} className="ax-menu__item" onClick={onClose}>{label}</Link>
  );
  const section = (id: Section, label: string, icon: ReactNode, badge: ReactNode, body: ReactNode) => {
    const expanded = open === id;
    return (
      <div className="ax-sub" key={id}>
        <button
          type="button"
          role="menuitem"
          className="ax-menu__item ax-sub__row"
          aria-haspopup="menu"
          aria-expanded={expanded}
          onClick={() => setOpen(expanded ? null : id)}
          onKeyDown={(event: KeyboardEvent) => { if (event.key === 'ArrowRight') { event.preventDefault(); setOpen(id); } }}
        >
          {icon}
          <span className="ax-sub__label">{label}</span>
          {badge}
          <ChevronRightIcon size={15} className="ax-sub__chev" />
        </button>
        {expanded && (
          <Flyout label={label} onLeft={() => setOpen(null)}>{body}</Flyout>
        )}
      </div>
    );
  };

  return (
    <div className="ax-plusmenu" role="group" aria-label="Skills, connectors and plugins">
      {model.showLists && section('skills', 'Skills', <SkillIcon size={16} />, null, (
        <>
          {model.skills.length === 0 && <p className="ax-popover__note">None</p>}
          {model.skills.map((skill) => (
            skill.always ? (
              <div key={skill.skillId} role="menuitem" aria-disabled="true" className="ax-menu__item ax-skillitem" title={`${skill.description} This skill is always on, so there is nothing to pick.`}>
                <span className="ax-skillitem__name">{skill.name}</span>
                <span className="ax-badge">Always on</span>
              </div>
            ) : (
              <button key={skill.skillId} type="button" role="menuitem" className="ax-menu__item ax-skillitem" title={skill.description} onClick={() => onPickSkill(skill)}>
                <span className="ax-skillitem__name">{skill.name}</span>
              </button>
            )
          ))}
          <div className="ax-sub__foot">
            {link('skills', 'Manage skills')}
            {link('skills', 'Browse skills', 'discover')}
          </div>
        </>
      ))}

      {section('connectors', 'Connectors', <PlugIcon size={16} />, off.length > 0 ? <span className="ax-badge">{off.length} off</span> : null, (
        <>
          {connectors.length === 0 && <p className="ax-popover__note">None</p>}
          <ConnectorRows items={connectors} off={off} onToggle={onToggleConnector} />
          <div className="ax-sub__foot">
            {link('connectors', 'Manage connectors')}
            {link('connectors', 'Add connector', 'discover')}
          </div>
        </>
      ))}

      {model.showLists && section('plugins', 'Plugins', <BlocksIcon size={16} />, null, (
        <>
          {model.plugins.length === 0 && <p className="ax-popover__note">None</p>}
          {model.plugins.map((plugin) => (
            <Link key={plugin.pluginId} role="menuitem" href={customizeHref(search, { tab: 'plugins' })} className="ax-menu__item ax-skillitem ax-skillitem--stack" onClick={onClose}>
              <span className="ax-skillitem__name">{plugin.name}</span>
            </Link>
          ))}
          <div className="ax-sub__foot">
            {link('plugins', 'Manage plugins')}
            {link('plugins', 'Browse plugins', 'discover')}
          </div>
        </>
      ))}
    </div>
  );
}

/** The list beside the menu. It starts level with its row and is moved (and shortened) so that it stays inside the window. */
function Flyout({ label, onLeft, children }: { label: string; onLeft: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const host = panel?.parentElement;
    if (!panel || !host) return;
    if (window.matchMedia('(max-width: 640px)').matches) { panel.removeAttribute('style'); return; }
    const margin = 12;
    const row = host.getBoundingClientRect();
    panel.style.maxHeight = `${Math.max(160, Math.min(440, window.innerHeight - margin * 2))}px`;
    const { offsetHeight: height, offsetWidth: width } = panel;
    const top = Math.max(margin, Math.min(row.top - 8, window.innerHeight - margin - height));
    panel.style.top = `${top - row.top}px`;
    if (row.right + 6 + width > window.innerWidth - 8 && row.left - 6 - width >= 8) { panel.style.left = 'auto'; panel.style.right = 'calc(100% + 6px)'; }
  });
  return (
    <div
      ref={ref}
      className="ax-sub__panel"
      role="menu"
      aria-label={label}
      onKeyDown={(event: KeyboardEvent) => { if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); onLeft(); } }}
    >
      {children}
    </div>
  );
}
