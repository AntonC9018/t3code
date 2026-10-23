import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Recovery must find the few pending deliveries without reading historical
  // run payloads. Keep the predicate identical to the recovery query.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_delivery_recovery_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_subagent_recovery_idx
    ON orchestration_v2_projection_threads(thread_id)
    WHERE CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      AND json_extract(payload_json, '$.forkedFrom.type') = 'node'
      ELSE 0 END
  `;
  // Every shell row needs the last executed run. Avoid sorting and loading
  // completed run payloads for each historical thread during startup sweeps.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_executed_order_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
  `;
  // The existing latest-user index covers server-written messages too.
  // Finding the last human message must not read those payloads one by one.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_messages_authored_updated_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user'
  `;
});
