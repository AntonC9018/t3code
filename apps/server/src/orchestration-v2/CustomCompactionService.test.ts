import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  TurnItemId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as CustomCompaction from "./CustomCompactionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventSink from "./EventSink.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const summarizer: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};
const projectId = ProjectId.make("project:custom-compaction");
const threadId = ThreadId.make("thread:custom-compaction");
const request = { threadId, commandId: CommandId.make("compact:one"), modelSelection: summarizer };

function makeHarness(
  generate?: TextGeneration.TextGeneration["Service"]["generateContextSummary"],
) {
  const database = SqlitePersistence.layerMemory;
  const adapters = [modelSelection, summarizer].map(
    (selection) =>
      ({
        instanceId: selection.instanceId,
        driver: ProviderDriverKind.make(selection.instanceId),
        getCapabilities: () =>
          Effect.succeed(
            selection === modelSelection
              ? CodexProviderCapabilitiesV2
              : ClaudeProviderCapabilitiesV2,
          ),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("compaction must not open the original provider"),
      }) as ProviderAdapter.ProviderAdapterV2["Service"],
  );
  const registry = ProviderAdapterRegistry.layerFromAdapters(adapters);
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "custom-compaction" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(
    Layer.provide(orchestration),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  );
  const generateContextSummary = vi.fn(
    generate ?? (() => Effect.succeed({ summary: "Preserved objective and next steps." })),
  );
  const layer = CustomCompaction.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        threads,
        orchestration,
        IdAllocator.layer,
        registry,
        ThreadCommandExecutor.layer,
        Layer.mock(TextGeneration.TextGeneration)({ generateContextSummary }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Compaction",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
      ),
    ),
  );
  return { layer, generateContextSummary };
}

/** Records a finished turn so the thread is idle with a native conversation to supersede. */
const completeTurn = Effect.fn(function* (target: ThreadId, id: string, text: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId: target,
    messageId: MessageId.make(id),
    text,
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* threads.getThreadProjection(target);
  const run = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]!;
  const provider = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  )!;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const settled = [
    ...projection.turnItems
      .filter((item) => item.status === "running" || item.status === "pending")
      .map((item) => ({
        type: "turn-item.updated" as const,
        payload: { ...item, status: "completed" as const, completedAt: now },
      })),
    ...projection.contextTransfers
      .filter((transfer) => transfer.status === "pending")
      .map((transfer) => ({
        type: "context-transfer.updated" as const,
        payload: { ...transfer, status: "consumed" as const },
      })),
    {
      type: "run.updated" as const,
      payload: { ...run, status: "completed" as const, completedAt: now },
    },
    {
      type: "provider-thread.updated" as const,
      payload: {
        ...provider,
        status: "idle" as const,
        nativeThreadRef: {
          driver: provider.driver,
          nativeId: `native:${target}`,
          strength: "strong" as const,
        },
      },
    },
  ];
  for (const event of settled) {
    yield* sink.write({
      events: [
        {
          ...event,
          id: yield* ids.allocate.event({ threadId: target }),
          threadId: target,
          occurredAt: now,
        },
      ],
    });
  }
  return yield* threads.getThreadProjection(target);
});

const seed = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Original title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return yield* completeTurn(threadId, "first", "ORIGINAL_LONG_TRANSCRIPT");
});

