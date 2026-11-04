import {
  CommandId,
  MessageId,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as NetworkChangeMonitor from "../network/NetworkChangeMonitor.ts";
import * as RunLiveness from "./RunLiveness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** How long the network must stay unchanged, with the run silent, before recovery. */
export const NETWORK_SETTLE = Duration.seconds(20);

export const NETWORK_STALL_REASON =
  "Interrupted after a network change left the provider connection silent.";

const CONTINUE_TEXT =
  "The connection to the model was lost after a network change. Continue where you left off.";

/** Active items that only the model stream advances; anything else is local work to keep. */
const STREAM_ONLY_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "assistant_message",
  "reasoning",
  "todo_list",
  "notification",
  "system_notice",
  "user_message",
]);

export const makeRecoverRun = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  return Effect.fn("NetworkStallRecovery.recoverRun")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly changeAtMs: number;
  }) {
    const records = yield* threads.getThreadRecords(input.threadId, ["runs", "turnItems"], {
      turnItemRunIds: [input.runId],
      turnItemStatuses: ["pending", "running", "waiting"],
    });
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    if (run?.status !== "running") return "skipped" as const;
    const localWork = records.turnItems.find((item) => !STREAM_ONLY_ITEM_TYPES.has(item.type));
    if (localWork !== undefined) {
      yield* Effect.logInfo("orchestration-v2.network-stall.local-work", {
        threadId: input.threadId,
        runId: input.runId,
        itemType: localWork.type,
      });
      return "skipped" as const;
    }
    const identity = `${input.runId}:${input.changeAtMs}`;
    yield* threads.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`network-stall-interrupt:${identity}`),
      threadId: input.threadId,
      runId: input.runId,
      reason: NETWORK_STALL_REASON,
    });
    // A message the user already queued resumes the thread on its own.
    if (records.runs.some((candidate) => candidate.status === "queued")) {
      return "interrupted" as const;
    }
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`network-stall-resume:${identity}`),
      messageId: MessageId.make(`network-stall-resume:${identity}`),
      threadId: input.threadId,
      text: CONTINUE_TEXT,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "server",
    });
    return "resumed" as const;
  });
});

/**
 * Providers keep a turn waiting on an upstream stream that died with a network change
 * (Codex waits 300 s by default). Once the network settles, interrupt runs that stayed
 * silent and resume them, as Stop + Continue would.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const monitor = yield* NetworkChangeMonitor.NetworkChangeMonitor;
    const liveness = yield* RunLiveness.RunLiveness;
    const recoverRun = yield* makeRecoverRun;

    const recoverAfter = Effect.fn("NetworkStallRecovery.recoverAfter")(function* (
      changeAtMs: number,
    ) {
      const silent = yield* liveness.silentSince(changeAtMs);
      if (silent.length === 0) return;
      yield* Effect.logInfo("orchestration-v2.network-stall.detected", {
        runs: silent.map((entry) => entry.runId),
      });
      yield* Effect.forEach(
        silent,
        (entry) =>
          recoverRun({ threadId: entry.threadId, runId: entry.runId, changeAtMs }).pipe(
            Effect.tap((outcome) =>
              Effect.logInfo("orchestration-v2.network-stall.recovered", {
                threadId: entry.threadId,
                runId: entry.runId,
                outcome,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.network-stall.recovery-failed", {
                threadId: entry.threadId,
                runId: entry.runId,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
    });

    yield* monitor.changes.pipe(
      Stream.debounce(NETWORK_SETTLE),
      Stream.runForEach(recoverAfter),
      Effect.forkScoped,
    );
  }),
);
