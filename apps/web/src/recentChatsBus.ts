const RECENT_CHATS_OPEN_EVENT = "t3code:open-recent-chats";

export function openRecentChats(): void {
  window.dispatchEvent(new Event(RECENT_CHATS_OPEN_EVENT));
}

export function onOpenRecentChats(listener: () => void): () => void {
  window.addEventListener(RECENT_CHATS_OPEN_EVENT, listener);
  return () => window.removeEventListener(RECENT_CHATS_OPEN_EVENT, listener);
}
