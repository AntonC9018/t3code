import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { normalizeSearchText } from "../lib/utils";
import { type RecentChatVisit, isValidRecentChatTimestamp } from "../recentChatsStore";

/** The thread fields the picker reads, so tests can use plain objects. */
export interface RecentChatThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly lastVisitedAt?: string | null;
  readonly lineage: {
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
}

export interface RecentChatEntry {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
  readonly visitedAt: number;
  readonly visitedFrom: "local" | "server";
}

function parseVisitTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Date.parse(value);
  return isValidRecentChatTimestamp(timestamp) ? timestamp : null;
}

/**
 * Local visits record actual navigation, so they win over the server's
 * read-state watermark. The watermark only bootstraps users whose visits
 * predate the local store.
 */
export function buildRecentChatEntries(input: {
  readonly threads: ReadonlyArray<RecentChatThread>;
  readonly visits: ReadonlyArray<RecentChatVisit>;
  readonly projectTitleByKey?: ReadonlyMap<string, string>;
  readonly environmentLabelById?: ReadonlyMap<EnvironmentId, string>;
}): RecentChatEntry[] {
  const localVisitedAtByKey = new Map<string, number>();
  for (const visit of input.visits) {
    if (!isValidRecentChatTimestamp(visit.visitedAt)) continue;
    const key = scopedThreadKey(visit.threadRef);
    const existing = localVisitedAtByKey.get(key);
    if (existing === undefined || visit.visitedAt > existing) {
      localVisitedAtByKey.set(key, visit.visitedAt);
    }
  }

  const entries: RecentChatEntry[] = [];
  for (const thread of input.threads) {
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      continue;
    }

    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(threadRef);
    const localVisitedAt = localVisitedAtByKey.get(key);
    const serverVisitedAt = parseVisitTimestamp(thread.lastVisitedAt);
    const visitedAt = localVisitedAt ?? serverVisitedAt;
    if (visitedAt === null) continue;

    entries.push({
      key,
      threadRef,
      title: thread.title.trim() || "Untitled chat",
      projectTitle:
        input.projectTitleByKey?.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? null,
      environmentLabel: input.environmentLabelById?.get(thread.environmentId) ?? null,
      visitedAt,
      visitedFrom: localVisitedAt === undefined ? "server" : "local",
    });
  }

  return entries.toSorted(
    (left, right) => right.visitedAt - left.visitedAt || left.key.localeCompare(right.key),
  );
}

/** Search keeps visit order instead of ranking matches, like a recent-files list. */
export function filterRecentChatEntries(
  entries: ReadonlyArray<RecentChatEntry>,
  query: string,
): RecentChatEntry[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [...entries];

  return entries.filter((entry) => {
    const haystack = normalizeSearchText(
      [entry.title, entry.projectTitle ?? "", entry.environmentLabel ?? ""].join(" "),
    );
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Opening on the previous chat makes the shortcut a back-and-forth switch.
 * Fall back to the current chat when it is the only visit.
 */
export function resolveInitialRecentChatKey(
  entries: ReadonlyArray<Pick<RecentChatEntry, "key">>,
  currentThreadKey: string | null,
): string | null {
  if (entries.length === 0) return null;
  if (currentThreadKey === null) return entries[0]?.key ?? null;
  return entries.find((entry) => entry.key !== currentThreadKey)?.key ?? entries[0]?.key ?? null;
}

export function resolveRecentChatActiveKey(
  keys: ReadonlyArray<string>,
  selectedKey: string | null,
): string | null {
  if (keys.length === 0) return null;
  return selectedKey !== null && keys.includes(selectedKey) ? selectedKey : (keys[0] ?? null);
}

export function stepRecentChatKey(
  keys: ReadonlyArray<string>,
  currentKey: string | null,
  direction: "next" | "previous",
): string | null {
  if (keys.length === 0) return null;
  const currentIndex = currentKey === null ? -1 : keys.indexOf(currentKey);
  if (currentIndex === -1) {
    return direction === "next" ? (keys[0] ?? null) : (keys.at(-1) ?? null);
  }
  const step = direction === "next" ? 1 : -1;
  return keys[(currentIndex + step + keys.length) % keys.length] ?? null;
}
