import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRecentChatEntries,
  filterRecentChatEntries,
  resolveInitialRecentChatKey,
  resolveRecentChatActiveKey,
  stepRecentChatKey,
  type RecentChatThread,
} from "./RecentChatsPicker.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

function makeThread(overrides: Partial<RecentChatThread> = {}): RecentChatThread {
  return {
    environmentId: ENVIRONMENT_A,
    id: ThreadId.make("thread-1"),
    projectId: PROJECT_A,
    title: "Thread",
    archivedAt: null,
    deletedAt: null,
    lastVisitedAt: null,
    lineage: { relationshipToParent: null },
    ...overrides,
  };
}

function localVisit(
  thread: RecentChatThread,
  visitedAt: number,
): { threadRef: ReturnType<typeof scopeThreadRef>; visitedAt: number } {
  return {
    threadRef: scopeThreadRef(thread.environmentId, thread.id),
    visitedAt,
  };
}

const projectTitleByKey = new Map([
  [scopedProjectKey(scopeProjectRef(ENVIRONMENT_A, PROJECT_A)), "Alpha"],
  [scopedProjectKey(scopeProjectRef(ENVIRONMENT_A, PROJECT_B)), "Beta"],
  [scopedProjectKey(scopeProjectRef(ENVIRONMENT_B, PROJECT_A)), "Remote Alpha"],
]);

describe("buildRecentChatEntries", () => {
  it("orders local visits first and uses server visit watermarks only as a fallback", () => {
    const first = makeThread({ id: ThreadId.make("first"), title: "First" });
    const second = makeThread({ id: ThreadId.make("second"), title: "Second" });
    const fallback = makeThread({
      id: ThreadId.make("fallback"),
      title: "Fallback",
      lastVisitedAt: "2026-01-01T00:00:02.000Z",
    });

    const entries = buildRecentChatEntries({
      threads: [first, second, fallback],
      visits: [
        localVisit(first, Date.parse("2026-01-01T00:00:01.000Z")),
        localVisit(second, Date.parse("2026-01-01T00:00:03.000Z")),
      ],
      projectTitleByKey,
    });

    expect(entries.map((entry) => [entry.title, entry.visitedFrom])).toEqual([
      ["Second", "local"],
      ["Fallback", "server"],
      ["First", "local"],
    ]);
  });

  it("prefers a local visit over a newer server watermark for the same thread", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-local"),
      lastVisitedAt: "2026-01-01T00:00:09.000Z",
    });
    const other = makeThread({
      id: ThreadId.make("thread-server"),
      lastVisitedAt: "2026-01-01T00:00:05.000Z",
    });

    const entries = buildRecentChatEntries({
      threads: [thread, other],
      visits: [localVisit(thread, Date.parse("2026-01-01T00:00:01.000Z"))],
    });

    expect(entries.map((entry) => [entry.key, entry.visitedFrom])).toEqual([
      [scopedThreadKey(scopeThreadRef(ENVIRONMENT_A, other.id)), "server"],
      [scopedThreadKey(scopeThreadRef(ENVIRONMENT_A, thread.id)), "local"],
    ]);
  });

  it("omits archived, deleted, subagent, and never-visited threads", () => {
    const active = makeThread({
      id: ThreadId.make("active"),
      lastVisitedAt: "2026-01-01T00:00:01.000Z",
    });
    const archived = makeThread({
      id: ThreadId.make("archived"),
      archivedAt: "2026-01-01T00:00:01.000Z",
      lastVisitedAt: "2026-01-01T00:00:02.000Z",
    });
    const deleted = makeThread({
      id: ThreadId.make("deleted"),
      deletedAt: "2026-01-01T00:00:01.000Z",
      lastVisitedAt: "2026-01-01T00:00:03.000Z",
    });
    const subagent = makeThread({
      id: ThreadId.make("subagent"),
      lineage: { relationshipToParent: "subagent" },
      lastVisitedAt: "2026-01-01T00:00:04.000Z",
    });
    const neverVisited = makeThread({ id: ThreadId.make("never-visited") });
    const invalidServerTimestamp = makeThread({
      id: ThreadId.make("invalid"),
      lastVisitedAt: "not-a-date",
    });

    const entries = buildRecentChatEntries({
      threads: [active, archived, deleted, subagent, neverVisited, invalidServerTimestamp],
      visits: [],
    });

    expect(entries.map((entry) => entry.title)).toEqual(["Thread"]);
    expect(entries[0]?.key).toBe(scopedThreadKey(scopeThreadRef(ENVIRONMENT_A, active.id)));
  });

  it("keeps the same thread id separate across environments", () => {
    const threadId = ThreadId.make("shared-thread");
    const local = makeThread({ environmentId: ENVIRONMENT_A, id: threadId, title: "Local" });
    const remote = makeThread({ environmentId: ENVIRONMENT_B, id: threadId, title: "Remote" });

    const entries = buildRecentChatEntries({
      threads: [local, remote],
      visits: [
        localVisit(local, Date.parse("2026-01-01T00:00:01.000Z")),
        localVisit(remote, Date.parse("2026-01-01T00:00:02.000Z")),
      ],
      projectTitleByKey,
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      scopedThreadKey(scopeThreadRef(ENVIRONMENT_B, threadId)),
      scopedThreadKey(scopeThreadRef(ENVIRONMENT_A, threadId)),
    ]);
    expect(entries.map((entry) => entry.projectTitle)).toEqual(["Remote Alpha", "Alpha"]);
  });
});

