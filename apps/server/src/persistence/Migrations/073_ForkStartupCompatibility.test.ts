import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
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
    const blocked = yield* runMigrations({ toMigrationInclusive: 72 }).pipe(Effect.flip);
    assert(Schema.is(Schema.instanceOf(Migrator.MigrationError))(blocked));
    assert.equal(blocked.kind, "BadState");
    const applied = yield* runMigrations();
    assert.includeDeepMembers(applied, [[73, "ForkStartupCompatibility"]]);
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

it.effect("repairs upstream search skipped by the fork's deployed migration 69", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    yield* legacyStartupQueryIndexes;
    yield* sql`UPDATE effect_sql_migrations SET name = 'StartupQueryIndexes' WHERE migration_id = 63`;
    yield* sql`INSERT INTO effect_sql_migrations(migration_id, name) VALUES (69, 'ForkStartupCompatibility')`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES (
        'fork-message', 'fork-thread', NULL, NULL, 'user', 0,
        '2026-10-01', '2026-10-01', '{"text":"needle from the fork","createdBy":"user"}'
      )
    `;
    const blocked = yield* runMigrations({ toMigrationInclusive: 72 }).pipe(Effect.flip);
    assert(Schema.is(Schema.instanceOf(Migrator.MigrationError))(blocked));
    assert.equal(blocked.kind, "BadState");
    assert.include(blocked.message, "69_ThreadMessageSearch");

    const applied = yield* runMigrations();
    assert.includeDeepMembers(applied, [[73, "ForkStartupCompatibility"]]);
    assert.deepEqual(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 69`, [
      { name: "ForkStartupCompatibility" },
    ]);
    assert.equal(
      (yield* sql`SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'needle'`)
        .length,
      1,
    );
    assert.equal(
      (yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'peer_environment_links'`).length,
      1,
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
