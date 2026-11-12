import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as DelegationCooldowns from "./DelegationCooldowns.ts";
import * as Sqlite from "./Sqlite.ts";

it.effect("retains cooldowns across service recreation and expires them per model", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const useStore = <A, E>(work: Effect.Effect<A, E, DelegationCooldowns.DelegationCooldowns>) =>
      work.pipe(
        Effect.provide(DelegationCooldowns.layer),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    yield* useStore(
      Effect.gen(function* () {
        const store = yield* DelegationCooldowns.DelegationCooldowns;
        expect(
          yield* store.routePlan("request", [
            {
              instanceId: ProviderInstanceId.make("provider"),
              model: "original",
              allowPrivate: true,
            },
          ]),
        ).toHaveLength(1);
        yield* store.record(
          { instanceId: "provider", model: "limited", untilMs: 200, reason: "limit" },
          100,
        );
        yield* store.record(
          { instanceId: "provider", model: "other", untilMs: 300, reason: "auth" },
          100,
        );
      }),
    );
    yield* useStore(
      Effect.gen(function* () {
        const store = yield* DelegationCooldowns.DelegationCooldowns;
        expect(yield* store.routePlan("request", [])).toEqual([
          { instanceId: "provider", model: "original", allowPrivate: true },
        ]);
        expect((yield* store.listActive(150)).map((entry) => entry.model).sort()).toEqual([
          "limited",
          "other",
        ]);
        expect((yield* store.listActive(200)).map((entry) => entry.model)).toEqual(["other"]);
        yield* store.record(
          { instanceId: "provider", model: "other", untilMs: 400, reason: "retry" },
          200,
        );
        yield* store.record(
          { instanceId: "provider", model: "other", untilMs: 350, reason: "shorter failure" },
          200,
        );
        expect(yield* store.listActive(300)).toEqual([
          { instanceId: "provider", model: "other", untilMs: 400, reason: "retry" },
        ]);
        expect(yield* store.listActive(400)).toEqual([]);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
);
