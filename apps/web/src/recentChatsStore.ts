import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef, ScopedThreadRef as ScopedThreadRefSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RECENT_CHATS_MAX_ENTRIES = 100;
const RECENT_CHATS_STORAGE_KEY = "t3code:recent-chats:v1";

const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const isScopedThreadRef = Schema.is(ScopedThreadRefSchema);

export interface RecentChatVisit {
  readonly threadRef: ScopedThreadRef;
  readonly visitedAt: number;
}

export function isValidRecentChatTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS
  );
}

export function upsertRecentChatVisit(
  visits: ReadonlyArray<RecentChatVisit>,
  visit: RecentChatVisit,
  limit = RECENT_CHATS_MAX_ENTRIES,
): RecentChatVisit[] {
  const threadKey = scopedThreadKey(visit.threadRef);
  return [
    visit,
    ...visits.filter((candidate) => scopedThreadKey(candidate.threadRef) !== threadKey),
  ].slice(0, limit);
}

export function sanitizeRecentChatVisits(value: unknown): RecentChatVisit[] {
  if (!Array.isArray(value)) return [];

  const byThreadKey = new Map<string, RecentChatVisit>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { threadRef, visitedAt } = candidate as Partial<RecentChatVisit>;
    if (!isScopedThreadRef(threadRef)) continue;
    if (!isValidRecentChatTimestamp(visitedAt)) continue;

    const threadKey = scopedThreadKey(threadRef);
    const existing = byThreadKey.get(threadKey);
    if (existing !== undefined && existing.visitedAt >= visitedAt) continue;
    byThreadKey.set(threadKey, { threadRef, visitedAt });
  }

  return [...byThreadKey.values()]
    .toSorted((left, right) => right.visitedAt - left.visitedAt)
    .slice(0, RECENT_CHATS_MAX_ENTRIES);
}

interface RecentChatsStoreState {
  visits: ReadonlyArray<RecentChatVisit>;
  recordVisit: (ref: ScopedThreadRef, at?: number) => void;
}

export const useRecentChatsStore = create<RecentChatsStoreState>()(
  persist(
    (set) => ({
      visits: [],
      recordVisit: (ref, at = Date.now()) => {
        if (!isValidRecentChatTimestamp(at)) return;
        set((state) => ({
          visits: upsertRecentChatVisit(state.visits, { threadRef: ref, visitedAt: at }),
        }));
      },
    }),
    {
      name: RECENT_CHATS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ visits: state.visits }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        visits: sanitizeRecentChatVisits(
          (persistedState as { readonly visits?: unknown } | null)?.visits,
        ),
      }),
    },
  ),
);

export function recordRecentChatVisit(ref: ScopedThreadRef, at = Date.now()): void {
  useRecentChatsStore.getState().recordVisit(ref, at);
}
