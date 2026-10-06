import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";
import * as DesktopWslLoopbackBridge from "./DesktopWslLoopbackBridge.ts";

function makeStubInstance(input: {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly label: string;
  readonly snapshot: DesktopBackendSnapshot;
  readonly start?: Effect.Effect<void>;
}): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: input.id,
    label: Effect.succeed(input.label),
    start: input.start ?? Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

const idleSnapshot: DesktopBackendSnapshot = {
  desiredRunning: false,
  ready: false,
  activePid: Option.none(),
  restartAttempt: 5,
  restartScheduled: false,
};

const primarySnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
};

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const netLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
} satisfies NetService.NetService["Service"]);

describe("DesktopWslBackend", () => {
  function phoneBackendTest(
    run: (state: {
      backend: DesktopWslBackend.DesktopWslBackend["Service"];
      spec: DesktopBackendPool.BackendInstanceSpec;
      commands: Array<ReadonlyArray<string>>;
      bridgeTargets: string[];
      setDnsReady: (ready: boolean) => void;
      clearRoute: () => void;
    }) => Effect.Effect<void>,
  ) {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    const commands: Array<ReadonlyArray<string>> = [];
    const bridgeTargets: string[] = [];
    const bridgeLayer = Layer.succeed(DesktopWslLoopbackBridge.DesktopWslLoopbackBridge, {
      start: (target) =>
        Effect.sync(() => {
          bridgeTargets.push(target.href);
          return { httpBaseUrl: new URL("http://127.0.0.1:14773/"), stop: Effect.void };
        }),
    });
    let dnsReady = true;
    let route: { port: number; target: string } | undefined;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wsl = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: primarySnapshot,
    });
    const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: () => Effect.succeed(Option.some(primary)),
      list: Effect.sync(() => (registeredSpec ? [primary, wsl] : [primary])),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          return wsl;
        }),
      unregister: () => Effect.die("unexpected unregister"),
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);
    const spawner = ChildProcessSpawner.make((command) => {
      assert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
      commands.push([...command.args]);
      if (command.args[1] === "--bg") {
        route = { port: Number(command.args[2]!.split("=")[1]), target: command.args[3]! };
      } else if (command.args[2] === "off") {
        route = undefined;
      }
      const stdout =
        command.args[0] === "status"
          ? JSON.stringify({ Self: { DNSName: dnsReady ? "desktop.tail.ts.net." : "" } })
          : JSON.stringify(
              route
                ? {
                    TCP: { [route.port]: { HTTPS: true } },
                    Web: {
                      [`desktop.tail.ts.net:${route.port}`]: {
                        Handlers: { "/": { Proxy: route.target } },
                      },
                    },
                  }
                : {},
            );
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.reconcile;
      const spec = registeredSpec;
      if (!spec?.onReady) return yield* Effect.die("Expected WSL ready callback");
      yield* run({
        backend,
        spec,
        commands,
        bridgeTargets,
        setDnsReady: (ready) => {
          dnsReady = ready;
        },
        clearRoute: () => {
          route = undefined;
        },
      });
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(bridgeLayer),
          Layer.provideMerge(backendConfigurationLayer),
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(netLayer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              tailscaleServeEnabled: true,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
          Layer.provideMerge(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );
  }

  it.effect("publishes the reachable WSL host instead of relying on localhost forwarding", () =>
    phoneBackendTest(({ backend, spec, commands, bridgeTargets }) =>
      Effect.gen(function* () {
        yield* spec.onReady!(new URL("http://172.27.81.217:3774/"));
        assert.equal(yield* backend.remoteHttpBaseUrl, "https://desktop.tail.ts.net:8443/");
        assert.include(bridgeTargets, "http://172.27.81.217:3774/");
        assert.deepInclude(commands, ["serve", "--bg", "--https=8443", "http://127.0.0.1:14773"]);
      }),
    ),
  );

  it.effect("retries publication when Tailscale becomes ready after the backend", () =>
    phoneBackendTest(({ backend, spec, setDnsReady }) =>
      Effect.gen(function* () {
        setDnsReady(false);
        yield* spec.onReady!(new URL("http://172.27.81.217:3774/"));
        assert.isUndefined(yield* backend.remoteHttpBaseUrl);
        setDnsReady(true);
        yield* backend.reconcile;
        assert.equal(yield* backend.remoteHttpBaseUrl, "https://desktop.tail.ts.net:8443/");
      }),
    ),
  );

  it.effect("restores a lost phone route automatically while the backend stays running", () =>
    phoneBackendTest(({ spec, commands, clearRoute }) =>
      Effect.gen(function* () {
        yield* spec.onReady!(new URL("http://172.27.81.217:3774/"));
        clearRoute();
        const publishesBefore = commands.filter((args) => args[1] === "--bg").length;
        yield* TestClock.adjust("15 seconds");
        assert.equal(commands.filter((args) => args[1] === "--bg").length, publishesBefore + 1);
      }),
    ),
  );

  it.effect("keeps the same phone origin when the WSL address changes on restart", () =>
    phoneBackendTest(({ backend, spec, commands, bridgeTargets }) =>
      Effect.gen(function* () {
        yield* spec.onReady!(new URL("http://172.27.81.217:3774/"));
        yield* spec.onShutdown!();
        yield* spec.onReady!(new URL("http://172.27.81.218:3775/"));
        assert.deepEqual(bridgeTargets, [
          "http://172.27.81.217:3774/",
          "http://172.27.81.218:3775/",
        ]);
        assert.equal(yield* backend.remoteHttpBaseUrl, "https://desktop.tail.ts.net:8443/");
        assert.deepInclude(commands, ["serve", "--bg", "--https=8443", "http://127.0.0.1:14773"]);
      }),
    ),
  );
  it.effect("does not discover or start WSL when local execution is disabled", () =>
    Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.reconcile;
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {})),
          Layer.provide(Layer.mock(DesktopWslLoopbackBridge.DesktopWslLoopbackBridge, {})),
          Layer.provide(Layer.mock(DesktopBackendPool.DesktopBackendPool, {})),
          Layer.provide(backendConfigurationLayer),
          Layer.provide(serverExposureLayer),
          Layer.provide(netLayer),
          Layer.provide(Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {})),
          Layer.provide(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              localEnvironmentEnabled: false,
              wslBackendEnabled: true,
            }),
          ),
        ),
      ),
    ),
  );
  it.effect("clears the stored preflight error when a registered WSL backend becomes ready", () => {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wsl = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: primarySnapshot,
    });
    const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.succeed([primary]),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          return wsl;
        }),
      unregister: () => Effect.die("unexpected unregister"),
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      const spec = registeredSpec;
      assert.isDefined(spec);
      if (spec === undefined) {
        throw new Error("Expected WSL backend registration");
      }
      const recordFailure = spec.onPreflightFailed;
      const clearFailure = spec.onReady;
      assert.isDefined(recordFailure);
      assert.isDefined(clearFailure);
      if (recordFailure === undefined || clearFailure === undefined) {
        throw new Error("Expected WSL backend callbacks");
      }

      assert.isFalse(yield* recordFailure({ reason: "Node.js not found", fatal: true }));
      assert.deepEqual(yield* backend.lastPreflightError, Option.some("Node.js not found"));

      yield* clearFailure(new URL("http://127.0.0.1:41773"));
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {})),
          Layer.provide(Layer.mock(DesktopWslLoopbackBridge.DesktopWslLoopbackBridge, {})),
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(backendConfigurationLayer),
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(netLayer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
        ),
      ),
    );
  });

  it.effect("retries an unchanged WSL instance when it is idle after failed preflight", () => {
    let startCount = 0;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wsl = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: idleSnapshot,
      start: Effect.sync(() => {
        startCount += 1;
      }),
    });

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;

      assert.equal(startCount, 1);
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {})),
          Layer.provide(Layer.mock(DesktopWslLoopbackBridge.DesktopWslLoopbackBridge, {})),
          Layer.provideMerge(DesktopBackendPool.layerTest([primary, wsl])),
          Layer.provideMerge(backendConfigurationLayer),
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(netLayer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
        ),
      ),
    );
  });
});
