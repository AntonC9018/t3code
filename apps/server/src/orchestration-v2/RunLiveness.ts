import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface RunLivenessEntry {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  /** Run start, or the latest provider event the run accepted. */
  readonly lastEventAtMs: number;
}

export interface RunLivenessHandle {
  /** Records provider progress; per-event, so it stays untraced and allocation-free. */
  readonly touch: Effect.Effect<void>;
  /** Stops tracking the run; idempotent. */
  readonly end: Effect.Effect<void>;
}

export interface RunLivenessShape {
  readonly begin: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<RunLivenessHandle>;
  /** Tracked runs whose last provider event predates `cutoffMs`. */
  readonly silentSince: (cutoffMs: number) => Effect.Effect<ReadonlyArray<RunLivenessEntry>>;
  /** False once the run has ended or heard from its provider at or after `cutoffMs`. */
  readonly isSilentSince: (runId: RunId, cutoffMs: number) => Effect.Effect<boolean>;
}

const untracked: RunLivenessHandle = { touch: Effect.void, end: Effect.void };

/**
 * When each executing run last heard from its provider; silence after a network change is
 * the only stall signal. The default tracks nothing; share the live layer with its reader.
 */
export class RunLiveness extends Context.Reference<RunLivenessShape>(
  "t3/orchestration-v2/RunLiveness",
  {
    defaultValue: () => ({
      begin: () => Effect.succeed(untracked),
      silentSince: () => Effect.succeed([]),
      isSilentSince: () => Effect.succeed(false),
    }),
  },
) {}

export const make = Effect.gen(function* () {
  const entries = new Map<symbol, { threadId: ThreadId; runId: RunId; lastEventAtMs: number }>();

  const begin = Effect.fn("RunLiveness.begin")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const token = Symbol(input.runId);
    const entry = { ...input, lastEventAtMs: yield* Clock.currentTimeMillis };
    entries.set(token, entry);
    return {
      touch: Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          entry.lastEventAtMs = now;
        }),
      ),
      end: Effect.sync(() => {
        entries.delete(token);
      }),
    } satisfies RunLivenessHandle;
  });

  const silent = (cutoffMs: number) =>
    [...entries.values()].filter((entry) => entry.lastEventAtMs < cutoffMs);

  return {
    begin,
    silentSince: (cutoffMs) => Effect.sync(() => silent(cutoffMs).map((entry) => ({ ...entry }))),
    isSilentSince: (runId, cutoffMs) =>
      Effect.sync(() => silent(cutoffMs).some((entry) => entry.runId === runId)),
  } satisfies RunLivenessShape;
});

export const layer = Layer.effect(RunLiveness, make);
