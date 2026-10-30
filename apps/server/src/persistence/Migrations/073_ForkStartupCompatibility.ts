import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import dropUnusedV1Projections from "./063_DropUnusedV1Projections.ts";
import startupQueryIndexes from "./startupQueryIndexes.ts";
import threadMessageSearch from "./069_ThreadMessageSearch.ts";

// Preserve fork history while applying schema skipped by its colliding migration ids.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacyRepair = yield* sql`
    SELECT 1 FROM effect_sql_migrations
    WHERE migration_id = 69 AND name = 'ForkStartupCompatibility'
  `;
  if (legacyRepair.length > 0) yield* threadMessageSearch;
  yield* dropUnusedV1Projections;
  yield* startupQueryIndexes;
});
