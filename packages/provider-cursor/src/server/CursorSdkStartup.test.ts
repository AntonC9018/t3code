import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { CursorSettings } from "../settings.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { makeCursorAgentSdkRunner } from "./CursorAgentSdk.ts";
import { makeCursorTextGeneration } from "./textGeneration.ts";

vi.mock("./sdk.ts", () => ({
  cursorSdk: {
    get Agent() {
      throw new Error("Cursor agent SDK loaded during startup");
    },
    get createAgentPlatform() {
      throw new Error("Cursor platform SDK loaded during startup");
    },
    get SqliteLocalAgentStore() {
      throw new Error("Cursor SQLite SDK loaded during startup");
    },
  },
}));

const decodeSettings = Schema.decodeSync(CursorSettings);
const layer = Layer.merge(NodeServices.layer, CursorSdk.layer);

it.effect("constructs an unused agent runner without loading the SDK", () =>
  Effect.gen(function* () {
    const runner = yield* makeCursorAgentSdkRunner(() => undefined);
    yield* runner.assertComplete;
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects disabled text generation without loading the SDK", () =>
  Effect.gen(function* () {
    const generation = yield* makeCursorTextGeneration(decodeSettings({ enabled: false }));
    const error = yield* generation
      .generateCommitMessage({
        cwd: "/isolated",
        branch: "feature/test",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "disabled");
  }).pipe(Effect.provide(layer)),
);
