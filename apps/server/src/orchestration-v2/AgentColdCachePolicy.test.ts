import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationV2CompactContextError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type AgentColdCachePolicy as Policy,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentColdCachePolicy from "./AgentColdCachePolicy.ts";
import * as CustomCompaction from "./CustomCompactionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread");
const claude: ModelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
const summarizer: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
const input: ThreadManagement.ThreadManagementSendInput = {
  projectId: ProjectId.make("project"),
  commandId: CommandId.make("send"),
  threadId,
  messageId: MessageId.make("message"),
  text: "Continue",
  attachments: [],
  mode: "queue",
  createdBy: "agent",
  creationSource: "mcp",
};

// An imported Claude conversation: native history exists, but no local turn reported its cache.
const importedClaudeThread = {
  id: ProviderThreadId.make("claude-thread"),
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: claude.instanceId,
  appThreadId: threadId,
  ownerNodeId: null,
  forkedFrom: null,
  contextUsage: null,
  lastRunOrdinal: 1,
  updatedAt: DateTime.makeUnsafe(0),
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: "imported",
    strength: "strong" as const,
  },
};

function harness(options: {
  readonly policy: Policy;
  readonly compactionModel?: ModelSelection | null;
  readonly cold?: boolean;
  readonly compactionFails?: boolean;
}) {
  const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const compactions: Array<unknown> = [];
  const base = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.succeed({
        thread: {
          id: threadId,
          activeProviderThreadId: importedClaudeThread.id,
          modelSelection: claude,
        },
        providerThreads: options.cold === false ? [] : [importedClaudeThread],
        providerTurns: [],
        attempts: [],
        runs: [],
      } as never),
    sendToThread: (send) => {
      sends.push(send);
      return Effect.succeed({} as never);
    },
  });
  const compaction = Layer.mock(CustomCompaction.CustomCompactionService)({
    compact: (compact) => {
      compactions.push(compact);
      return options.compactionFails === true
        ? Effect.fail(new OrchestrationV2CompactContextError({ threadId, reason: "busy" }))
        : Effect.void;
    },
  });
  const layer = AgentColdCachePolicy.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        base,
        compaction,
        ServerSettings.layerTest({
          agentColdCachePolicy: options.policy,
          customCompactionModelSelection: options.compactionModel ?? null,
        }),
      ),
    ),
  );
  const send = (sendInput = input) =>
    ThreadManagement.ThreadManagementService.pipe(
      Effect.flatMap((threads) => threads.sendToThread(sendInput)),
      Effect.provide(layer),
    );
  return { send, sends, compactions };
}

describe("AgentColdCachePolicy", () => {
  it.effect("passes warm and explicitly acknowledged sends through untouched", () =>
    Effect.gen(function* () {
      const warm = harness({ policy: "block", cold: false });
      yield* warm.send();
      assert.deepEqual(warm.sends, [input]);
      const acknowledged = harness({ policy: "block" });
      yield* acknowledged.send({ ...input, allowUncachedRead: true });
      assert.equal(acknowledged.sends.length, 1);
    }),
  );

  it.effect("applies the configured policy to cold sends", () =>
    Effect.gen(function* () {
      const allow = harness({ policy: "allow" });
      yield* allow.send();
      assert.deepEqual(allow.sends, [{ ...input, allowUncachedRead: true }]);

      const block = harness({ policy: "block" });
      const blocked = yield* Effect.flip(block.send());
      assert.equal(blocked._tag, "ThreadManagementPromptCacheColdError");
      assert.deepEqual(block.sends, []);

      const compact = harness({ policy: "compact", compactionModel: summarizer });
      yield* compact.send();
      assert.deepEqual(compact.compactions, [
        { threadId, commandId: CommandId.make("send:compact"), modelSelection: summarizer },
      ]);
      assert.deepEqual(compact.sends, [input]);
    }),
  );

  it.effect("blocks a compact-policy send it cannot compact", () =>
    Effect.gen(function* () {
      for (const options of [
        { policy: "compact", compactionModel: null },
        { policy: "compact", compactionModel: summarizer, compactionFails: true },
      ] as const) {
        const run = harness(options);
        const error = yield* Effect.flip(run.send());
        assert.equal(error._tag, "ThreadManagementPromptCacheColdError");
        assert.deepEqual(run.sends, []);
      }
    }),
  );
});
