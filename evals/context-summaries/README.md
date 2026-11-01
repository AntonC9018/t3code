# Context summaries

Checks custom-model compaction with the server's standalone Claude summary generator. Cases cover
constraints, incomplete work, historical prompt injection, and reduction of partial summaries.

```sh
cd evals
pnpm context-summaries --model haiku --case constraints-and-failed-tests --out runs/summary-smoke
pnpm context-summaries --model haiku --samples 3 --out runs/summaries
pnpm context-summaries --model haiku --samples 3 --out runs/summaries-new \
  --baseline runs/summaries/results.json
```

The runner uses your local Claude login. It calls the selected model once per case and sample;
three cases at three samples make nine short calls, charged to that subscription. Start with the
single-case smoke run. No tools or project access are enabled. Review `review.json` against each
case's rubric. Mark each criterion pass or fail; a case fails if half or more samples fail.

Add synthetic cases to `cases.ts`, including a source and rubric. Do not include real transcripts.