describe("custom model compaction", () => {
  it.effect(
    "persists one summary boundary, keeps app identity, and never replays old history on a later switch",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const original = yield* seed;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* CustomCompaction.CustomCompactionService;
        yield* service.compact(request);
        yield* service.compact(request);
        const compacted = yield* threads.getThreadProjection(threadId);
        assert.equal(harness.generateContextSummary.mock.calls.length, 1);
        assert.include(
          harness.generateContextSummary.mock.calls[0]![0].transcript,
          "ORIGINAL_LONG_TRANSCRIPT",
        );
        assert.deepEqual(compacted.thread.modelSelection, original.thread.modelSelection);
        assert.equal(compacted.thread.title, original.thread.title);
        assert.equal(compacted.turnItems.filter((item) => item.type === "handoff").length, 1);
        assert.equal(
          compacted.providerThreads.find(
            (provider) => provider.id === compacted.thread.activeProviderThreadId,
          )?.nativeThreadRef,
          null,
        );
        assert.equal(
          compacted.providerThreads.find(
            (provider) => provider.id === original.thread.activeProviderThreadId,
          )?.compactionSuperseded,
          true,
        );
        assert.equal(
          compacted.contextHandoffs[0]?.summaryText,
          "Preserved objective and next steps.",
        );
        assert.isUndefined(compacted.contextHandoffs[0]?.history);
        // Switching before any post-compaction turn exercises the unused summary handoff too.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("switch"),
          threadId,
          modelSelection: summarizer,
          messageId: MessageId.make("switch"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const switched = yield* threads.getThreadProjection(threadId);
        const handoff = switched.contextHandoffs.find(
          (handoff) => handoff.toProviderThreadId === switched.thread.activeProviderThreadId,
        );
        assert.isDefined(handoff);
        const transferred =
          handoff!.history?.messages.map((message) => message.text).join("\n") ??
          handoff!.summaryText;
        assert.include(transferred, "Preserved objective and next steps.");
        assert.notInclude(transferred, "ORIGINAL_LONG_TRANSCRIPT");
        assert.include(
          switched.messages.map((message) => message.text).join("\n"),
          "ORIGINAL_LONG_TRANSCRIPT",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps later provider items with restarted ordinals when compacting again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* CustomCompaction.CustomCompactionService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      yield* service.compact(request);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("later"),
        threadId,
        messageId: MessageId.make("later"),
        text: "Later request",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(threadId);
      const run = after.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
      const template = after.turnItems.find((item) => item.type === "user_message")!;
      const now = yield* DateTime.now;
      for (const item of after.turnItems.filter(
        (item) => item.status === "running" || item.status === "pending",
      )) {
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              threadId,
              type: "turn-item.updated",
              occurredAt: now,
              payload: { ...item, status: "completed", completedAt: now },
            },
          ],
        });
      }
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            type: "run.updated",
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
          {
            id: yield* ids.allocate.event({ threadId }),
            threadId,
            type: "turn-item.updated",
            occurredAt: now,
            payload: {
              ...template,
              type: "assistant_message",
              streaming: false,
              id: TurnItemId.make("later-answer"),
              runId: run.id,
              ordinal: 0,
              text: "LATER_LOW_ORDINAL_ANSWER",
            },
          },
        ],
      });
      yield* service.compact({ ...request, commandId: CommandId.make("compact:two") });
      const transcript = harness.generateContextSummary.mock.calls.at(-1)![0].transcript;
      assert.include(transcript, "LATER_LOW_ORDINAL_ANSWER");
      assert.include(transcript, "Later request");
      assert.include(transcript, "Preserved objective and next steps.");
      assert.notInclude(transcript, "ORIGINAL_LONG_TRANSCRIPT");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("summarizes history a fork inherited from its source thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const source = yield* seed;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* CustomCompaction.CustomCompactionService;
      const forkId = ThreadId.make("thread:custom-compaction-fork");
      yield* threads.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId: threadId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: source.runs[0]!.id },
        createdBy: "user",
        creationSource: "web",
      });
      const fork = yield* completeTurn(forkId, "fork-turn", "Implement that plan");
      assert.isTrue(fork.visibleTurnItems.some((row) => row.visibility === "inherited"));
      yield* service.compact({
        ...request,
        threadId: forkId,
        commandId: CommandId.make("compact:fork"),
      });
      assert.include(
        harness.generateContextSummary.mock.calls.at(-1)![0].transcript,
        "Implement that plan",
      );
      assert.include(
        harness.generateContextSummary.mock.calls.at(-1)![0].transcript,
        "ORIGINAL_LONG_TRANSCRIPT",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves native context when summary generation fails", () => {
    const harness = makeHarness(() =>
      Effect.fail(
        new TextGenerationError({ operation: "generateContextSummary", detail: "fixture failure" }),
      ),
    );
    return Effect.gen(function* () {
      const original = yield* seed;
      const service = yield* CustomCompaction.CustomCompactionService;
      const result = yield* service.compact(request).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const after = yield* threads.getThreadProjection(threadId);
      assert.equal(after.thread.activeProviderThreadId, original.thread.activeProviderThreadId);
      assert.deepEqual(after.providerThreads, original.providerThreads);
      assert.isEmpty(after.contextHandoffs);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects a stale summary after a concurrent message arrives", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ summary: "stale summary" }),
        ),
      );
      yield* Effect.gen(function* () {
        const original = yield* seed;
        const service = yield* CustomCompaction.CustomCompactionService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const fiber = yield* service.compact(request).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        const duplicate = yield* service
          .compact({ ...request, commandId: CommandId.make("compact:different") })
          .pipe(Effect.result);
        assert.equal(duplicate._tag, "Failure");
        if (duplicate._tag === "Failure") assert.equal(duplicate.failure.reason, "in_progress");
        yield* completeTurn(threadId, "concurrent", "A message sent during compaction");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        assert.equal(result._tag, "Failure");
        const after = yield* threads.getThreadProjection(threadId);
        assert.equal(after.thread.activeProviderThreadId, original.thread.activeProviderThreadId);
        assert.isEmpty(after.contextHandoffs);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps compacting after the requesting client stops waiting", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ summary: "Detached summary" }),
        ),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* CustomCompaction.CustomCompactionService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const caller = yield* service.compact(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        // Closing the menu or dropping the socket interrupts the request, not the compaction.
        yield* Fiber.interrupt(caller);
        // Opening the thread meanwhile records a visit; it does not change the summarized context.
        yield* threads.dispatch({
          type: "thread.visit",
          commandId: CommandId.make("visit-during-compaction"),
          threadId,
          visitedAt: "2026-06-20T00:10:00.000Z",
        });
        const rejoined = yield* service.compact(request).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(rejoined);
        const after = yield* threads.getThreadProjection(threadId);
        assert.equal(after.contextHandoffs[0]?.summaryText, "Detached summary");
        assert.equal(harness.generateContextSummary.mock.calls.length, 1);
        // The slot is released, so a later compaction can start.
        yield* service.compact({ ...request, commandId: CommandId.make("compact:again") });
        assert.equal(harness.generateContextSummary.mock.calls.length, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it("splits Unicode transcripts without losing text or exceeding the byte budget", () => {
    const text = "🧪Контекст".repeat(10_000);
    const chunks = CustomCompaction.splitCompactionTranscript(text);
    assert.equal(chunks.join(""), text);
    assert.isAbove(chunks.length, 1);
    for (const part of chunks) assert.isAtMost(Buffer.byteLength(part), 48_000);
  });
});
