import {
  ContextHandoffId,
  OrchestrationV2CompactContextError,
  ProviderThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RpcSchemas,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  historicalMessage,
  historySinceCustomCompaction,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventSink from "./EventSink.ts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

type Input = typeof OrchestrationV2RpcSchemas.compactContext.input.Type;
type EventBody<E = OrchestrationV2DomainEvent> = E extends OrchestrationV2DomainEvent
  ? Omit<E, "id" | "threadId" | "occurredAt">
  : never;

export class CustomCompactionService extends Context.Service<
  CustomCompactionService,
  { readonly compact: (input: Input) => Effect.Effect<void, OrchestrationV2CompactContextError> }
>()("t3/orchestration-v2/CustomCompactionService") {}

const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function snapshotIdentity(projection: OrchestrationV2ThreadProjection): string {
  return encodeSnapshot({
    thread: projection.thread,
    runs: projection.runs,
    providerThreads: projection.providerThreads,
    runtimeRequests: projection.runtimeRequests,
    subagents: projection.subagents,
    contextTransfers: projection.contextTransfers,
    turnItems: projection.turnItems.map((item) => [item.id, item.status, item.updatedAt]),
  });
}

function isBusy(projection: OrchestrationV2ThreadProjection): boolean {
  if (
    projection.runs.some(
      (run) =>
        !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status),
    )
  )
    return true;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return true;
  if (
    projection.subagents.some((task) =>
      ["idle", "pending", "running", "waiting"].includes(task.status),
    )
  )
    return true;
  if (projection.contextTransfers.some((transfer) => transfer.status === "pending")) return true;
  const latestRun = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
  return (
    latestRun !== undefined &&
    derivePendingBackgroundWork({
      latestRun,
      runs: projection.runs,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
    }).length > 0
  );
}

