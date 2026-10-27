import * as Schema from "effect/Schema";

export const WindscribeStatus = Schema.Struct({
  state: Schema.Literals([
    "connected",
    "disconnected",
    "connecting",
    "disconnecting",
    "unavailable",
  ]),
  message: Schema.String,
});
export type WindscribeStatus = typeof WindscribeStatus.Type;

export class WindscribeOperationError extends Schema.TaggedError<WindscribeOperationError>()(
  "WindscribeOperationError",
  { message: Schema.String },
) {}
