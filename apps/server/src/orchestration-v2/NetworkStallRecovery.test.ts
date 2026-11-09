import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as NetworkChangeMonitor from "../network/NetworkChangeMonitor.ts";
import * as NetworkStallRecovery from "./NetworkStallRecovery.ts";
import * as RunLiveness from "./RunLiveness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadA = ThreadId.make("thread-network-a");
const runA = RunId.make("run-network-a");
const threadB = ThreadId.make("thread-network-b");
const runB = RunId.make("run-network-b");
const userMessageId = MessageId.make("message-network-user");

interface ThreadState {
  readonly runId: RunId;
  readonly status?: string;
  readonly delegatedCompletion?: boolean;
  readonly delegatedMessage?: boolean;
  readonly appOwnedTask?: boolean;
  readonly activeItems?: ReadonlyArray<{ readonly type: string; readonly runId: RunId }>;
  readonly endedRuns?: ReadonlyArray<{ readonly id: RunId; readonly status: string }>;
  /** Queued runs before the interrupt, and after it settles. */
  readonly queued?: readonly [before: boolean, after: boolean];
}

const projectionOf = (state: ThreadState, interrupted: boolean) =>
  ({
    runs: [
      {
        id: state.runId,
        status: state.status ?? "running",
        userMessageId,
        ...(state.delegatedCompletion === true
          ? { delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null } }
          : {}),
      },
      ...(state.endedRuns ?? []),
      ...((state.queued ?? [false, false])[interrupted ? 1 : 0]
        ? [{ id: RunId.make("run-network-queued"), status: "queued" }]
        : []),
    ],
    turnItems: state.activeItems ?? [{ type: "reasoning", runId: state.runId }],
    subagents: state.appOwnedTask === true ? [{ origin: "app_owned", runId: state.runId }] : [],
    messages:
      state.delegatedMessage === true
        ? [{ id: userMessageId, delegatedCompletion: { parentRunId: runB } }]
        : [{ id: userMessageId }],
  }) as unknown as OrchestrationV2ThreadProjection;

const layerThreads = (input: {
  readonly dispatched: Queue.Queue<OrchestrationV2ServerCommand>;
  readonly stateOf: (threadId: ThreadId) => ThreadState;
  readonly onDispatch?: (command: OrchestrationV2ServerCommand) => Effect.Effect<void>;
}) => {
  const interrupted = new Set<ThreadId>();
  return Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (threadId) =>
      Effect.succeed(projectionOf(input.stateOf(threadId), interrupted.has(threadId)) as never),
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type === "run.interrupt") interrupted.add(command.threadId);
        yield* input.onDispatch?.(command) ?? Effect.void;
        yield* Queue.offer(input.dispatched, command);
        return {} as never;
      }),
  });
};

const recover = (state: ThreadState, stillSilent = true) =>
  Effect.gen(function* () {
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const recoverRun = yield* NetworkStallRecovery.makeRecoverRun.pipe(
      Effect.provide(layerThreads({ dispatched, stateOf: () => state })),
    );
    const outcome = yield* recoverRun({
      threadId: threadA,
      runId: state.runId,
      changeAtMs: 1_000,
      stillSilent: Effect.succeed(stillSilent),
    });
    const commands = yield* Queue.clear(dispatched);
    return { outcome, commands: commands.map((command) => command.type) };
  });