export function splitCompactionTranscript(text: string, byteLimit = 48_000): ReadonlyArray<string> {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > byteLimit && current.length > 0) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const layer = Layer.effect(
  CustomCompactionService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    // Serializing compactions avoids duplicate model calls; normal sends retain the thread command lock.
    const compactions = yield* KeyedLock.make<Input["threadId"]>();
    const pendingCompactions = yield* Ref.make(new Map<Input["threadId"], Input["commandId"]>());

    const compact = Effect.fn("CustomCompactionService.compact")(function* (input: Input) {
      const storage = (cause: unknown) =>
        new OrchestrationV2CompactContextError({
          threadId: input.threadId,
          reason: "storage",
          cause,
        });
      yield* Effect.acquireUseRelease(
        Ref.modify(
          pendingCompactions,
          (
            pending,
          ): readonly [
            { readonly allowed: boolean; readonly owner: boolean },
            Map<Input["threadId"], Input["commandId"]>,
          ] => {
            const active = pending.get(input.threadId);
            if (active !== undefined)
              return [{ allowed: active === input.commandId, owner: false }, pending] as const;
            return [
              { allowed: true, owner: true },
              new Map(pending).set(input.threadId, input.commandId),
            ] as const;
          },
        ),
        (acquired) =>
          acquired.allowed
            ? compactions.withLock(
                input.threadId,
                Effect.gen(function* () {
                  if (yield* threads.hasReceipt(input.commandId).pipe(Effect.mapError(storage)))
                    return;
                  const original = yield* executor.withLock(
                    input.threadId,
                    Effect.gen(function* () {
                      const projection = yield* threads
                        .getThreadProjection(input.threadId)
                        .pipe(Effect.mapError(storage));
                      if (isBusy(projection))
                        return yield* new OrchestrationV2CompactContextError({
                          threadId: input.threadId,
                          reason: "busy",
                        });
                      if (
                        projection.thread.deletedAt !== null ||
                        projection.thread.archivedAt !== null ||
                        projection.thread.lineage.relationshipToParent === "subagent"
                      ) {
                        return yield* new OrchestrationV2CompactContextError({
                          threadId: input.threadId,
                          reason: "unavailable",
                        });
                      }
                      yield* threads
                        .assertProviderInstanceEnabled({
                          projectId: projection.thread.projectId,
                          commandId: input.commandId,
                          instanceId: input.modelSelection.instanceId,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationV2CompactContextError({
                                threadId: input.threadId,
                                reason: "unavailable",
                                cause,
                              }),
                          ),
                        );
                      return projection;
                    }),
                  );
                  const currentProvider = original.providerThreads.find(
                    (candidate) => candidate.id === original.thread.activeProviderThreadId,
                  );
                  const latestRun = original.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
                  if (currentProvider === undefined || latestRun === undefined)
                    return yield* new OrchestrationV2CompactContextError({
                      threadId: input.threadId,
                      reason: "empty",
                    });
                  const transcript = historySinceCustomCompaction(original.turnItems, original.runs)
                    .flatMap((item) => {
                      const message = historicalMessage(item);
                      return message === null
                        ? []
                        : [
                            `[${message.role}; ${message.kind}; ${message.itemId}]\n${message.text}`,
                          ];
                    })
                    .join("\n\n");
                  if (transcript.trim().length === 0)
                    return yield* new OrchestrationV2CompactContextError({
                      threadId: input.threadId,
                      reason: "empty",
                    });
                  if (Buffer.byteLength(transcript) > 16_000_000)
                    return yield* new OrchestrationV2CompactContextError({
                      threadId: input.threadId,
                      reason: "too_large",
                    });
                  const project = yield* projects
                    .get(original.thread.projectId)
                    .pipe(Effect.mapError(storage));
                  if (Option.isNone(project))
                    return yield* new OrchestrationV2CompactContextError({
                      threadId: input.threadId,
                      reason: "unavailable",
                    });
                  let pending = splitCompactionTranscript(transcript);
                  let summary = "";
                  for (let pass = 0; pass < 8; pass++) {
                    const summaries = yield* Effect.forEach(
                      pending,
                      (part) =>
                        textGeneration
                          .generateContextSummary({
                            cwd: original.thread.worktreePath ?? project.value.workspaceRoot,
                            modelSelection: input.modelSelection,
                            transcript: part,
                          })
                          .pipe(
                            Effect.map((result) => result.summary),
                            Effect.mapError(
                              (cause) =>
                                new OrchestrationV2CompactContextError({
                                  threadId: input.threadId,
                                  reason: "generation",
                                  cause,
                                }),
                            ),
                          ),
                      { concurrency: 1 },
                    );
                    if (summaries.length === 1 && Buffer.byteLength(summaries[0]!) <= 12_000) {
                      summary = summaries[0]!;
                      break;
                    }
                    pending = splitCompactionTranscript(
                      summaries
                        .map((part, index) => `[Summary ${index + 1}]\n${part}`)
                        .join("\n\n"),
                    );
                  }
                  if (summary.trim().length === 0 || Buffer.byteLength(summary) > 12_000)
                    return yield* new OrchestrationV2CompactContextError({
                      threadId: input.threadId,
                      reason: "generation",
                    });
                  yield* executor.withLock(
                    input.threadId,
                    Effect.gen(function* () {
                      if (yield* threads.hasReceipt(input.commandId).pipe(Effect.mapError(storage)))
                        return;
                      const fresh = yield* threads
                        .getThreadProjection(input.threadId)
                        .pipe(Effect.mapError(storage));
                      if (isBusy(fresh) || snapshotIdentity(fresh) !== snapshotIdentity(original))
                        return yield* new OrchestrationV2CompactContextError({
                          threadId: input.threadId,
                          reason: "changed",
                        });
                      const now = yield* DateTime.now;
                      const nextRunId = ids.derive.run({
                        threadId: input.threadId,
                        ordinal: latestRun.ordinal + 1,
                      });
                      const providerThreadId = ProviderThreadId.make(
                        `compaction:${input.commandId}`,
                      );
                      const handoffId = ContextHandoffId.make(`compaction:${input.commandId}`);
                      const fromProviderThreadIds = [currentProvider.id];
                      const events: OrchestrationV2DomainEvent[] = [];
                      const event = Effect.fn("CustomCompactionService.event")(function* (
                        body: EventBody,
                      ) {
                        events.push({
                          ...body,
                          id: yield* ids.allocate
                            .event({ threadId: input.threadId, commandId: input.commandId })
                            .pipe(Effect.mapError(storage)),
                          threadId: input.threadId,
                          occurredAt: now,
                        });
                      });
                      const effects: PendingOrchestrationEffectV2[] = [];
                      for (const previous of original.providerThreads.filter(
                        (thread) =>
                          thread.ownerNodeId === null && thread.compactionSuperseded !== true,
                      )) {
                        yield* event({
                          type: "provider-thread.updated",
                          payload: { ...previous, compactionSuperseded: true, updatedAt: now },
                        });
                      }
                      for (const session of original.providerSessions.filter(
                        (session) => session.status !== "stopped" && session.status !== "error",
                      )) {
                        yield* event({
                          type: "provider-session.detached",
                          payload: {
                            providerSessionId: session.id,
                            detachedAt: now,
                            reason: "Context compacted with another model.",
                          },
                        });
                        effects.push({
                          id: `effect:${input.commandId}:provider-session.detach:${session.id}`,
                          commandId: input.commandId,
                          threadId: input.threadId,
                          request: {
                            type: "provider-session.detach",
                            providerSessionId: session.id,
                          },
                        });
                      }
                      yield* event({
                        type: "provider-thread.updated",
                        payload: {
                          id: providerThreadId,
                          driver: currentProvider.driver,
                          providerInstanceId: original.thread.providerInstanceId,
                          providerSessionId: null,
                          appThreadId: input.threadId,
                          ownerNodeId: null,
                          nativeThreadRef: null,
                          nativeConversationHeadRef: null,
                          status: "not_loaded",
                          firstRunOrdinal: latestRun.ordinal + 1,
                          lastRunOrdinal: latestRun.ordinal + 1,
                          handoffIds: [handoffId],
                          forkedFrom: null,
                          contextUsage: null,
                          nativeMetadata: null,
                          createdAt: now,
                          updatedAt: now,
                        },
                      });
                      yield* event({
                        type: "context-handoff.updated",
                        payload: {
                          id: handoffId,
                          threadId: input.threadId,
                          targetRunId: nextRunId,
                          fromProviderThreadIds,
                          toProviderThreadId: providerThreadId,
                          coveredRunOrdinals: { from: 1, to: latestRun.ordinal },
                          strategy: "manual_context",
                          status: "ready",
                          summaryMessageId: null,
                          summaryText: summary,
                          compactionModelSelection: input.modelSelection,
                          detailInTurnItem: true,
                          createdByProviderInstanceId: input.modelSelection.instanceId,
                          createdAt: now,
                          updatedAt: now,
                        },
                      });
                      yield* event({
                        type: "turn-item.updated",
                        runId: latestRun.id,
                        payload: {
                          id: TurnItemId.make(`compaction:${input.commandId}`),
                          threadId: input.threadId,
                          runId: latestRun.id,
                          nodeId: latestRun.rootNodeId,
                          providerThreadId,
                          providerTurnId: null,
                          nativeItemRef: null,
                          parentItemId: null,
                          ordinal:
                            original.turnItems.reduce(
                              (max, item) => Math.max(max, item.ordinal),
                              0,
                            ) + 1,
                          status: "completed",
                          title: null,
                          startedAt: now,
                          completedAt: now,
                          updatedAt: now,
                          type: "handoff",
                          contextHandoffId: handoffId,
                          fromProviderThreadIds,
                          toProviderThreadId: providerThreadId,
                          fromProviderInstanceIds: [original.thread.providerInstanceId],
                          toProviderInstanceId: original.thread.providerInstanceId,
                          fromModelSelections: [original.thread.modelSelection],
                          toModel: original.thread.modelSelection.model,
                          compactionModelSelection: input.modelSelection,
                          strategy: "manual_context",
                          summary,
                        },
                      });
                      yield* sink
                        .commitCommand({
                          commandId: input.commandId,
                          threadId: input.threadId,
                          commandType: "thread.context.compact",
                          acceptedAt: now,
                          events,
                          effects,
                        })
                        .pipe(Effect.mapError(storage));
                    }),
                  );
                }),
              )
            : Effect.fail(
                new OrchestrationV2CompactContextError({
                  threadId: input.threadId,
                  reason: "busy",
                }),
              ),
        (acquired) =>
          acquired.owner
            ? Ref.update(pendingCompactions, (pending) => {
                const next = new Map(pending);
                next.delete(input.threadId);
                return next;
              })
            : Effect.void,
      );
    });
    return CustomCompactionService.of({ compact });
  }),
);
