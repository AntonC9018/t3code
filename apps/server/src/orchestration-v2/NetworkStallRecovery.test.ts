import { assert, describe, it } from "@effect/vitest";
import {
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

const silentThread = ThreadId.make("thread-network-silent");
const silentRun = RunId.make("run-network-silent");
const liveThread = ThreadId.make("thread-network-live");
const liveRun = RunId.make("run-network-live");

type Records = Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;

const records = (input: {
  readonly runId: RunId;
  readonly status?: string;
  readonly activeItemTypes?: ReadonlyArray<string>;
  readonly queued?: boolean;
}) =>
  ({
    runs: [
      { id: input.runId, status: input.status ?? "running" },
      ...(input.queued === true ? [{ id: RunId.make("run-queued"), status: "queued" }] : []),
    ],
    turnItems: (input.activeItemTypes ?? ["reasoning"]).map((type) => ({ type })),
  }) as unknown as Records;

const layerThreads = (
  dispatched: Queue.Queue<OrchestrationV2ServerCommand>,
  recordsFor: (threadId: ThreadId) => Records,
) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (threadId) => Effect.succeed(recordsFor(threadId) as never),
    dispatch: (command) => Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
  });

describe("NetworkStallRecovery", () => {
  it.effect("interrupts and resumes only runs that stayed silent after the network settled", () =>
    Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const changes = yield* Queue.unbounded<number>();
      const liveness = yield* RunLiveness.make;
      const layer = NetworkStallRecovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              NetworkChangeMonitor.NetworkChangeMonitor,
              NetworkChangeMonitor.NetworkChangeMonitor.of({ changes: Stream.fromQueue(changes) }),
            ),
            Layer.succeed(RunLiveness.RunLiveness, liveness),
            layerThreads(dispatched, (threadId) =>
              records({ runId: threadId === liveThread ? liveRun : silentRun }),
            ),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        // The live run begins first, so it would be recovered first if it were selected.
        const live = yield* liveness.begin({ threadId: liveThread, runId: liveRun });
        yield* liveness.begin({ threadId: silentThread, runId: silentRun });
        yield* TestClock.adjust("1 second");
        yield* Queue.offer(changes, 1_000);
        yield* TestClock.adjust("5 seconds");
        yield* live.touch;
        yield* TestClock.adjust(NetworkStallRecovery.NETWORK_SETTLE);

        const interrupt = yield* Queue.take(dispatched);
        const resume = yield* Queue.take(dispatched);
        assert.deepInclude(interrupt, {
          type: "run.interrupt",
          threadId: silentThread,
          runId: silentRun,
          reason: NetworkStallRecovery.NETWORK_STALL_REASON,
        });
        assert.deepInclude(resume, {
          type: "message.dispatch",
          threadId: silentThread,
          dispatchMode: { type: "queue_after_active" },
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("leaves local work alone and lets a queued message resume", () =>
    Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const cases = [
        {
          records: records({ runId: silentRun, activeItemTypes: ["command_execution"] }),
          outcome: "skipped",
        },
        {
          records: records({ runId: silentRun, activeItemTypes: ["approval_request"] }),
          outcome: "skipped",
        },
        { records: records({ runId: silentRun, status: "waiting" }), outcome: "skipped" },
        { records: records({ runId: silentRun, queued: true }), outcome: "interrupted" },
      ] as const;
      for (const testCase of cases) {
        const recoverRun = yield* NetworkStallRecovery.makeRecoverRun.pipe(
          Effect.provide(layerThreads(dispatched, () => testCase.records)),
        );
        const outcome = yield* recoverRun({
          threadId: silentThread,
          runId: silentRun,
          changeAtMs: 1_000,
        });
        assert.strictEqual(outcome, testCase.outcome);
      }
      const commands = yield* Queue.takeAll(dispatched);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["run.interrupt"],
      );
    }),
  );
});
