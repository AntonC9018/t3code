import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

/** Polling is cheap (no syscalls beyond getifaddrs) and works on Linux and macOS alike. */
const POLL_INTERVAL = Duration.seconds(2);
/** A poll this late means the machine slept; sockets opened before suspend are suspect. */
const RESUME_GAP_MS = 15_000;

/** Local container and VM bridges; they come and go without touching outbound routes. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vnet|vmnet|vboxnet|cni|flannel|podman)/;

/**
 * IPv4 addresses a provider's outbound connection could use, in a stable order. IPv6 is
 * left out because temporary addresses rotate on their own while connections stay healthy.
 */
export function interfaceSignature(interfaces: NetworkInterfacesMap): string {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((address) => !address.internal && address.family === "IPv4")
        .map((address) => `${name}/${address.address}`),
    )
    .toSorted()
    .join(",");
}

export interface NetworkChangeMonitorOptions {
  readonly readInterfaces?: () => NetworkInterfacesMap;
  readonly pollInterval?: Duration.Input;
}

/**
 * Local address changes (Wi-Fi roaming, VPN up/down) and suspend/resume. Either can leave
 * an established upstream connection silently dead while new connections work.
 */
export class NetworkChangeMonitor extends Context.Service<
  NetworkChangeMonitor,
  {
    /** Epoch milliseconds of each detected change, per subscriber. */
    readonly changes: Stream.Stream<number>;
  }
>()("t3/network/NetworkChangeMonitor") {}

export const make = (options: NetworkChangeMonitorOptions = {}) => {
  const readInterfaces = options.readInterfaces ?? NodeOS.networkInterfaces;
  const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? POLL_INTERVAL);
  const resumeGapMs = Duration.toMillis(pollInterval) + RESUME_GAP_MS;
  const sample = Effect.all({
    signature: Effect.sync(() => interfaceSignature(readInterfaces())),
    atMs: Clock.currentTimeMillis,
  });

  const changes = Stream.unwrap(
    Effect.map(sample, (initial) => {
      let previous = initial;
      return Stream.tick(pollInterval).pipe(
        Stream.mapEffect(() => sample),
        Stream.filter((current) => {
          const changed =
            current.signature !== previous.signature || current.atMs - previous.atMs > resumeGapMs;
          previous = current;
          return changed;
        }),
        Stream.map((current) => current.atMs),
      );
    }),
  );

  return NetworkChangeMonitor.of({ changes });
};

export const layer = Layer.succeed(NetworkChangeMonitor, make());
