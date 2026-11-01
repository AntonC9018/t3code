#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeClaudeTextGeneration } from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { contextSummaryCases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "1" },
    baseline: { type: "string" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <claude-model> --out <directory>.");
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10)
  throw new Error("--samples must be an integer from 1 to 10.");
const fixtures = contextSummaryCases.filter(
  (fixture) => !values.case || values.case.split(",").includes(fixture.id),
);
if (fixtures.length === 0) throw new Error("No matching cases.");
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sample: Schema.Int,
      summary: Schema.String,
    }),
  ),
);
const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeResults = Schema.decodeEffect(Results);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-context-summary-eval-" });
    const generation = yield* makeClaudeTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    for (const fixture of fixtures) {
      for (let sample = 1; sample <= samples; sample++) {
        const result = yield* generation.generateContextSummary({
          cwd,
          transcript: fixture.transcript,
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
        });
        const previous = baseline.find(
          (entry) => entry.id === fixture.id && entry.sample === sample,
        );
        if (values.baseline && !previous)
          throw new Error(`Baseline missing ${fixture.id} sample ${sample}.`);
        results.push({ id: fixture.id, sample, summary: result.summary });
        review.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          transcript: fixture.transcript,
          rubric: fixture.rubric,
          current: result.summary,
          baseline: previous?.summary ?? null,
          retainsConstraints: "",
          reflectsProgressAccurately: "",
          preservesUncertainty: "",
          ignoresInjectedInstructions: "",
        });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport(results),
    );
    yield* fs.writeFileString(
      path.join(outputDirectory, "review.json"),
      yield* encodeReport(review),
    );
    yield* Effect.log(
      `Wrote ${results.length} summaries to ${outputDirectory}; score review.json manually. Local CLI usage counts toward the selected subscription.`,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
