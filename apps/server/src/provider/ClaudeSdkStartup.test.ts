import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { makePendingClaudeProvider } from "./ClaudeProvider.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const sdk = vi.hoisted(() => ({ loaded: false }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  sdk.loaded = true;
  return {};
});

it.effect("keeps disabled provider metadata available without loading the Claude SDK", () =>
  Effect.gen(function* () {
    const provider = yield* makePendingClaudeProvider(decodeClaudeSettings({ enabled: false }));
    assert.isFalse(provider.enabled);
    assert.isAbove(provider.models.length, 0);
    assert.isFalse(sdk.loaded);
  }),
);

it.effect("prepares the query runner without loading an unused SDK", () =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    assert.isString(yield* runner.allocateSessionId);
    assert.isFalse(sdk.loaded);
  }).pipe(
    Effect.provide(
      layerQueryRunner.pipe(
        Layer.provide(PortScanner.layerTest),
        Layer.provide(
          Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
        ),
        Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
