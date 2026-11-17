import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { firstPhaseItemOutcome, planRoute } from "./delegationRoutes.ts";

describe("delegation routes", () => {
  it("ignores server workspace preparation as provider work", () => {
    const runId = RunId.make("child");
    assert.isUndefined(
      firstPhaseItemOutcome(
        {
          type: "command_execution",
          runId,
          input: "Preparing workspace",
          nativeItemRef: null,
          providerTurnId: null,
        } as OrchestrationV2TurnItem,
        runId,
      ),
    );
  });
  it("skips private, unhealthy, exhausted and cooling entries in order", () => {
    const instanceId = ProviderInstanceId.make("test");
    const entries = ["private", "usage", "cooldown", "ready"].map((model) => ({
      instanceId,
      model,
      allowPrivate: model !== "private",
    }));
    const provider = {
      instanceId,
      driver: "antigravity",
      usageLimits: {
        windows: [{ id: "usage-quota", usedPercent: 100, resetsAt: "2026-01-01T00:00:00Z" }],
      },
    } as unknown as ServerProvider;
    const input = {
      entries,
      providers: [provider],
      cooldowns: [{ instanceId, model: "cooldown", untilMs: 200, reason: "failed" }],
      nowMs: 100,
      privacy: "private" as const,
      unavailableReason: () => null,
    };
    const cooling = planRoute({
      ...input,
      providers: [{ ...provider, usageLimits: undefined } as unknown as ServerProvider],
    });
    assert.deepEqual(
      cooling.candidates.map((entry) => entry.model),
      ["usage", "ready"],
    );
    assert.deepEqual(
      cooling.skipped.map((entry) => entry.model),
      ["private", "cooldown"],
    );
    assert.deepEqual(planRoute({ ...input, nowMs: 200, providers: [] }).skipped.length, 4);
    assert.deepEqual(
      planRoute({
        ...input,
        privacy: "public",
        nowMs: 200,
        providers: [{ ...provider, usageLimits: undefined } as unknown as ServerProvider],
      }).candidates,
      entries,
    );
    assert.equal(planRoute({ ...input, unavailableReason: () => "disabled" }).candidates.length, 0);
    assert.equal(planRoute({ ...input, privacy: "public" }).candidates.length, 0);
    const nearlySpent = (usedPercent: number) =>
      planRoute({
        ...input,
        entries: [entries[3]!],
        providers: [
          {
            ...provider,
            usageLimits: { windows: [{ id: "usage-quota", usedPercent, resetsAt: null }] },
          } as unknown as ServerProvider,
        ],
      }).candidates.length;
    assert.equal(nearlySpent(98), 0);
    assert.equal(nearlySpent(97), 1);
  });

  it.each([
    "command_execution",
    "dynamic_tool",
    "file_change",
    "subagent",
    "approval_request",
  ] as const)("protects work when a %s appears", (type) => {
    const runId = RunId.make("child");
    const item = { type, runId } as OrchestrationV2TurnItem;
    assert.deepEqual(firstPhaseItemOutcome(item, runId), { type: "healthy" });
    assert.isUndefined(firstPhaseItemOutcome(item, RunId.make("other")));
  });

  it("treats chat alone as tentative, since a provider may relay an error as chat", () => {
    const runId = RunId.make("child");
    const item = { type: "assistant_message", runId, text: "Quota reached." };
    assert.deepEqual(firstPhaseItemOutcome(item as OrchestrationV2TurnItem, runId), {
      type: "text",
    });
  });
});
