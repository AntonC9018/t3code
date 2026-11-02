import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect } from "vite-plus/test";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("test"), model: "summary-model" };

describe("context summary output validation", () => {
  it.effect(
    "accepts bounded JSON or Markdown summaries and rejects invalid or oversized output",
    () =>
      Effect.gen(function* () {
        const markdown = [
          "## Objective",
          "Keep `src/config.ts` stable while fixing the failing parser test.",
          "",
          "## Remaining work",
          "- Fix `foo.test.ts > handles tabs` without changing the public API.",
          "- Run `pnpm test` again.",
          "- Report the result and any remaining failures to the user.",
        ].join("\n");
        const valid = (summary: string) => JSON.stringify({ summary });
        for (const [output, expected] of [
          [
            valid("  Preserve src/config.ts and the pending failing test.  "),
            "Preserve src/config.ts and the pending failing test.",
          ],
          [valid(" "), null],
          [valid("a".repeat(16_001)), null],
          [valid("界".repeat(6_000)), null],
          [valid("界".repeat(5_000)), "界".repeat(5_000)],
          [JSON.stringify({ title: "Not a summary" }), null],
          ["not json", null],
          // Literal newlines inside the string are repaired rather than rejected.
          [`{"summary": "Line one\n\tLine two"}`, "Line one\n\tLine two"],
          // A structured Markdown reply without the JSON wrapper is accepted as is.
          [markdown, markdown],
          ["```markdown\n" + markdown + "\n```", markdown],
          ["I cannot summarize this conversation.", null],
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
          expect(Result.isSuccess(result) ? result.success.summary : null).toBe(expected);
          if (Result.isFailure(result)) {
            expect(result.failure.operation).toBe("generateContextSummary");
          }
        }
      }),
  );
});
