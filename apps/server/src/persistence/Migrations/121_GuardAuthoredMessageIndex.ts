import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createAuthoredMessageIndex } from "../../orchestration-v2/authoredMessageIndex.ts";

// Fork-only: rebuild the authored-message index with a predicate that tolerates bad JSON.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_messages_authored_updated_idx`;
  yield* createAuthoredMessageIndex(sql);
});
