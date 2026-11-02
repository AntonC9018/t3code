import {
  ContextHandoffId,
  OrchestrationV2CompactContextError,
  ProviderThreadId,
  TurnItemId,
  type OrchestrationV2CompactionProgress,
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
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import {
  historicalMessage,
  historySinceCustomCompaction,
  sinceLastCustomCompaction,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

type Input = typeof OrchestrationV2RpcSchemas.compactContext.input.Type;
type CancelInput = typeof OrchestrationV2RpcSchemas.cancelCompaction.input.Type;
type Target = typeof OrchestrationV2RpcSchemas.subscribeCompaction.input.Type;
type EventBody<E = OrchestrationV2DomainEvent> = E extends OrchestrationV2DomainEvent
  ? Omit<E, "id" | "threadId" | "occurredAt">
  : never;

export class CustomCompactionService extends Context.Service<
  CustomCompactionService,
  {
    readonly compact: (input: Input) => Effect.Effect<void, OrchestrationV2CompactContextError>;
    /** Stops a running compaction; nothing is written until its summary is committed. */
    readonly cancel: (input: CancelInput) => Effect.Effect<void>;
    /** The thread's running compaction, or null when none is running. */
    readonly subscribe: (input: Target) => Stream.Stream<OrchestrationV2CompactionProgress | null>;
  }
>()("t3/orchestration-v2/CustomCompactionService") {}

const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What the summary was built from; read tracking, pins and PR snapshots must not void it. */
function snapshotIdentity(projection: OrchestrationV2ThreadProjection): string {
  const { thread } = projection;
  return encodeSnapshot({
    thread: [
      thread.activeProviderThreadId,
      thread.providerInstanceId,
      thread.modelSelection,
      thread.archivedAt,
      thread.deletedAt,
    ],
    runs: projection.runs.map((run) => [run.id, run.status]),
    providerThreads: projection.providerThreads.map((providerThread) => [
      providerThread.id,
      providerThread.nativeThreadRef,
      providerThread.nativeConversationHeadRef,
      providerThread.compactionSuperseded,
    ]),
    contextTransfers: projection.contextTransfers.map((transfer) => [transfer.id, transfer.status]),
    contextHandoffs: projection.contextHandoffs.map((handoff) => [handoff.id, handoff.status]),
    turnItems: projection.visibleTurnItems.map(({ item }) => [
      item.id,
      item.status,
      item.updatedAt,
    ]),
  });
}

/** Inherited fork history, then local history, from the latest compaction boundary on. */
function compactionHistory(projection: OrchestrationV2ThreadProjection) {
  const local = historySinceCustomCompaction(projection.turnItems, projection.runs);
  const first = local[0];
  if (first?.type === "handoff" && first.compactionModelSelection !== undefined) return local;
  const inherited = projection.visibleTurnItems
    .filter((row) => row.visibility === "inherited")
    .map((row) => row.item);
  return [...sinceLastCustomCompaction(inherited), ...local];
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

type CompactError = OrchestrationV2CompactContextError;

function compactError(
  input: Input,
  reason: CompactError["reason"],
  cause?: unknown,
): OrchestrationV2CompactContextError {
  return new OrchestrationV2CompactContextError({
    threadId: input.threadId,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

function compactionTranscript(projection: OrchestrationV2ThreadProjection): string {
  return compactionHistory(projection)
    .flatMap((item) => {
      const message = historicalMessage(item);
      return message === null
        ? []
        : [`[${message.role}; ${message.kind}; ${message.itemId}]\n${message.text}`];
    })
    .join("\n\n");
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
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const scope = yield* Effect.scope;
    // At most one compaction per thread. It runs in the service scope, so a client that closes the
    // menu, navigates away or disconnects does not cancel it; callers only wait for its result.
    const running = yield* Ref.make(
      new Map<
        Input["threadId"],
        {
          readonly commandId: Input["commandId"];
          readonly done: Deferred.Deferred<void, CompactError>;
          readonly fiber: Fiber.Fiber<void, CompactError> | null;
        }
      >(),
    );
    // Untouched entries keep their identity, so subscribers can skip unrelated updates.
    const progress = yield* SubscriptionRef.make<
      ReadonlyMap<Input["threadId"], OrchestrationV2CompactionProgress>
    >(new Map());
    const reportProgress = (
      input: Input,
      step: Pick<OrchestrationV2CompactionProgress, "pass" | "completedParts" | "totalParts">,
    ) =>
      SubscriptionRef.update(progress, (map) =>
        new Map(map).set(input.threadId, {
          commandId: input.commandId,
          modelSelection: input.modelSelection,
          ...step,
        }),
      );
    const clearProgress = (input: Input) =>
      SubscriptionRef.update(progress, (map) => {
        if (map.get(input.threadId)?.commandId !== input.commandId) return map;
        const next = new Map(map);
        next.delete(input.threadId);
        return next;
      });

    /** Validates the idle thread under the command lock and returns the snapshot to summarize. */
    const readCompactableThread = Effect.fn("CustomCompactionService.readCompactableThread")(
      function* (input: Input) {
        const storage = (cause: unknown) => compactError(input, "storage", cause);
        return yield* executor.withLock(
          input.threadId,
          Effect.gen(function* () {
            const projection = yield* threads
              .getThreadProjection(input.threadId)
              .pipe(Effect.mapError(storage));
            if (isBusy(projection)) return yield* compactError(input, "busy");
            if (
              projection.thread.deletedAt !== null ||
              projection.thread.archivedAt !== null ||
              projection.thread.lineage.relationshipToParent === "subagent"
            ) {
              return yield* compactError(input, "unavailable");
            }
            yield* threads
              .assertProviderInstanceEnabled({
                projectId: projection.thread.projectId,
                commandId: input.commandId,
                instanceId: input.modelSelection.instanceId,
              })
              .pipe(Effect.mapError((cause) => compactError(input, "unavailable", cause)));
            return projection;
          }),
        );
      },
    );

    /** Summarizes in bounded chunks, then summarizes the summaries until one fits. */
    const summarize = Effect.fn("CustomCompactionService.summarize")(function* (
      input: Input,
      cwd: string,
      transcript: string,
    ) {
      let pending = splitCompactionTranscript(transcript);
      for (let pass = 0; pass < 8; pass++) {
        const totalParts = pending.length;
        const summaries = yield* Effect.forEach(
          pending,
          (part, completedParts) =>
            reportProgress(input, { pass: pass + 1, completedParts, totalParts }).pipe(
              Effect.andThen(
                textGeneration.generateContextSummary({
                  cwd,
                  modelSelection: input.modelSelection,
                  transcript: part,
                }),
              ),
              // One malformed or slow answer should not discard the parts already summarized.
              Effect.retry({ times: 1 }),
              Effect.map((result) => result.summary),
              Effect.mapError((cause) => compactError(input, "generation", cause)),
            ),
          { concurrency: 1 },
        );
        const only = summaries.length === 1 ? summaries[0]! : null;
        if (only !== null && Buffer.byteLength(only) <= 12_000) {
          if (only.trim().length === 0) break;
          return only;
        }
        pending = splitCompactionTranscript(
          summaries.map((part, index) => `[Summary ${index + 1}]\n${part}`).join("\n\n"),
        );
      }
      return yield* compactError(input, "generation");
    });

    /** Replaces provider context with the summary, unless the thread changed meanwhile. */
    const commitCompaction = Effect.fn("CustomCompactionService.commitCompaction")(function* (
      input: Input,
      original: OrchestrationV2ThreadProjection,
      summary: string,
    ) {
      const storage = (cause: unknown) => compactError(input, "storage", cause);
      const { driver } = yield* adapters
        .get(original.thread.providerInstanceId)
        .pipe(Effect.mapError((cause) => compactError(input, "unavailable", cause)));
      yield* executor.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (yield* threads.hasReceipt(input.commandId).pipe(Effect.mapError(storage))) return;
          const fresh = yield* threads
            .getThreadProjection(input.threadId)
            .pipe(Effect.mapError(storage));
          if (isBusy(fresh) || snapshotIdentity(fresh) !== snapshotIdentity(original))
            return yield* compactError(input, "changed");
          const currentProvider = fresh.providerThreads.find(
            (candidate) => candidate.id === fresh.thread.activeProviderThreadId,
          )!;
          const latestRun = fresh.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
          const now = yield* DateTime.now;
          const nextRunId = ids.derive.run({
            threadId: input.threadId,
            ordinal: latestRun.ordinal + 1,
          });
          const providerThreadId = ProviderThreadId.make(`compaction:${input.commandId}`);
          const handoffId = ContextHandoffId.make(`compaction:${input.commandId}`);
          const fromProviderThreadIds = [currentProvider.id];
          const events: OrchestrationV2DomainEvent[] = [];
          const event = Effect.fn("CustomCompactionService.event")(function* (body: EventBody) {
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
          for (const previous of fresh.providerThreads.filter(
            (thread) => thread.ownerNodeId === null && thread.compactionSuperseded !== true,
          )) {
            yield* event({
              type: "provider-thread.updated",
              payload: { ...previous, compactionSuperseded: true, updatedAt: now },
            });
          }
          for (const session of fresh.providerSessions.filter(
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
              request: { type: "provider-session.detach", providerSessionId: session.id },
            });
          }
          yield* event({
            type: "provider-thread.updated",
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: fresh.thread.providerInstanceId,
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
              ordinal: fresh.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0) + 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "handoff",
              contextHandoffId: handoffId,
              fromProviderThreadIds,
              toProviderThreadId: providerThreadId,
              fromProviderInstanceIds: [currentProvider.providerInstanceId],
              toProviderInstanceId: fresh.thread.providerInstanceId,
              // The history was produced by the last run, even if the thread switched models since.
              fromModelSelections: [latestRun.modelSelection],
              toModel: fresh.thread.modelSelection.model,
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
    });

    const runCompaction = Effect.fn("CustomCompactionService.run")(function* (input: Input) {
      const storage = (cause: unknown) => compactError(input, "storage", cause);
      if (yield* threads.hasReceipt(input.commandId).pipe(Effect.mapError(storage))) return;
      const original = yield* readCompactableThread(input);
      const hasProvider = original.providerThreads.some(
        (candidate) => candidate.id === original.thread.activeProviderThreadId,
      );
      if (!hasProvider || original.runs.length === 0) return yield* compactError(input, "empty");
      const transcript = compactionTranscript(original);
      if (transcript.trim().length === 0) return yield* compactError(input, "empty");
      if (Buffer.byteLength(transcript) > 16_000_000)
        return yield* compactError(input, "too_large");
      const project = yield* projects.get(original.thread.projectId).pipe(Effect.mapError(storage));
      if (Option.isNone(project)) return yield* compactError(input, "unavailable");
      const summary = yield* summarize(
        input,
        original.thread.worktreePath ?? project.value.workspaceRoot,
        transcript,
      );
      yield* Effect.uninterruptible(commitCompaction(input, original, summary));
    });

    /** A cancel that lands during the commit cannot undo it, so the receipt decides the outcome. */
    const settle = (input: Input, exit: Exit.Exit<void, CompactError>) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? threads
            .hasReceipt(input.commandId)
            .pipe(
              Effect.map((committed) =>
                committed ? Exit.void : Exit.fail(compactError(input, "cancelled")),
              ),
            )
        : Effect.succeed(exit);

    const compact = Effect.fn("CustomCompactionService.compact")(function* (input: Input) {
      const done = yield* Deferred.make<void, CompactError>();
      // Registering and forking must not be split by an interrupt, or the slot would leak.
      const joined = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const active = yield* Ref.modify(running, (map) => {
            const current = map.get(input.threadId);
            if (current !== undefined)
              return [current.commandId === input.commandId ? current.done : null, map] as const;
            return [
              undefined,
              new Map(map).set(input.threadId, { commandId: input.commandId, done, fiber: null }),
            ] as const;
          });
          if (active !== undefined) return active;
          yield* reportProgress(input, { pass: 1, completedParts: 0, totalParts: 0 });
          const fiber = yield* runCompaction(input).pipe(
            Effect.onExit((exit) =>
              Ref.update(running, (map) => {
                if (map.get(input.threadId)?.done !== done) return map;
                const next = new Map(map);
                next.delete(input.threadId);
                return next;
              }).pipe(
                Effect.andThen(clearProgress(input)),
                Effect.andThen(settle(input, exit)),
                Effect.flatMap((result) => Deferred.done(done, result)),
              ),
            ),
            Effect.forkIn(scope),
          );
          yield* Ref.update(running, (map) => {
            const current = map.get(input.threadId);
            return current?.done === done
              ? new Map(map).set(input.threadId, { ...current, fiber })
              : map;
          });
          return done;
        }),
      );
      if (joined === null) return yield* compactError(input, "in_progress");
      yield* Deferred.await(joined);
    });

    const cancel = Effect.fn("CustomCompactionService.cancel")(function* (input: CancelInput) {
      const current = (yield* Ref.get(running)).get(input.threadId);
      if (current?.commandId !== input.commandId || current.fiber === null) return;
      yield* Fiber.interrupt(current.fiber);
    });

    const subscribe = (input: Target) =>
      SubscriptionRef.changes(progress).pipe(
        Stream.map((map) => map.get(input.threadId) ?? null),
        Stream.changesWith((left, right) => left === right),
      );

    return CustomCompactionService.of({ compact, cancel, subscribe });
  }),
);
