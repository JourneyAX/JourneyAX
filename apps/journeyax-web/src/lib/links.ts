/**
 * Where a link opens. Everything the chat shows (links in an answer, product pages, install guides, warranty documents, buttons on a
 * card) opens in the same place as the chat, not in a new tab: the person stays in one window and the back button returns them to
 * the conversation, which is saved. One place decides it so it can be changed once.
 */
export const LINK_TARGET = '_self' as const;

/** Props for an `<a>` that leaves the chat for a page or a document. */
export const linkProps = { target: LINK_TARGET, rel: 'noopener noreferrer' } as const;

/** Opens a page from code (a card's "open page" action) in the same place as the chat. Only http(s) and relative addresses are opened. */
export function openLink(url: string, navigate: (url: string) => void = (value) => window.location.assign(value)): boolean {
  const target = String(url || '').trim();
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target)) return false;
  navigate(target);
  return true;
}
