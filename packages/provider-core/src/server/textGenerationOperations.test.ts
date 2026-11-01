import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect } from "vite-plus/test";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("test"), model: "summary-model" };

describe("context summary output validation", () => {
  it.effect(
    "accepts a bounded summary and rejects invalid or oversized output without truncation",
    () =>
      Effect.gen(function* () {
        for (const [output, accepted] of [
          [
            JSON.stringify({ summary: "  Preserve src/config.ts and the pending failing test.  " }),
            true,
          ],
          [JSON.stringify({ summary: " " }), false],
          [JSON.stringify({ summary: "a".repeat(16_001) }), false],
          [JSON.stringify({ summary: "界".repeat(6_000) }), false],
          [JSON.stringify({ summary: "界".repeat(5_000) }), true],
          [JSON.stringify({ title: "Not a summary" }), false],
          ["not json", false],
        ] as const) {
          const generation = fromRunner("fixture", (request) =>
            decodeJsonReply(request, "fixture", output),
          );
          const result = yield* generation
            .generateContextSummary({
              cwd: "/workspace",
              transcript: "User: Keep the failing test. Assistant: Modified src/config.ts.",
              modelSelection,
            })
            .pipe(Effect.result);
          expect(Result.isSuccess(result)).toBe(accepted);
          if (Result.isSuccess(result)) {
            expect(result.success.summary).toBe(JSON.parse(output).summary.trim());
          } else {
            expect(result.failure.operation).toBe("generateContextSummary");
          }
        }
      }),
  );
});
