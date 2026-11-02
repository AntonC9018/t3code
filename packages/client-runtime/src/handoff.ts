import type {
  ModelSelection,
  OrchestrationV2CompactionProgress,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { isTransportConnectionErrorMessage } from "./errors/transport.ts";
import type { ThreadStructure } from "./state/models.ts";

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

export function resolvePendingHandoff(
  projection: ThreadStructure | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  // The handoff row is committed before the provider starts. Use its destination
  // during startup so the footer does not duplicate the committed handoff.
  const from = projection.runs.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId !== selection.instanceId &&
    (source?.continuation?.groupKey === undefined ||
      source.driver !== target?.driver ||
      source.continuation.groupKey !== target.continuation?.groupKey);
  return needsHandoff ? { from: [from], to: selection } : null;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    | "runId"
    | "fromModelSelections"
    | "fromProviderInstanceIds"
    | "toModel"
    | "toProviderInstanceId"
    | "compactionModelSelection"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return {
    from: fromEndpoints,
    to: { instanceId: item.toProviderInstanceId, model: toModel },
    ...(item.compactionModelSelection ? { via: item.compactionModelSelection } : {}),
  };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/**
 * Compaction runs on the server even when the waiting client disconnects, so a lost connection
 * does not mean it failed; retrying with the same command id rejoins the running compaction.
 */
export function describeCustomCompactionFailure(cause: unknown): {
  readonly message: string;
  readonly connectionLost: boolean;
  readonly cancelled: boolean;
} {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : "";
  const message = cause instanceof Error ? cause.message : "";
  const cancelled =
    tag === "OrchestrationV2CompactContextError" &&
    (cause as { readonly reason?: unknown }).reason === "cancelled";
  if (
    message.length > 0 &&
    !isTransportConnectionErrorMessage(`${tag} ${message}`) &&
    !isTransportConnectionErrorMessage(message)
  ) {
    return { message, connectionLost: false, cancelled };
  }
  return {
    message:
      "Lost the connection while waiting. The compaction may still finish; check the timeline.",
    connectionLost: true,
    cancelled: false,
  };
}

export function describeCompactionProgress(progress: OrchestrationV2CompactionProgress): string {
  if (progress.totalParts === 0) return "Reading the conversation…";
  const part = Math.min(progress.completedParts + 1, progress.totalParts);
  const step = `part ${part} of ${progress.totalParts}`;
  return progress.pass === 1 ? `Summarizing ${step}…` : `Merging summaries, ${step}…`;
}
