import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExitCode } from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as Windscribe from "./Windscribe.ts";

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const provide = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Effect.provide(
    Windscribe.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run }))),
  );

describe("Windscribe", () => {
  it.effect.each(["Connected", "Disconnected", "Connecting", "Disconnecting"])(
    "reads %s without exposing account or IP data",
    (state) =>
      Effect.gen(function* () {
        const service = yield* Windscribe.Windscribe;
        const status = yield* service.read;
        expect(status).toEqual({
          state: state.toLowerCase(),
          message: `Windscribe: ${state.toLowerCase()}.`,
        });
      }).pipe(
        provide(() =>
          Effect.succeed(
            output(`Login state: Logged in\r\nConnect state: ${state}\r\nPublic IP: private`),
          ),
        ),
      ),
  );

  it.effect.each([output("unknown"), output("Connect state: Connected", 1)])(
    "reports unavailable for unrecognized or failed status",
    (result) =>
      Effect.gen(function* () {
        const service = yield* Windscribe.Windscribe;
        expect((yield* service.read).state).toBe("unavailable");
      }).pipe(provide(() => Effect.succeed(result))),
  );

  it.effect.each([true, false])(
    "changes the VPN and reads back its actual state (%s)",
    (enabled) => {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      return Effect.gen(function* () {
        const service = yield* Windscribe.Windscribe;
        const status = yield* service.setEnabled({ enabled });
        expect(calls.map(({ command, args }) => [command, args])).toEqual([
          ["windscribe-cli", [enabled ? "connect" : "disconnect"]],
          ["windscribe-cli", ["status"]],
        ]);
        expect(status.state).toBe(enabled ? "connected" : "disconnected");
      }).pipe(
        provide((input) => {
          calls.push(input);
          return Effect.succeed(
            output(
              input.args[0] === "status"
                ? `Connect state: ${enabled ? "Connected" : "Disconnected"}`
                : "",
            ),
          );
        }),
      );
    },
  );

  it.effect("handles a missing CLI without leaking process details", () => {
    const missing = new ProcessRunner.ProcessSpawnError({
      command: "windscribe-cli",
      argumentCount: 1,
      cause: "private details",
    });
    return Effect.gen(function* () {
      const service = yield* Windscribe.Windscribe;
      expect((yield* service.read).state).toBe("unavailable");
      const error = yield* service.setEnabled({ enabled: true }).pipe(Effect.flip);
      expect(error._tag).toBe("WindscribeOperationError");
      expect(error.message).not.toContain("private details");
    }).pipe(provide(() => Effect.fail(missing)));
  });

  it.effect("does not claim success when a command fails", () =>
    Effect.gen(function* () {
      const service = yield* Windscribe.Windscribe;
      const error = yield* service.setEnabled({ enabled: true }).pipe(Effect.flip);
      expect(error._tag).toBe("WindscribeOperationError");
      expect(error.message).not.toContain("private");
    }).pipe(provide(() => Effect.succeed(output("private", 1)))),
  );
});
