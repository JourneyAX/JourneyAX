/**
 * Conversations as the sidebar lists them, and starting or opening one from a page that is not the chat (Customize).
 * The saved list itself is lib/conversations.ts; this only adds the sidebar's view of it.
 */
import {
  type Conversation, listConversations, messagesKey, newId, saveConversations, setActiveConversation,
} from '../conversations';
import { readStored } from './storage';

/** The title a new, still empty conversation carries in the saved list (lib/conversations.ts). */
export const BLANK_TITLE = 'New conversation';

/** The chats worth listing in Recents: blank ones are noise, except the one that is open, and they are shown under a plain name. */
export function forSidebar<T extends { id: string; title: string }>(list: T[], activeId: string): T[] {
  return list
    .filter((c) => c.id === activeId || c.title !== BLANK_TITLE)
    .map((c) => (c.title === BLANK_TITLE ? { ...c, title: 'New chat' } : c));
}

/** A conversation that was started but never used, if there is one: a new chat reuses it rather than stacking another. */
export function findBlankConversation(projectId: string | undefined, list: Conversation[]): Conversation | undefined {
  return list.find((c) => c.title === BLANK_TITLE && !readStored(messagesKey(projectId, c.id)));
}

/** Makes a fresh conversation the active one (reusing a blank one when there is one) and returns its id. */
export function startConversation(projectId: string | undefined): string {
  const list = listConversations(projectId);
  const blank = findBlankConversation(projectId, list);
  if (blank) {
    setActiveConversation(projectId, blank.id);
    return blank.id;
  }
  const id = newId();
  saveConversations(projectId, [{ id, title: BLANK_TITLE, updatedAt: Date.now() }, ...list]);
  setActiveConversation(projectId, id);
  return id;
}
