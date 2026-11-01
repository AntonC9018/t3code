import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "./model.ts";

export type PromptCacheStatus = {
  readonly state: "fresh" | "warm" | "expiring" | "expired" | "unknown" | "unsupported";
  readonly expiresAtMs?: number;
  readonly remainingMs?: number;
};

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
    "id" | "driver" | "nativeThreadRef" | "contextUsage"
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
    if (run === undefined || !turn.tokenUsage) continue;
    if (
      latest?.tokenUsage &&
      Date.parse(latest.tokenUsage.updatedAt) > Date.parse(turn.tokenUsage.updatedAt)
    )
      continue;
    latest = turn;
    latestRun = run;
  }
  const hasContext =
    (thread.contextUsage?.usedTokens ?? 0) > 0 ||
    latest !== undefined ||
    input.attempts.some(
      (attempt) =>
        attempt.providerThreadId === thread.id &&
        attempt.providerTurnId !== null &&
        (attempt.nativeThreadId === undefined || attempt.nativeThreadId === nativeId),
    );
  const sameSelection =
    latestRun && modelSelectionsEqual(latestRun.modelSelection, input.modelSelection);
  return derivePromptCacheStatus({
    driver: thread.driver,
    usage: sameSelection ? latest?.tokenUsage : undefined,
    hasContext,
    nowMs: input.nowMs,
  });
}

export function promptCacheNeedsAcknowledgement(status: PromptCacheStatus): boolean {
  return status.state === "expired" || status.state === "unknown";
}
