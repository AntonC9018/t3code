import { WindscribeOperationError, type WindscribeStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

export class Windscribe extends Context.Service<
  Windscribe,
  {
    readonly read: Effect.Effect<WindscribeStatus>;
    readonly setEnabled: (input: {
      readonly enabled: boolean;
    }) => Effect.Effect<WindscribeStatus, WindscribeOperationError>;
  }
>()("t3/network/Windscribe") {}

const unavailable: WindscribeStatus = {
  state: "unavailable",
  message:
    "Windscribe is unavailable on this server. Check that its CLI is installed and signed in.",
};

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const read = Effect.fn("Windscribe.read")(function* () {
    const result = yield* runner.run({
      command: "windscribe-cli",
      args: ["status"],
      timeout: "5 seconds",
      maxOutputBytes: 16_384,
    });
    if (result.code !== 0 || result.timedOut) return unavailable;
    const state =
      /^Connect state:\s*(Connected|Disconnected|Connecting|Disconnecting)(?:[ \t]*:[^\r\n]*)?[ \t]*\r?$/im
        .exec(result.stdout)?.[1]
        ?.toLowerCase();
    switch (state) {
      case "connected":
      case "disconnected":
      case "connecting":
      case "disconnecting":
        return { state, message: `Windscribe: ${state}.` };
      default:
        return unavailable;
    }
  });
  const safeRead = read().pipe(Effect.orElseSucceed(() => unavailable));
  const setEnabled = Effect.fn("Windscribe.setEnabled")(function* ({
    enabled,
  }: {
    readonly enabled: boolean;
  }) {
    const result = yield* runner
      .run({
        command: "windscribe-cli",
        args: [enabled ? "connect" : "disconnect"],
        timeout: "45 seconds",
        maxOutputBytes: 16_384,
      })
      .pipe(
        Effect.mapError(
          () =>
            new WindscribeOperationError({
              message:
                "Could not reach Windscribe. Check its CLI and sign-in on the server, then refresh status.",
            }),
        ),
      );
    if (result.code !== 0 || result.timedOut) {
      return yield* new WindscribeOperationError({
        message: "Windscribe did not complete the request. Refresh status before retrying.",
      });
    }
    return yield* safeRead;
  });
  return Windscribe.of({ read: safeRead, setEnabled });
});

export const layer = Layer.effect(Windscribe, make);
