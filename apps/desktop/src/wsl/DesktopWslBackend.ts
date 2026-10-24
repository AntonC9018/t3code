import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as NetService from "@t3tools/shared/Net";
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  findCompanionServePort,
  ownsCompanionServeRoute,
  readTailscaleServeConfig,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslLoopbackBridge from "./DesktopWslLoopbackBridge.ts";

// Exported so callers that parse pool ids (e.g. the pickFolder IPC handler in
// ipc/methods/window.ts) reference the same prefix this module produces.
export const WSL_INSTANCE_ID_PREFIX = "wsl:";
const WSL_DEFAULT_DISTRO_ID = `${WSL_INSTANCE_ID_PREFIX}default`;
const MAX_TCP_PORT = 65_535;

export class DesktopWslBackend extends Context.Service<
  DesktopWslBackend,
  {
    readonly reconcile: Effect.Effect<void>;
    readonly lastPreflightError: Effect.Effect<Option.Option<string>>;
    readonly remoteHttpBaseUrl: Effect.Effect<string | undefined>;
  }
>()("@t3tools/desktop/wsl/DesktopWslBackend") {}

const { logInfo: logWslBackendInfo, logWarning: logWslBackendWarning } =
  DesktopObservability.makeComponentLogger("desktop-wsl-backend");

const resolveTargetInstanceId = (distro: string | null): DesktopBackendPool.BackendInstanceId =>
  DesktopBackendPool.BackendInstanceId(
    distro === null ? WSL_DEFAULT_DISTRO_ID : `${WSL_INSTANCE_ID_PREFIX}${distro}`,
  );

const isWslInstanceId = (id: DesktopBackendPool.BackendInstanceId): boolean =>
  id.startsWith(WSL_INSTANCE_ID_PREFIX);

const buildLabel = (distro: string | null): string =>
  distro === null ? "WSL (default distro)" : `WSL (${distro})`;

// Loopback-only port scan starting one above the primary's port. The
// WSL backend is reachable via 127.0.0.1 from Windows (wslhost
// auto-forwards), so we only need to verify the IPv4 loopback can bind.
const scanForWslPort = Effect.fn("desktop.wslBackend.scanForWslPort")(function* (
  startPort: number,
): Effect.fn.Return<number, NetService.NetError, NetService.NetService> {
  const net = yield* NetService.NetService;
  for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
    if (yield* net.canListenOnHost(port, "127.0.0.1")) {
      return port;
    }
  }
  return yield* new NetService.NetError({
    message: `No loopback port available for WSL backend between ${startPort} and ${MAX_TCP_PORT}.`,
  });
});

