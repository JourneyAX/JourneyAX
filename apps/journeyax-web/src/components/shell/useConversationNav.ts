'use client';

/**
 * The conversation list and its actions for pages that are not the chat: the sidebar still shows Recents, "New chat" starts
 * a conversation and takes you to the chat, opening one does the same, and delete asks first. The chat page keeps its own
 * state (it has the thread loaded); both read and write the same saved list.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { type Conversation, deleteConversation, listConversations, setActiveConversation } from '@/lib/conversations';
import { startConversation } from '@/lib/shell/conversationNav';
import { shellHref } from '@/lib/shell/nav';
import { setPendingAgent } from '@/lib/shell/pendingAgent';

export function useConversationNav() {
  const { projectId } = useStorefrontConfig();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => { setConversations(listConversations(projectId)); }, [projectId]);

  const goToChat = useCallback(() => { router.push(shellHref('/', window.location.search)); }, [router]);

  const newChat = useCallback((agentId?: string) => {
    startConversation(projectId);
    // A chat started with Try on an agent opens talking to that agent.
    setPendingAgent(typeof agentId === 'string' ? agentId : undefined);
    goToChat();
  }, [projectId, goToChat]);

  const open = useCallback((id: string) => {
    setActiveConversation(projectId, id);
    goToChat();
  }, [projectId, goToChat]);

  const remove = useCallback((id: string) => {
    if (!window.confirm('Delete this conversation?')) return;
    setConversations(deleteConversation(projectId, id));
  }, [projectId]);

  return { conversations, newChat, open, remove };
}
