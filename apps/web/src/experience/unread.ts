/**
 * A chat is unread while something the person timed came due in it (a
 * reminder, or the chat's own schedule) and they have not opened it since. The
 * service says so on the chat (`unread`), so every device agrees. The sidebar
 * and the chat list mark it, Home lists it under "Needs you", and the tab's
 * title counts it. Opening the chat, with the window in front of the person,
 * clears it.
 */
import { useEffect } from 'react';
import { adapter } from './adapter.ts';
import { useApp } from './hooks.ts';
import type { Conversation } from './types.ts';

/** The chats with something that came due and is not seen yet. */
export const unreadChats = (conversations: readonly Conversation[]): Conversation[] =>
  conversations.filter((chat) => chat.unread === true);

/** The tab's title: the installation's name, led by how many chats wait unread. */
export function tabTitle(name: string, unread: number): string {
  return unread > 0 ? `(${unread}) ${name}` : name;
}

/**
 * Marks the open chat seen while the window is in front of the person: when it
 * opens unread, and when something comes due while it is open. In a tab left in
 * the background it waits until the person comes back to it.
 */
export function useSeenWhileOpen(conversationId: string | null, unreadHere: boolean): void {
  const { conversations, refreshConversations } = useApp();
  const unread =
    unreadHere ||
    (conversationId !== null &&
      conversations.some((chat) => chat.id === conversationId && chat.unread === true));
  useEffect(() => {
    if (!conversationId || !unread) return;
    let asked = false;
    let live = true;
    const look = () => {
      if (asked || document.visibilityState !== 'visible') return;
      asked = true;
      void adapter.markSeen(conversationId).then((result) => {
        // Not recorded: the next time the person comes back to the window asks again.
        if (result.data === null) asked = false;
        else if (live) refreshConversations();
      });
    };
    look();
    document.addEventListener('visibilitychange', look);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', look);
    };
  }, [conversationId, unread, refreshConversations]);
}
