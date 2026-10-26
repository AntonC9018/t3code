import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  RECENT_CHATS_MAX_ENTRIES,
  type RecentChatVisit,
  sanitizeRecentChatVisits,
  upsertRecentChatVisit,
  useRecentChatsStore,
} from "./recentChatsStore";

const REF_A = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-a"));
const REF_B = scopeThreadRef(EnvironmentId.make("environment-a"), ThreadId.make("thread-b"));
const REF_SAME_ID_OTHER_ENV = scopeThreadRef(
  EnvironmentId.make("environment-b"),
  ThreadId.make("thread-a"),
);

beforeEach(() => {
  useRecentChatsStore.setState({ visits: [] });
});

describe("upsertRecentChatVisit", () => {
  it("moves a revisited chat to the front without duplicating scoped refs", () => {
    const visits: RecentChatVisit[] = [
      { threadRef: REF_A, visitedAt: 30 },
      { threadRef: REF_B, visitedAt: 20 },
    ];
    expect(
      upsertRecentChatVisit(visits, { threadRef: REF_A, visitedAt: 40 }).map((visit) => [
        visit.threadRef.threadId,
        visit.visitedAt,
      ]),
    ).toEqual([
      ["thread-a", 40],
      ["thread-b", 20],
    ]);
    expect(
      upsertRecentChatVisit(visits, { threadRef: REF_SAME_ID_OTHER_ENV, visitedAt: 50 }).map(
        (visit) => [visit.threadRef.environmentId, visit.threadRef.threadId],
      ),
    ).toEqual([
      ["environment-b", "thread-a"],
      ["environment-a", "thread-a"],
      ["environment-a", "thread-b"],
    ]);
  });

  it("bounds the history", () => {
    const visits = Array.from({ length: 3 }, (_, index) => ({
      threadRef: scopeThreadRef(
        EnvironmentId.make("environment-a"),
        ThreadId.make(`thread-${index}`),
      ),
      visitedAt: 3 - index,
    }));
    expect(
      upsertRecentChatVisit(visits, { threadRef: REF_A, visitedAt: 10 }, 3).map(
        (visit) => visit.visitedAt,
      ),
    ).toEqual([10, 3, 2]);
    expect(RECENT_CHATS_MAX_ENTRIES).toBeGreaterThan(3);
  });
});

describe("sanitizeRecentChatVisits", () => {
  it("drops malformed refs and timestamps, keeping the latest duplicate", () => {
    const visits = sanitizeRecentChatVisits([
      null,
      {},
      { threadRef: {}, visitedAt: 1 },
      { threadRef: REF_A, visitedAt: Number.NaN },
      { threadRef: REF_A, visitedAt: Number.POSITIVE_INFINITY },
      { threadRef: REF_A, visitedAt: "2" },
      { threadRef: REF_A, visitedAt: 2 },
      { threadRef: REF_A, visitedAt: 5 },
      { threadRef: REF_B, visitedAt: 4 },
    ]);

    expect(visits).toEqual([
      { threadRef: REF_A, visitedAt: 5 },
      { threadRef: REF_B, visitedAt: 4 },
    ]);
  });

  it("ignores a non-array value", () => {
    expect(sanitizeRecentChatVisits({ visits: [{ threadRef: REF_A, visitedAt: 1 }] })).toEqual([]);
    expect(sanitizeRecentChatVisits(undefined)).toEqual([]);
  });
});

describe("useRecentChatsStore", () => {
  it("records visits and ignores invalid timestamps", () => {
    useRecentChatsStore.getState().recordVisit(REF_A, 10);
    useRecentChatsStore.getState().recordVisit(REF_B, 20);
    useRecentChatsStore.getState().recordVisit(REF_A, 30);
    useRecentChatsStore.getState().recordVisit(REF_B, Number.NaN);

    expect(useRecentChatsStore.getState().visits).toEqual([
      { threadRef: REF_A, visitedAt: 30 },
      { threadRef: REF_B, visitedAt: 20 },
    ]);
  });

  it("sanitizes persisted visits while rehydrating", async () => {
    const { storage, name } = useRecentChatsStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: {
        visits: [
          { threadRef: REF_A, visitedAt: 10 },
          { threadRef: REF_A, visitedAt: 20 },
          { threadRef: REF_B, visitedAt: Number.NaN },
          { threadRef: {}, visitedAt: 30 },
        ],
      },
      version: 1,
    });

    await useRecentChatsStore.persist.rehydrate();

    expect(useRecentChatsStore.persist.hasHydrated()).toBe(true);
    expect(useRecentChatsStore.getState().visits).toEqual([{ threadRef: REF_A, visitedAt: 20 }]);
  });
});
