import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import migration from "./063_StartupQueryIndexes.ts";

const query = (source: string, kind: string) => {
  const recoverySource = source.slice(source.indexOf("const getRecoveryThreadIds ="));
  const match = new RegExp(`case "${kind}":\\s*return sql\u0060([\\s\\S]*?)\u0060;`).exec(
    recoverySource,
  );
  if (!match) throw new Error(`Missing recovery query: ${kind}`);
  return match[1]!;
};
const layer = it.layer(
  Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
);

layer("startup query indexes", (it) => {
  it.effect("uses sparse indexes for recovery and ordered user-message lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.readFileString(
        yield* path.fromFileUrl(
          new URL("../../orchestration-v2/ProjectionStore.ts", import.meta.url),
        ),
      );
      yield* sql.unsafe(`CREATE TABLE orchestration_v2_projection_runs
        (thread_id TEXT, run_id TEXT, ordinal INTEGER, status TEXT, payload_json TEXT, completed_at TEXT)`);
      yield* sql.unsafe(`CREATE TABLE orchestration_v2_projection_threads
        (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`);
      yield* sql.unsafe(`CREATE TABLE orchestration_v2_projection_messages
        (thread_id TEXT, message_id TEXT, role TEXT, updated_at TEXT, payload_json TEXT)`);
      yield* sql.unsafe(`CREATE TABLE orchestration_v2_projection_subagents
        (subagent_id TEXT, child_thread_id TEXT, payload_json TEXT)`);
      yield* sql.unsafe(`CREATE TABLE orchestration_v2_projection_context_transfers
        (source_thread_id TEXT, target_thread_id TEXT, type TEXT)`);
      yield* sql.unsafe(`CREATE INDEX orchestration_v2_projection_runs_recovery_idx
        ON orchestration_v2_projection_runs(status, thread_id)
        WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')`);
      yield* sql.unsafe(`CREATE INDEX orchestration_v2_projection_messages_latest_user_idx
        ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
        WHERE role = 'user'`);
      // Old or damaged rows must not prevent recovery-index creation.
      yield* sql.unsafe(
        "INSERT INTO orchestration_v2_projection_runs VALUES ('invalid', 'r', 0, 'failed', 'invalid JSON', NULL)",
      );
      yield* sql.unsafe(
        "INSERT INTO orchestration_v2_projection_threads VALUES ('invalid', 'invalid JSON', NULL)",
      );
      yield* migration;

      const plan = (text: string) =>
        sql
          .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      assert.include(
        yield* plan(query(source, "delegated-completions")),
        "runs_delivery_recovery_idx",
      );
      assert.include(
        yield* plan(query(source, "subagent-results")),
        "threads_subagent_recovery_idx",
      );
      const queued = query(source, "runtime").match(
        /SELECT thread_id FROM orchestration_v2_projection_runs\s+WHERE status IN \('queued'[\s\S]*?(?=\s+UNION)/,
      )?.[0];
      assert.isDefined(queued);
      assert.include(yield* plan(queued!), "runs_recovery_idx");
      for (const authored of [false, true]) {
        const lookup = `SELECT updated_at FROM orchestration_v2_projection_messages
          WHERE thread_id = 'thread' AND role = 'user'
          ${authored ? "AND json_extract(payload_json, '$.createdBy') = 'user'" : ""}
          ORDER BY updated_at DESC, message_id DESC LIMIT 1`;
        const details = yield* plan(lookup);
        assert.include(
          details,
          authored ? "messages_authored_updated_idx" : "messages_latest_user_idx",
        );
        assert.notInclude(details, "TEMP B-TREE");
      }
      const blocked = source.slice(
        source.indexOf("LEFT JOIN orchestration_v2_projection_runs blocked"),
      );
      const executed = blocked
        .slice(
          blocked.indexOf("SELECT candidate.run_id"),
          blocked.indexOf("LIMIT 1") + "LIMIT 1".length,
        )
        .replace("t.thread_id", "'thread'");
      const executedPlan = yield* plan(executed);
      assert.include(executedPlan, "runs_executed_order_idx");
      assert.notInclude(executedPlan, "TEMP B-TREE");
    }),
  );
});