export const layer = Layer.effect(
  DesktopWslBackend,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const net = yield* NetService.NetService;
    const loopbackBridge = yield* DesktopWslLoopbackBridge.DesktopWslLoopbackBridge;
    // Serialize reconcile so the bootstrap fork and the IPC handlers
    // (setWslBackendEnabled, setWslDistro) can't interleave. Without
    // this, two reconciles could both observe "no WSL instance
    // registered" between their pool reads and both call startNew
    // with different distros, leaving the loser stranded.
    const reconcileMutex = yield* Semaphore.make(1);

    const preflightErrorRef = yield* Ref.make(Option.none<string>());
    const remoteUrlRef = yield* Ref.make<string | undefined>(undefined);
    const readyUrlRef = yield* Ref.make<URL | undefined>(undefined);
    const bridgeRef = yield* Ref.make<
      { target: string; bridge: DesktopWslLoopbackBridge.Bridge } | undefined
    >(undefined);
    const serveLeaseRef = yield* Ref.make<DesktopAppSettings.WslTailscaleServeLease | undefined>(
      undefined,
    );
    const endpointMutex = yield* Semaphore.make(1);
    // Capture the host spawner for callbacks run by the backend's own runtime.
    // A missing dependency must not silently disable phone pairing.
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const releaseBridge = Ref.getAndSet(bridgeRef, undefined).pipe(
      Effect.flatMap((entry) => (entry ? entry.bridge.stop : Effect.void)),
    );
    const releaseRemoteEndpoint = Effect.gen(function* () {
      yield* Ref.set(remoteUrlRef, undefined);
      const lease = yield* Ref.getAndSet(serveLeaseRef, undefined);
      if (!lease) return;
      const config = yield* readTailscaleServeConfig;
      if (ownsCompanionServeRoute(config, lease.dnsName, lease.port, lease.target)) {
        yield* disableTailscaleServe({ servePort: lease.port });
      }
    }).pipe(
      Effect.catch(() => logWslBackendWarning("could not release WSL Tailscale endpoint")),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const exposeRemoteEndpoint = (httpBaseUrl: URL) =>
      Effect.gen(function* () {
        const settings = yield* appSettings.get;
        if (!settings.tailscaleServeEnabled) {
          yield* releaseRemoteEndpoint;
          yield* releaseBridge;
          return;
        }
        const status = yield* readTailscaleStatus;
        if (!status.magicDnsName) return;
        const dnsName = status.magicDnsName;
        const config = yield* readTailscaleServeConfig;
        let localUrl = httpBaseUrl;
        if (httpBaseUrl.hostname !== "127.0.0.1" && httpBaseUrl.hostname !== "localhost") {
          let entry = yield* Ref.get(bridgeRef);
          if (entry?.target !== httpBaseUrl.href) {
            yield* releaseBridge;
            entry = { target: httpBaseUrl.href, bridge: yield* loopbackBridge.start(httpBaseUrl) };
            yield* Ref.set(bridgeRef, entry);
          }
          localUrl = entry.bridge.httpBaseUrl;
        }
        const localPort = Number(localUrl.port);
        const localHost = localUrl.hostname;
        const target = `http://${localHost}:${localPort}`;
        const previousLease = (yield* Ref.get(serveLeaseRef)) ?? settings.wslTailscaleServeLease;
        const portIsFree = (port: number) =>
          config.TCP?.[String(port)] === undefined &&
          !Object.keys(config.Web ?? {}).some((host) => host.endsWith(`:${port}`)) &&
          !Object.keys(config.AllowFunnel ?? {}).some((host) => host.endsWith(`:${port}`));
        const reusablePort =
          previousLease?.dnsName === status.magicDnsName &&
          previousLease.port !== settings.tailscaleServePort &&
          (portIsFree(previousLease.port) ||
            ownsCompanionServeRoute(
              config,
              previousLease.dnsName,
              previousLease.port,
              previousLease.target,
            ))
            ? previousLease.port
            : undefined;
        // Adopt a matching older route at upgrade, but never take over a
        // listener whose target or Funnel status belongs to something else.
        const matchingPort = Object.keys(config.TCP ?? {})
          .map(Number)
          .find(
            (port) =>
              port !== settings.tailscaleServePort &&
              port >= 8443 &&
              port < 8500 &&
              ownsCompanionServeRoute(config, dnsName, port, target),
          );
        const servePort =
          reusablePort ??
          matchingPort ??
          findCompanionServePort(config, settings.tailscaleServePort);
        if (servePort === null) {
          yield* logWslBackendWarning("no free Tailscale HTTPS port for WSL pairing");
          return;
        }
        if (!ownsCompanionServeRoute(config, status.magicDnsName, servePort, target)) {
          yield* ensureTailscaleServe({ localPort, localHost, servePort });
        }
        const lease = {
          dnsName: status.magicDnsName,
          port: servePort,
          target,
        };
        yield* Ref.set(serveLeaseRef, lease);
        yield* appSettings.setWslTailscaleServeLease(lease);
        yield* Ref.set(
          remoteUrlRef,
          buildTailscaleHttpsBaseUrl({ magicDnsName: status.magicDnsName, servePort }),
        );
      }).pipe(
        Effect.catch(() =>
          logWslBackendWarning("WSL Tailscale pairing endpoint could not start; will retry"),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    const ownershipRefusedRef = yield* Ref.make(
      Option.none<DesktopBackendPool.BackendInstanceId>(),
    );

    const findExistingWslInstance = pool.list.pipe(
      Effect.map((instances) => instances.find((instance) => isWslInstanceId(instance.id))),
      Effect.map(Option.fromNullishOr),
    );

    const stopExisting = (id: DesktopBackendPool.BackendInstanceId) =>
      pool.unregister(id).pipe(
        Effect.catchTags({
          DesktopBackendPoolCannotUnregisterPrimaryError: (cause) =>
            logWslBackendWarning("refusing to unregister primary as wsl instance", {
              id,
              error: cause.message,
            }),
        }),
      );

    const startNew = Effect.fn("desktop.wslBackend.startNew")(function* (input: {
      readonly distro: string | null;
    }) {
      const primaryConfig = yield* serverExposure.backendConfig;
      const port = yield* scanForWslPort(primaryConfig.port + 1).pipe(
        Effect.provideService(NetService.NetService, net),
        Effect.asSome,
        Effect.catch((error) =>
          logWslBackendWarning("could not allocate port for WSL backend", {
            error: error.message,
          }).pipe(Effect.as(Option.none<number>())),
        ),
      );

      if (Option.isNone(port)) {
        return;
      }
      const allocatedPort = port.value;

      const targetId = resolveTargetInstanceId(input.distro);
      yield* logWslBackendInfo("registering WSL backend with pool", {
        id: targetId,
        port: allocatedPort,
        distro: input.distro ?? null,
      });

      const instance = yield* pool
        .register({
          id: targetId,
          label: Effect.succeed(buildLabel(input.distro)),
          configResolve: configuration.resolveWsl({ port: allocatedPort, distro: input.distro }),
          onPreflightFailed: (failure) =>
            Ref.set(preflightErrorRef, Option.some(failure.reason)).pipe(Effect.as(false)),
          onReady: (httpBaseUrl) =>
            endpointMutex.withPermits(1)(
              Effect.gen(function* () {
                yield* Ref.set(ownershipRefusedRef, Option.none());
                yield* Ref.set(preflightErrorRef, Option.none());
                yield* Ref.set(readyUrlRef, httpBaseUrl);
                yield* exposeRemoteEndpoint(httpBaseUrl);
              }),
            ),
          onShutdown: () =>
            endpointMutex.withPermits(1)(
              Ref.set(readyUrlRef, undefined).pipe(
                Effect.andThen(releaseRemoteEndpoint),
                Effect.andThen(releaseBridge),
              ),
            ),
          onStateDirOwned: () =>
            Ref.set(ownershipRefusedRef, Option.some(targetId)).pipe(
              Effect.andThen(
                Ref.set(
                  preflightErrorRef,
                  Option.some(
                    "Another T3 Code server is using this distro's T3 home, or an older background service is set up for it. Stop that server or pair with it, or try `t3 update` in the distro. If the older launcher cannot update, run `t3 service uninstall` and optionally reinstall with `t3 service install` from a current CLI in the distro. Use `npx t3@latest` if `t3` is missing or outdated, and pass `--base-dir` with the service's T3 home to each command.",
                  ),
                ),
              ),
            ),
        })
        .pipe(
          Effect.asSome,
          Effect.catch((error) =>
            logWslBackendWarning("WSL backend already registered, skipping start", {
              id: targetId,
              error: error.message,
            }).pipe(Effect.as(Option.none<DesktopBackendPool.DesktopBackendInstance>())),
          ),
        );

      yield* Option.match(instance, {
        onNone: () => Effect.void,
        onSome: (registered) => registered.start,
      });
    });

    const reconcileBody = Effect.gen(function* () {
      const settings = yield* appSettings.get;
      if (!settings.localEnvironmentEnabled) return;
      const available = yield* wslEnvironment.isAvailable;
      const existing = yield* findExistingWslInstance;
      const existingId = Option.map(existing, (instance) => instance.id);

      // In wsl-only mode the pool's primary IS the WSL backend (see
      // DesktopBackendConfiguration.resolvePrimary), so the
      // orchestrator skips registering a parallel "wsl:<distro>"
      // secondary. Without this skip we'd spin up two WSL processes
      // on the same distro for users who explicitly asked for one.
      const shouldRun = settings.wslBackendEnabled && available && !settings.wslOnly;
      const targetId = shouldRun
        ? Option.some(resolveTargetInstanceId(settings.wslDistro))
        : Option.none<DesktopBackendPool.BackendInstanceId>();

      if (Option.isNone(targetId) && Option.isNone(existingId)) {
        return;
      }
      if (
        Option.isSome(targetId) &&
        Option.isSome(existing) &&
        targetId.value === existing.value.id
      ) {
        const existingInstance = existing.value;
        const snapshot = yield* existingInstance.snapshot;
        const isIdle =
          !snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled;
        if (isIdle) {
          const refused = yield* Ref.get(ownershipRefusedRef);
          if (Option.isSome(refused) && refused.value === existingInstance.id) return;
          yield* logWslBackendInfo("retrying idle WSL backend", { id: existingInstance.id });
          yield* Ref.set(preflightErrorRef, Option.none());
          yield* existingInstance.start;
        }
        return;
      }

      yield* Ref.set(preflightErrorRef, Option.none());
      yield* Ref.set(ownershipRefusedRef, Option.none());

      if (Option.isSome(existingId)) {
        yield* logWslBackendInfo("tearing down WSL backend", { id: existingId.value });
        yield* stopExisting(existingId.value);
      }

      if (Option.isSome(targetId)) {
        // Pre-warm the WSL VM before registering so the readiness probe doesn't
        // race wsl.exe's first-spawn cold start.
        yield* wslEnvironment.preWarm(settings.wslDistro);
        yield* startNew({ distro: settings.wslDistro });
      }
    });

    // Top-level safety net. Every internal step today already catches
    // its own failures (port allocation, register, preWarm), so the
    // inferred error type is `never` and this catch is a no-op in
    // steady state. It's here to enforce the file-header contract
    // ("reconcile never fails; errors are logged") if a future change
    // introduces an unhandled failure path — otherwise IPC callers
    // like setWslBackendEnabled would surface it to the renderer as
    // an opaque error.
    const refreshRemoteEndpoint = endpointMutex.withPermits(1)(
      Effect.gen(function* () {
        const readyUrl = yield* Ref.get(readyUrlRef);
        if (readyUrl) yield* exposeRemoteEndpoint(readyUrl);
      }),
    );
    const reconcile = reconcileMutex
      .withPermits(1)(reconcileBody)
      .pipe(
        Effect.andThen(refreshRemoteEndpoint),
        Effect.catchCause((cause) =>
          logWslBackendWarning("reconcile failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.withSpan("desktop.wslBackend.reconcile"),
      );

    // The backend may become ready before Tailscale, or a route may be lost
    // later. Repair only this instance's route, without restarting a backend.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("15 seconds");
        yield* refreshRemoteEndpoint;
      }
    }).pipe(Effect.forkScoped);

    return DesktopWslBackend.of({
      reconcile,
      lastPreflightError: Ref.get(preflightErrorRef),
      remoteHttpBaseUrl: Ref.get(remoteUrlRef),
    });
  }),
);
