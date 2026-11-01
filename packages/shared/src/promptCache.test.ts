import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import {
  derivePromptCacheStatus,
  deriveThreadPromptCacheStatus,
  promptCacheNeedsAcknowledgement,
} from "./promptCache.ts";

const epoch = Date.parse("2026-11-01T00:00:00Z");

describe("prompt cache protection", () => {
  it("distinguishes cache expiry from unknown telemetry and fresh context", () => {
    const base = {
      driver: ProviderDriverKind.make("claudeAgent"),
      nowMs: epoch,
      hasContext: true,
    };
    const warm = derivePromptCacheStatus({
      ...base,
      usage: { promptCacheExpiresAt: "2026-11-01T01:00:00Z", promptCacheTtlMs: 3_600_000 },
    });
    expect(warm.state).toBe("warm");
    expect(promptCacheNeedsAcknowledgement(warm)).toBe(false);
    expect(
      derivePromptCacheStatus({
        ...base,
        usage: { promptCacheExpiresAt: "2026-11-01T00:01:00Z", promptCacheTtlMs: 300_000 },
      }).state,
    ).toBe("expiring");
    for (const usage of [
      undefined,
      { promptCacheExpiresAt: "invalid" },
      { promptCacheTtlMs: 3_600_000 },
    ]) {
      const status = derivePromptCacheStatus({ ...base, usage });
      expect(status.state).toBe("unknown");
      expect(promptCacheNeedsAcknowledgement(status)).toBe(true);
    }
    const expired = derivePromptCacheStatus({
      ...base,
      usage: { promptCacheExpiresAt: "2026-11-01T00:00:00Z" },
    });
    expect(expired.state).toBe("expired");
    expect(promptCacheNeedsAcknowledgement(expired)).toBe(true);
    expect(derivePromptCacheStatus({ ...base, hasContext: false }).state).toBe("fresh");
    expect(derivePromptCacheStatus({ ...base, driver: "codex" }).state).toBe("unsupported");
  });

  it("does not revive old cache telemetry after replacing a native conversation or changing model", () => {
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const nodeId = NodeId.make("node");
    const attemptId = RunAttemptId.make("attempt");
    const runId = RunId.make("run");
    const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
    const input: Parameters<typeof deriveThreadPromptCacheStatus>[0] = {
      providerThread: {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "old-native",
          strength: "strong",
        },
      },
      providerTurns: [
        {
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          tokenUsage: {
            usedTokens: 1000,
            promptCacheExpiresAt: "2026-11-01T01:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
          },
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          providerThreadId,
          rootNodeId: nodeId,
          nativeThreadId: "old-native",
          providerTurnId: ProviderTurnId.make("turn"),
        },
      ],
      runs: [{ id: runId, modelSelection }],
      modelSelection,
      nowMs: epoch,
    };
    expect(deriveThreadPromptCacheStatus(input).state).toBe("warm");
    expect(
      deriveThreadPromptCacheStatus({
        ...input,
        modelSelection: { ...modelSelection, model: "sonnet" },
      }).state,
    ).toBe("unknown");
    expect(
      deriveThreadPromptCacheStatus({
        ...input,
        providerThread: {
          ...input.providerThread!,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: "new-native",
            strength: "strong",
          },
        },
      }).state,
    ).toBe("fresh");
    expect(deriveThreadPromptCacheStatus({ ...input, providerTurns: [] }).state).toBe("unknown");
  });
});
