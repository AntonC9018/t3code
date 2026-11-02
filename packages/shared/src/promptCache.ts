import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { draftModelPickMatchesThread } from "./model.ts";

export type PromptCacheStatus = {
  readonly state: "fresh" | "warm" | "expiring" | "expired" | "unknown" | "unsupported";
  readonly expiresAtMs?: number;
  readonly remainingMs?: number;
};

/**
 * Whether two selections share a Claude prompt cache. Clients differ on whether they send
 * `fastMode: false` or omit it, so off counts as unset, as it does for composer drafts.
 */
export function samePromptCacheSelection(left: ModelSelection, right: ModelSelection): boolean {
  return draftModelPickMatchesThread(left, right);
}

export function derivePromptCacheStatus(input: {
  readonly driver: string | undefined;
  readonly usage?:
    | Pick<OrchestrationV2ProviderTurnTokenUsage, "promptCacheExpiresAt" | "promptCacheTtlMs">
    | null
    | undefined;
  readonly nowMs: number;
  readonly hasContext: boolean;
}): PromptCacheStatus {
  if (input.driver !== "claudeAgent") return { state: "unsupported" };
  if (!input.hasContext) return { state: "fresh" };
  const expiresAtMs = Date.parse(input.usage?.promptCacheExpiresAt ?? "");
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(input.nowMs)) return { state: "unknown" };
  const remainingMs = Math.max(0, expiresAtMs - input.nowMs);
  const warningMs = Math.min(5 * 60_000, (input.usage?.promptCacheTtlMs ?? 25 * 60_000) / 5);
  return {
    state: remainingMs === 0 ? "expired" : remainingMs <= warningMs ? "expiring" : "warm",
    expiresAtMs,
    remainingMs,
  };
}

export function deriveThreadPromptCacheStatus(input: {
  readonly providerThread?: Pick<
    OrchestrationV2ProviderThread,
    "id" | "driver" | "nativeThreadRef" | "contextUsage" | "forkedFrom"
  > | null;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "runAttemptId" | "nodeId" | "tokenUsage">
  >;
  readonly attempts: ReadonlyArray<
    Pick<
      OrchestrationV2RunAttempt,
      "id" | "runId" | "nativeThreadId" | "providerThreadId" | "rootNodeId" | "providerTurnId"
    >
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "modelSelection">>;
  readonly modelSelection: ModelSelection;
  readonly nowMs: number;
}): PromptCacheStatus {
  const thread = input.providerThread;
  if (thread === undefined || thread === null) return { state: "fresh" };
  const nativeId = thread.nativeThreadRef?.nativeId;
  if (nativeId == null) {
    return derivePromptCacheStatus({
      driver: thread.driver,
      hasContext: false,
      nowMs: input.nowMs,
    });
  }
  const attempts = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  let latest: (typeof input.providerTurns)[number] | undefined;
  let latestRun: (typeof input.runs)[number] | undefined;
  for (const turn of input.providerTurns) {
    if (turn.providerThreadId !== thread.id || turn.runAttemptId === null) continue;
    const attempt = attempts.get(turn.runAttemptId);
    if (attempt?.providerThreadId !== thread.id || attempt.rootNodeId !== turn.nodeId) continue;
    // A reused provider-thread row must not revive the previous native conversation's cache.
    if (attempt.nativeThreadId !== nativeId) continue;
    const run = runs.get(attempt.runId);
    // Native compaction and fully cached replies report usage without an expiry. They do not
    // invalidate the shared prefix, so the last expiry the provider reported still applies.
    if (run === undefined || turn.tokenUsage?.promptCacheExpiresAt === undefined) continue;
    if (
      latest?.tokenUsage &&
      Date.parse(latest.tokenUsage.updatedAt) > Date.parse(turn.tokenUsage.updatedAt)
    )
      continue;
    latest = turn;
    latestRun = run;
  }
  const threadAttempts = input.attempts.filter((attempt) => attempt.providerThreadId === thread.id);
  // Forked and imported conversations carry history that no local attempt produced.
  const hasContext =
    (thread.contextUsage?.usedTokens ?? 0) > 0 ||
    latest !== undefined ||
    thread.forkedFrom !== null ||
    threadAttempts.length === 0 ||
    threadAttempts.some(
      (attempt) =>
        attempt.providerTurnId !== null &&
        (attempt.nativeThreadId === undefined || attempt.nativeThreadId === nativeId),
    );
  const sameSelection =
    latestRun && samePromptCacheSelection(latestRun.modelSelection, input.modelSelection);
  return derivePromptCacheStatus({
    driver: thread.driver,
    usage: sameSelection ? latest?.tokenUsage : undefined,
    hasContext,
    nowMs: input.nowMs,
  });
}

type ProviderThreadCandidate = Pick<
  OrchestrationV2ProviderThread,
  | "id"
  | "driver"
  | "nativeThreadRef"
  | "contextUsage"
  | "forkedFrom"
  | "providerInstanceId"
  | "compactionSuperseded"
  | "appThreadId"
  | "ownerNodeId"
  | "lastRunOrdinal"
  | "updatedAt"
>;

/** Root conversations a thread can resume on an instance, most recently used first. */
export function rootProviderThreadsForInstance<Thread extends ProviderThreadCandidate>(
  providerThreads: ReadonlyArray<Thread>,
  threadId: string,
  instanceId: ModelSelection["instanceId"],
): ReadonlyArray<Thread> {
  return providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === instanceId &&
        providerThread.compactionSuperseded !== true &&
        providerThread.appThreadId === threadId &&
        providerThread.ownerNodeId === null,
    )
    .sort(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

/** Cache status of the conversation a message with `modelSelection` would resume. */
export function deriveSendPromptCacheStatus(
  input: Omit<Parameters<typeof deriveThreadPromptCacheStatus>[0], "providerThread"> & {
    readonly thread: { readonly id: string; readonly activeProviderThreadId: string | null };
    readonly providerThreads: ReadonlyArray<ProviderThreadCandidate>;
  },
): PromptCacheStatus {
  const active = input.providerThreads.find(
    (candidate) => candidate.id === input.thread.activeProviderThreadId,
  );
  const providerThread =
    active?.providerInstanceId === input.modelSelection.instanceId
      ? active
      : rootProviderThreadsForInstance(
          input.providerThreads,
          input.thread.id,
          input.modelSelection.instanceId,
        )[0];
  return deriveThreadPromptCacheStatus({ ...input, providerThread: providerThread ?? null });
}

export function promptCacheNeedsAcknowledgement(status: PromptCacheStatus): boolean {
  return status.state === "expired" || status.state === "unknown";
}
