import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DelegationRouteEntry = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
  /** False for third-party or free models that must not see private work. */
  allowPrivate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type DelegationRouteEntry = typeof DelegationRouteEntry.Type;

/** Named, ordered model lists that `delegate_task` walks with `target.route`. */
export const DelegationRoutes = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Array(DelegationRouteEntry),
);
export type DelegationRoutes = typeof DelegationRoutes.Type;

const DEFAULT_DELEGATION_ROUTE_FIRST_OUTPUT_TIMEOUT_MS = 90_000;
const DEFAULT_DELEGATION_ROUTE_FAILURE_COOLDOWN_MS = 30 * 60_000;

export const DelegationRouteSettingsFields = {
  delegationRoutes: DelegationRoutes.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** A route child with no output by then is replaced by the next entry. */
  delegationRouteFirstOutputTimeoutMs: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTE_FIRST_OUTPUT_TIMEOUT_MS)),
  ),
  /** How long a failed entry is skipped, unless its usage limit names a reset time. */
  delegationRouteFailureCooldownMs: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTE_FAILURE_COOLDOWN_MS)),
  ),
};
