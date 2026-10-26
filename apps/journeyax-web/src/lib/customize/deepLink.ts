/**
 * Links into the Customize page from elsewhere (the chat's "+" menu, the connector pages): which tab, Yours or Discover, and which
 * connector or skill to open. Like every shell link they keep the query that picks the storefront (`?project=`, `embed`).
 */
import { preservedQuery } from '../shell/nav';

export type CustomizeTab = 'agents' | 'skills' | 'plugins' | 'knowledge' | 'connectors';
export type CustomizeScope = 'yours' | 'discover';

export const CUSTOMIZE_TABS: readonly CustomizeTab[] = ['agents', 'skills', 'plugins', 'knowledge', 'connectors'];

export interface DeepLink { tab?: CustomizeTab; scope?: CustomizeScope; open?: string }

/** `/customize?project=x&tab=skills&scope=discover&open=skill-id`. */
export function customizeHref(search: string | undefined | null, link: DeepLink = {}): string {
  const params = new URLSearchParams(preservedQuery(search).replace(/^\?/, ''));
  if (link.tab) params.set('tab', link.tab);
  if (link.scope === 'discover') params.set('scope', 'discover');
  if (link.open) params.set('open', link.open);
  const text = params.toString();
  return `/customize${text ? `?${text}` : ''}`;
}

/** What the address asks for; a tab or scope that is not one of ours is ignored. */
export function readDeepLink(search: string | undefined | null): DeepLink {
  const params = new URLSearchParams(String(search || ''));
  const tab = params.get('tab');
  const open = (params.get('open') || '').trim().slice(0, 96);
  return {
    ...(CUSTOMIZE_TABS.includes(tab as CustomizeTab) ? { tab: tab as CustomizeTab } : {}),
    ...(params.get('scope') === 'discover' ? { scope: 'discover' as const } : {}),
    ...(open ? { open } : {}),
  };
}
