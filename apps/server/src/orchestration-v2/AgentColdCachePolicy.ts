import { CommandId, type OrchestrationV2CompactContextError } from "@t3tools/contracts";
import {
  deriveSendPromptCacheStatus,
  promptCacheNeedsAcknowledgement,
} from "@t3tools/shared/promptCache";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as CustomCompaction from "./CustomCompactionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type Send = ThreadManagement.ThreadManagementServiceShape["sendToThread"];

/**
 * `sendToThread` serves only agents and scheduled tasks, which have nobody to confirm an
 * uncached Claude read; `agentColdCachePolicy` decides instead. Wraps the base service.
 */
export const layer = Layer.effect(
  ThreadManagement.ThreadManagementService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const compaction = yield* CustomCompaction.CustomCompactionService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const sendToThread: Send = Effect.fn("AgentColdCachePolicy.sendToThread")(function* (input) {
      if (input.allowUncachedRead === true) return yield* threads.sendToThread(input);
      const records = yield* threads.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerTurns",
        "attempts",
        "runs",
      ]);
      const status = deriveSendPromptCacheStatus({
        thread: records.thread,
        providerThreads: records.providerThreads,
        providerTurns: records.providerTurns,
        attempts: records.attempts,
        runs: records.runs,
        modelSelection: input.modelSelection ?? records.thread.modelSelection,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      });
      if (!promptCacheNeedsAcknowledgement(status)) return yield* threads.sendToThread(input);
      const cold = (detail: string) =>
        new ThreadManagement.ThreadManagementPromptCacheColdError({
          threadId: input.threadId,
          cacheStatus: status.state === "expired" ? "expired" : "unknown",
          detail,
        });
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      switch (settings.agentColdCachePolicy) {
        case "allow":
          return yield* threads.sendToThread({ ...input, allowUncachedRead: true });
        case "block":
          return yield* cold(
            "Agent sends to cold Claude threads are blocked in settings. Ask the user to compact the thread or send the message themselves.",
          );
        case "compact": {
          const modelSelection = settings.customCompactionModelSelection;
          if (modelSelection === null)
            return yield* cold(
              "Agent sends compact cold threads first, but no compaction model is selected in settings.",
            );
          yield* compaction
            .compact({
              threadId: input.threadId,
              // Derived so a retried send reuses the compaction it already committed.
              commandId: CommandId.make(`${input.commandId}:compact`),
              modelSelection,
            })
            .pipe(
              Effect.mapError((error: OrchestrationV2CompactContextError) =>
                cold(
                  error.reason === "busy"
                    ? "Compaction cannot start while the thread has active or background work. Retry after it finishes, or ask the user to send the message."
                    : error.reason === "in_progress"
                      ? "The thread is already being compacted. Retry after that compaction finishes."
                      : `Compacting it first failed: ${error.message}`,
                ),
              ),
            );
          return yield* threads.sendToThread(input);
        }
      }
    });

    return { ...threads, sendToThread };
  }),
);
