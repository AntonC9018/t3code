import type * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as NetworkChangeMonitor from "./NetworkChangeMonitor.ts";

type Interfaces = ReturnType<typeof NodeOS.networkInterfaces>;

const address = (value: string, internal = false) =>
  ({
    address: value,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  }) as const;

describe("NetworkChangeMonitor", () => {
  it("ignores loopback, IPv6, local bridges, and interface order", () => {
    assert.strictEqual(
      NetworkChangeMonitor.interfaceSignature({
        lo: [address("127.0.0.1", true)],
        wlan0: [
          address("192.168.1.2"),
          { ...address("2001:db8::1234"), family: "IPv6", scopeid: 0 },
        ],
        docker0: [address("172.17.0.1")],
        "br-1a2b": [address("172.18.0.1")],
        tun0: [address("10.0.0.2")],
      }),
      NetworkChangeMonitor.interfaceSignature({
        tun0: [address("10.0.0.2")],
        wlan0: [address("192.168.1.2")],
      }),
    );
  });

  it.effect("reports each address change once, not steady polls", () =>
    Effect.gen(function* () {
      let interfaces: Interfaces = { wlan0: [address("192.168.1.2")] };
      const monitor = NetworkChangeMonitor.make({
        readInterfaces: () => interfaces,
        pollInterval: "2 seconds",
      });
      const fiber = yield* monitor.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* TestClock.adjust("6 seconds");
      interfaces = { wlan0: [address("192.168.7.9")] };
      yield* TestClock.adjust("4 seconds");
      interfaces = { wlan0: [address("192.168.7.9")], tun0: [address("10.0.0.2")] };
      yield* TestClock.adjust("2 seconds");

      assert.deepStrictEqual(yield* Fiber.join(fiber), [8_000, 12_000]);
    }),
  );

  it.effect("reports suspend, not an event loop that stalled with both clocks running", () =>
    Effect.gen(function* () {
      const interfaces: Interfaces = { wlan0: [address("192.168.1.2")] };
      // The monotonic clock follows the test clock, minus time spent suspended.
      let suspendedMs = 0;
      const clock = yield* TestClock.testClockWith(Effect.succeed);
      const monitor = NetworkChangeMonitor.make({
        readInterfaces: () => interfaces,
        pollInterval: "2 seconds",
        monotonicMillis: () => clock.currentTimeMillisUnsafe() - suspendedMs,
      });
      const fiber = yield* monitor.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      // A 30 s stall: both clocks advance, so polls are merely late.
      yield* TestClock.adjust("30 seconds");
      // A 60 s suspend: wall time jumps while the monotonic clock does not.
      suspendedMs = 60_000;
      yield* TestClock.adjust("2 seconds");

      assert.deepStrictEqual(yield* Fiber.join(fiber), [32_000]);
    }),
  );
});