describe("filterRecentChatEntries", () => {
  const threads = [
    makeThread({ id: ThreadId.make("login"), title: "Fix login flow", projectId: PROJECT_A }),
    makeThread({ id: ThreadId.make("billing"), title: "Refactor billing", projectId: PROJECT_B }),
    makeThread({ id: ThreadId.make("docs"), title: "Login docs", projectId: PROJECT_B }),
  ];
  const entries = buildRecentChatEntries({
    threads,
    visits: [localVisit(threads[0]!, 3), localVisit(threads[1]!, 2), localVisit(threads[2]!, 1)],
    projectTitleByKey,
  });

  it("matches titles and projects while preserving recency order", () => {
    expect(filterRecentChatEntries(entries, "LOGIN").map((entry) => entry.title)).toEqual([
      "Fix login flow",
      "Login docs",
    ]);
    expect(filterRecentChatEntries(entries, "beta").map((entry) => entry.title)).toEqual([
      "Refactor billing",
      "Login docs",
    ]);
    expect(filterRecentChatEntries(entries, "alpha login").map((entry) => entry.title)).toEqual([
      "Fix login flow",
    ]);
  });

  it("returns every entry for an empty query", () => {
    expect(filterRecentChatEntries(entries, "   ")).toEqual(entries);
  });
});

describe("recent chat selection", () => {
  const keys = ["newest", "middle", "oldest"];

  it("starts on the previous chat when the current chat is the newest visit", () => {
    expect(
      resolveInitialRecentChatKey(
        keys.map((key) => ({ key })),
        "newest",
      ),
    ).toBe("middle");
    expect(
      resolveInitialRecentChatKey(
        keys.map((key) => ({ key })),
        "oldest",
      ),
    ).toBe("newest");
    expect(
      resolveInitialRecentChatKey(
        keys.map((key) => ({ key })),
        null,
      ),
    ).toBe("newest");
    expect(resolveInitialRecentChatKey([{ key: "only" }], "only")).toBe("only");
    expect(resolveInitialRecentChatKey([], "newest")).toBeNull();
  });

  it("wraps keyboard steps and keeps a valid selection", () => {
    expect(stepRecentChatKey(keys, "newest", "next")).toBe("middle");
    expect(stepRecentChatKey(keys, "oldest", "next")).toBe("newest");
    expect(stepRecentChatKey(keys, "newest", "previous")).toBe("oldest");
    expect(stepRecentChatKey(keys, null, "next")).toBe("newest");
    expect(stepRecentChatKey(keys, null, "previous")).toBe("oldest");
    expect(stepRecentChatKey([], "newest", "next")).toBeNull();
    expect(resolveRecentChatActiveKey(keys, "middle")).toBe("middle");
    expect(resolveRecentChatActiveKey(keys, "missing")).toBe("newest");
    expect(resolveRecentChatActiveKey([], "middle")).toBeNull();
  });
});
