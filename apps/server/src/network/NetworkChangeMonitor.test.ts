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
  it("ignores loopback and interface order", () => {
    const loopback = { lo: [address("127.0.0.1", true)] };
    assert.strictEqual(
      NetworkChangeMonitor.interfaceSignature({
        ...loopback,
        wlan0: [address("192.168.1.2")],
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
});
