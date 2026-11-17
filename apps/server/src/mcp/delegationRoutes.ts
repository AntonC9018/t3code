import type {
  DelegationRouteEntry,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  OrchestratorMcpRouteSkip,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

import type { DelegationCooldown } from "../persistence/DelegationCooldowns.ts";

export type DelegationPrivacy = "public" | "private";

/** A nearly spent window would likely fail mid-task, so a route moves on before it is empty. */
const ROUTE_SKIP_USED_PERCENT = 98;

export function routeSkip(entry: DelegationRouteEntry, reason: string): OrchestratorMcpRouteSkip {
  return { providerInstanceId: entry.instanceId, model: entry.model, reason };
}

/** Orders a route's entries into those worth starting now and those skipped, with reasons. */
export function planRoute(input: {
  readonly entries: ReadonlyArray<DelegationRouteEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cooldowns: ReadonlyArray<DelegationCooldown>;
  readonly nowMs: number;
  readonly privacy: DelegationPrivacy;
  /** Why the caller cannot run a child on this provider (disabled, unauthenticated, ...). */
  readonly unavailableReason: (provider: ServerProvider) => string | null;
}) {
  const candidates: Array<DelegationRouteEntry> = [];
  const skipped: Array<OrchestratorMcpRouteSkip> = [];
  for (const entry of input.entries) {
    const reason = entrySkipReason(entry, input);
    if (reason === null) candidates.push(entry);
    else skipped.push(routeSkip(entry, reason));
  }
  return { candidates, skipped };
}

function entrySkipReason(
  entry: DelegationRouteEntry,
  input: Parameters<typeof planRoute>[0],
): string | null {
  if (!entry.allowPrivate && input.privacy !== "public") {
    return "third-party model; needs privacy 'public'";
  }
  const provider = input.providers.find((candidate) => candidate.instanceId === entry.instanceId);
  if (provider === undefined) return "provider instance is not registered";
  const unavailable = input.unavailableReason(provider);
  if (unavailable !== null) return unavailable;
  const window = exhaustedUsageWindow(provider, input.nowMs, entry.model, ROUTE_SKIP_USED_PERCENT);
  if (window !== undefined) {
    return `usage ${Math.round(window.usedPercent)}% used${window.resetsAt ? ` until ${window.resetsAt}` : ""}`;
  }
  const cooldown = input.cooldowns.find(
    (candidate) =>
      candidate.instanceId === entry.instanceId &&
      candidate.model === entry.model &&
      candidate.untilMs > input.nowMs,
  );
  if (cooldown !== undefined) {
    return `failed recently (${cooldown.reason}); skipped until ${DateTime.formatIso(DateTime.makeUnsafe(cooldown.untilMs))}`;
  }
  return null;
}

/** Items that show the provider is working; the first one ends the fallback window. */
const OUTPUT_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "proposed_plan",
  "todo_list",
  "user_input_request",
  "approval_request",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "secret_request",
  "link_request",
  "fork",
  "thread_created",
  "handoff",
]);

export type FirstPhaseOutcome =
  | { readonly type: "healthy" }
  /**
   * Text alone, which may be an upstream error the provider relays as chat before failing the
   * run (Antigravity does this for quota errors). It counts as healthy only if the run does not
   * fail before the first-output timeout.
   */
  | { readonly type: "text" }
  /** Someone stopped the child; starting another model would override them. */
  | { readonly type: "stopped" }
  /** Null failure: the run failed and its cause must be read from its error items. */
  | { readonly type: "failed"; readonly failure: OrchestrationV2ProviderFailure | null };

export function describeFirstPhaseFailure(failure: OrchestrationV2ProviderFailure | null) {
  if (failure === null) return { reason: "failed before any output", resetAtMs: null };
  const resetAtMs = failure.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
  return {
    reason: `${failure.class}: ${failure.message}`.slice(0, 300),
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
  };
}

/** Folds one child-thread event into the first-phase verdict, if it settles one. */
export function firstPhaseOutcome(
  event: OrchestrationV2DomainEvent,
  runId: RunId,
): FirstPhaseOutcome | undefined {
  if (event.type === "turn-item.updated") return firstPhaseItemOutcome(event.payload, runId);
  if (event.type === "run.updated" && event.payload.id === runId) {
    switch (event.payload.status) {
      case "completed":
        return { type: "healthy" };
      case "failed":
        return { type: "failed", failure: null };
      case "cancelled":
      case "interrupted":
      case "rolled_back":
        return { type: "stopped" };
      default:
        return undefined;
    }
  }
  return undefined;
}

export function firstPhaseItemOutcome(
  item: OrchestrationV2TurnItem,
  runId: RunId,
): FirstPhaseOutcome | undefined {
  if (item.runId !== runId) return undefined;
  if (
    item.type === "command_execution" &&
    item.input === "Preparing workspace" &&
    item.nativeItemRef === null &&
    item.providerTurnId === null
  )
    return undefined;
  if (item.type === "assistant_message" || item.type === "reasoning")
    return item.text.length === 0 ? undefined : { type: "text" };
  if (OUTPUT_ITEM_TYPES.has(item.type)) return { type: "healthy" };
  if (
    item.type === "error" &&
    (item.failure.class === "usage_limit" || item.failure.class === "permission_error")
  )
    return { type: "failed", failure: item.failure };
  return undefined;
}
