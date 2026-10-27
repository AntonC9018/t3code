const listeners = new Set<() => void>();
const CHANNEL = "t3code:voice-recording-recovery";

export function notifyVoiceRecordingRecoveryChange(): void {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is origin-scoped.
    channel.postMessage(null);
    channel.close();
  }
}

export function subscribeVoiceRecordingRecovery(listener: () => void): () => void {
  listeners.add(listener);
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  channel?.addEventListener("message", listener);
  window.addEventListener("focus", listener);
  return () => {
    listeners.delete(listener);
    channel?.close();
    window.removeEventListener("focus", listener);
  };
}