describe("NetworkStallRecovery", () => {
  it.effect("interrupts and resumes only runs still silent when their turn comes", () =>
    Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const changes = yield* Queue.unbounded<number>();
      const liveness = yield* RunLiveness.make;
      yield* liveness.begin({ threadId: threadA, runId: runA });
      const liveB = yield* liveness.begin({ threadId: threadB, runId: runB });
      const silenceChecks = yield* Queue.unbounded<readonly [RunId, boolean]>();
      const layer = NetworkStallRecovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              NetworkChangeMonitor.NetworkChangeMonitor,
              NetworkChangeMonitor.NetworkChangeMonitor.of({ changes: Stream.fromQueue(changes) }),
            ),
            Layer.succeed(RunLiveness.RunLiveness, {
              ...liveness,
              isSilentSince: (runId, cutoffMs) =>
                liveness
                  .isSilentSince(runId, cutoffMs)
                  .pipe(Effect.tap((silent) => Queue.offer(silenceChecks, [runId, silent]))),
            }),
            layerThreads({
              dispatched,
              stateOf: (threadId) => ({ runId: threadId === threadB ? runB : runA }),
              // Run B's stream comes back while run A is being recovered.
              onDispatch: (command) =>
                command.type === "run.interrupt" && command.runId === runA
                  ? liveB.touch
                  : Effect.void,
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        yield* Queue.offer(changes, 1_000);
        yield* TestClock.adjust(NetworkStallRecovery.NETWORK_SETTLE);

        const interrupt = yield* Queue.take(dispatched);
        const resume = yield* Queue.take(dispatched);
        assert.deepInclude(interrupt, {
          type: "run.interrupt",
          threadId: threadA,
          runId: runA,
          reason: NetworkStallRecovery.NETWORK_STALL_REASON,
        });
        assert.deepInclude(resume, {
          type: "message.dispatch",
          threadId: threadA,
          dispatchMode: { type: "queue_after_active" },
        });
        // Run B was silent at the snapshot but is rechecked, and kept, before any interrupt.
        assert.deepStrictEqual(yield* Queue.take(silenceChecks), [runA, true]);
        assert.deepStrictEqual(yield* Queue.take(silenceChecks), [runB, false]);
        assert.deepStrictEqual(yield* Queue.clear(dispatched), []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps local and delegated work, and stops only stalled model output", () =>
    Effect.gen(function* () {
      const earlierRun = RunId.make("run-network-earlier");
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly state: ThreadState;
        readonly stillSilent?: boolean;
        readonly outcome: NetworkStallRecovery.RecoverRunOutcome;
      }> = [
        {
          name: "background command from an earlier run",
          state: {
            runId: runA,
            activeItems: [
              { type: "reasoning", runId: runA },
              { type: "command_execution", runId: earlierRun },
            ],
          },
          outcome: "skipped",
        },
        {
          name: "pending approval",
          state: { runId: runA, activeItems: [{ type: "approval_request", runId: runA }] },
          outcome: "skipped",
        },
        {
          name: "compaction",
          state: { runId: runA, activeItems: [{ type: "compaction", runId: runA }] },
          outcome: "skipped",
        },
        { name: "waiting run", state: { runId: runA, status: "waiting" }, outcome: "skipped" },
        {
          name: "delegated completion cohort",
          state: { runId: runA, delegatedCompletion: true },
          outcome: "skipped",
        },
        {
          name: "delegated completion delivery",
          state: { runId: runA, delegatedMessage: true },
          outcome: "skipped",
        },
        { name: "app-owned task", state: { runId: runA, appOwnedTask: true }, outcome: "skipped" },
        {
          name: "resumed streaming",
          state: { runId: runA },
          stillSilent: false,
          outcome: "skipped",
        },
        {
          // A usage-limit failure leaves its error item running after the run fails.
          name: "failure notice left active by an earlier failed run",
          state: {
            runId: runA,
            endedRuns: [{ id: earlierRun, status: "failed" }],
            activeItems: [
              { type: "reasoning", runId: runA },
              { type: "error", runId: earlierRun },
            ],
          },
          outcome: "resumed",
        },
        {
          name: "approval left waiting by an earlier interrupted run",
          state: {
            runId: runA,
            endedRuns: [{ id: earlierRun, status: "interrupted" }],
            activeItems: [{ type: "approval_request", runId: earlierRun }],
          },
          outcome: "resumed",
        },
        {
          name: "provider error notice on the stalled run",
          state: { runId: runA, activeItems: [{ type: "error", runId: runA }] },
          outcome: "resumed",
        },
        {
          name: "streaming plan",
          state: { runId: runA, activeItems: [{ type: "proposed_plan", runId: runA }] },
          outcome: "resumed",
        },
        {
          name: "queued message survives the interrupt",
          state: { runId: runA, queued: [true, true] },
          outcome: "interrupted",
        },
        {
          name: "queued run cancelled by the interrupt",
          state: { runId: runA, queued: [true, false] },
          outcome: "resumed",
        },
      ];
      for (const testCase of cases) {
        const { outcome, commands } = yield* recover(testCase.state, testCase.stillSilent);
        assert.strictEqual(outcome, testCase.outcome, testCase.name);
        assert.deepStrictEqual(
          commands,
          {
            skipped: [],
            interrupted: ["run.interrupt"],
            resumed: ["run.interrupt", "message.dispatch"],
          }[testCase.outcome],
          testCase.name,
        );
      }
    }),
  );
});
