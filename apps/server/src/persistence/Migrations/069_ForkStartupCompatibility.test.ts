import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import legacyStartupQueryIndexes from "./063_StartupQueryIndexes.ts";

it.effect("upgrades the deployed fork's migration 63 without rewriting its history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 62 });
    // This is the schema/history produced by the installed fork, before its
    // migration number collided with upstream's DropUnusedV1Projections.
    yield* legacyStartupQueryIndexes;
    yield* sql`INSERT INTO effect_sql_migrations(migration_id, name) VALUES (63, 'StartupQueryIndexes')`;
    assert.equal(
      (yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'projection_turns'`).length,
      1,
    );

    // Do not accept the collision when the caller stops before its repair.
    const blocked = yield* runMigrations({ toMigrationInclusive: 68 }).pipe(Effect.flip);
    assert.equal(blocked.kind, "BadState");
    const applied = yield* runMigrations();
    assert.includeDeepMembers(applied, [[69, "ForkStartupCompatibility"]]);
    assert.deepEqual(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 63`, [
      { name: "StartupQueryIndexes" },
    ]);
    assert.equal(
      (yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'projection_turns'`).length,
      0,
    );
    assert.equal(
      (yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'orchestration_v2_projection_runs_delivery_recovery_idx'`)
        .length,
      1,
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
