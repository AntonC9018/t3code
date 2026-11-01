import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import {
  derivePromptCacheStatus,
  deriveSendPromptCacheStatus,
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
        forkedFrom: null,
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
    const newNative = {
      ...input,
      providerThread: {
        ...input.providerThread!,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: "new-native",
          strength: "strong",
        },
      },
    } satisfies typeof input;
    expect(deriveThreadPromptCacheStatus(newNative).state).toBe("fresh");
    // Forked and imported conversations carry history no local attempt produced.
    expect(
      deriveThreadPromptCacheStatus({
        ...newNative,
        providerThread: { ...newNative.providerThread, forkedFrom: { providerThreadId } },
      }).state,
    ).toBe("unknown");
    expect(deriveThreadPromptCacheStatus({ ...newNative, attempts: [] }).state).toBe("unknown");
    expect(deriveThreadPromptCacheStatus({ ...input, providerTurns: [] }).state).toBe("unknown");
  });

  it("checks the conversation the selected provider would resume, not the active one", () => {
    const threadId = ThreadId.make("thread");
    const claude = ProviderInstanceId.make("claude");
    const codex = ProviderInstanceId.make("codex");
    const updatedAt = DateTime.makeUnsafe(epoch);
    const root = {
      appThreadId: threadId,
      ownerNodeId: null,
      contextUsage: null,
      forkedFrom: null,
      lastRunOrdinal: 1,
      updatedAt,
    };
    const coldClaude = {
      ...root,
      id: ProviderThreadId.make("claude-thread"),
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: claude,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeId: "imported",
        strength: "strong" as const,
      },
    };
    const codexThread = {
      ...root,
      id: ProviderThreadId.make("codex-thread"),
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: codex,
      nativeThreadRef: null,
      lastRunOrdinal: 2,
    };
    const base = {
      providerThreads: [coldClaude, codexThread],
      providerTurns: [],
      attempts: [],
      runs: [],
      nowMs: epoch,
    };
    const fromClaude = { ...base, thread: { id: threadId, activeProviderThreadId: coldClaude.id } };
    const fromCodex = { ...base, thread: { id: threadId, activeProviderThreadId: codexThread.id } };
    expect(
      deriveSendPromptCacheStatus({
        ...fromClaude,
        modelSelection: { instanceId: codex, model: "luna" },
      }).state,
    ).toBe("unsupported");
    expect(
      deriveSendPromptCacheStatus({
        ...fromCodex,
        modelSelection: { instanceId: claude, model: "opus" },
      }).state,
    ).toBe("unknown");
    expect(
      deriveSendPromptCacheStatus({
        ...fromCodex,
        providerThreads: [{ ...coldClaude, compactionSuperseded: true as const }, codexThread],
        modelSelection: { instanceId: claude, model: "opus" },
      }).state,
    ).toBe("fresh");
  });
});
