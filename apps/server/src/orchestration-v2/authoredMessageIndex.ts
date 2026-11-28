import * as SqlClient from "effect/sql/SqlClient";

/** A guarded predicate, since a partial index runs on every insert and bad JSON would fail it. */
export const authoredMessageCondition = (row?: string) => {
  const payload = row === undefined ? "payload_json" : `${row}.payload_json`;
  return `CASE WHEN json_valid(${payload})
    THEN json_extract(${payload}, '$.createdBy') = 'user' ELSE 0 END`;
};

export const createAuthoredMessageIndex = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_authored_updated_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user' AND ${authoredMessageCondition()}
  `);
