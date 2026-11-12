import { DelegationRouteEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export const DelegationCooldown = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  /** Epoch milliseconds after which the entry is tried again. */
  untilMs: Schema.Number,
  reason: Schema.String,
});
export type DelegationCooldown = typeof DelegationCooldown.Type;

export type DelegationCooldownsError = PersistenceSqlError | PersistenceDecodeError;

/** Route entries that failed recently, so later delegations skip them without paying again. */
export class DelegationCooldowns extends Context.Service<
  DelegationCooldowns,
  {
    readonly routePlan: (
      requestId: string,
      entries: ReadonlyArray<DelegationRouteEntry>,
    ) => Effect.Effect<ReadonlyArray<DelegationRouteEntry>, DelegationCooldownsError>;
    readonly listActive: (
      nowMs: number,
    ) => Effect.Effect<ReadonlyArray<DelegationCooldown>, DelegationCooldownsError>;
    readonly record: (
      cooldown: DelegationCooldown,
      nowMs: number,
    ) => Effect.Effect<void, DelegationCooldownsError>;
  }
>()("t3/persistence/DelegationCooldowns") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Fork-only table: numbered migrations collide with upstream ids, and losing it costs one retry.
  yield* sql`
    CREATE TABLE IF NOT EXISTS delegation_route_cooldowns (
      instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      until_ms INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (instance_id, model)
    )
  `.pipe(Effect.orDie);

  yield* sql`
    CREATE TABLE IF NOT EXISTS delegation_route_plans (
      request_id TEXT PRIMARY KEY,
      entries TEXT NOT NULL
    )
  `.pipe(Effect.orDie);
  const entriesJson = Schema.fromJsonString(Schema.Array(DelegationRouteEntry));
  const encodeEntries = Schema.encodeEffect(entriesJson);
  const planRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ entries: entriesJson }),
    execute: (requestId) =>
      sql`SELECT entries FROM delegation_route_plans WHERE request_id = ${requestId}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Number,
    Result: DelegationCooldown,
    execute: (nowMs) => sql`
      SELECT
        instance_id AS "instanceId",
        model AS "model",
        until_ms AS "untilMs",
        reason AS "reason"
      FROM delegation_route_cooldowns
      WHERE until_ms > ${nowMs}
    `,
  });

  return DelegationCooldowns.of({
    routePlan: Effect.fn("DelegationCooldowns.routePlan")(function (requestId, entries) {
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const encodedEntries = yield* encodeEntries(entries);
            yield* sql`INSERT INTO delegation_route_plans (request_id, entries)
          VALUES (${requestId}, ${encodedEntries}) ON CONFLICT DO NOTHING`;
            const rows = yield* planRows(requestId);
            return rows[0]!.entries;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            Schema.isSchemaError(cause)
              ? PersistenceDecodeError.fromSchemaError("DelegationRoutePlan", cause)
              : new PersistenceSqlError({ operation: "getDelegationRoutePlan", cause }),
          ),
        );
    }),
    listActive: Effect.fn("DelegationCooldowns.listActive")(function (nowMs) {
      return listRows(nowMs).pipe(
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("DelegationCooldown", cause)
            : new PersistenceSqlError({ operation: "listDelegationCooldowns", cause }),
        ),
      );
    }),
    record: Effect.fn("DelegationCooldowns.record")(function (cooldown, nowMs) {
      return sql
        .withTransaction(
          Effect.andThen(
            sql`DELETE FROM delegation_route_cooldowns WHERE until_ms <= ${nowMs}`,
            sql`
              INSERT INTO delegation_route_cooldowns (instance_id, model, until_ms, reason)
              VALUES (${cooldown.instanceId}, ${cooldown.model}, ${cooldown.untilMs}, ${cooldown.reason})
              ON CONFLICT (instance_id, model)
              DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason
              WHERE excluded.until_ms > delegation_route_cooldowns.until_ms
            `,
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "recordDelegationCooldown", cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(DelegationCooldowns, make);
