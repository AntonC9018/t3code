import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcessSpawner } from "effect/process";
import * as NetService from "@t3tools/shared/Net";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { beforeEach, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: {
    commandLine: {
      hasSwitch: () => false,
      getSwitchValue: () => "",
      appendSwitch: () => {},
      removeSwitch: () => {},
    },
    whenReady: () => Promise.resolve(),
  },
  protocol: {
    registerSchemesAsPrivileged: () => {},
  },
  ipcMain: {
    handle: () => {},
    handleOnce: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
  },
}));
vi.mock("@clerk/electron", () => ({ createClerkBridge: vi.fn() }));
vi.mock("@clerk/electron/storage", () => ({ storage: vi.fn() }));

vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({
  installDesktopIpcHandlers: () => Effect.void,
}));

vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({ listen: Effect.void }));
vi.mock("./DesktopStartupRecovery.ts", () => ({ listen: Effect.void }));

import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";
import * as DesktopPrimaryPaste from "./DesktopPrimaryPaste.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as LoopbackTunnel from "../preview/LoopbackTunnel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as AppleSpeech from "../speech/AppleSpeech.ts";

interface StartupScenario {
  readonly platform: NodeJS.Platform;
  readonly linuxPasswordStoreCommandLine: string | null;
  readonly preReadyLinuxPasswordStore: "kwallet" | null;
}

interface StartupSignals {
  readonly shellStarted: Deferred.Deferred<void>;
  readonly shellRelease: Deferred.Deferred<void>;
  readonly shellInterrupted: Ref.Ref<boolean>;
  readonly electronReady: Deferred.Deferred<void>;
  readonly settingsLoaded: Deferred.Deferred<void>;
  readonly menuConfigured: Deferred.Deferred<void>;
  readonly commandLineSwitchCalls: Ref.Ref<ReadonlyArray<string>>;
}

const startupSettings: DesktopAppSettings.DesktopSettings = {
  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  localEnvironmentEnabled: false,
};

const environmentLayer = (platform: NodeJS.Platform) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/home/t3-test",
    platform,
    processArch: "x64",
    appVersion: "0.0.22",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
    ),
  );

const makeStartupHarness = (scenario: StartupScenario, hydrateShellEnvironment: () => void) =>
  Effect.gen(function* () {
    const signals: StartupSignals = {
      shellStarted: yield* Deferred.make<void>(),
      shellRelease: yield* Deferred.make<void>(),
      shellInterrupted: yield* Ref.make(false),
      electronReady: yield* Deferred.make<void>(),
      settingsLoaded: yield* Deferred.make<void>(),
      menuConfigured: yield* Deferred.make<void>(),
      commandLineSwitchCalls: yield* Ref.make<ReadonlyArray<string>>([]),
    };
    const recordSwitchCall = (call: string) =>
      Ref.update(signals.commandLineSwitchCalls, (calls) => [...calls, call]);

    const shellInstall = Effect.gen(function* () {
      yield* Deferred.succeed(signals.shellStarted, undefined);
      yield* Deferred.await(signals.shellRelease);
      hydrateShellEnvironment();
      return true;
    }).pipe(Effect.onInterrupt(() => Ref.set(signals.shellInterrupted, true)));

    const layer = Layer.mergeAll(
      environmentLayer(scenario.platform),
      NodeServices.layer,
      NodeHttpClient.layerUndici,
      Layer.succeed(HostProcess.HomeDirectory, "/home/t3-test"),
      Layer.succeed(
        DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.of({
          linux:
            scenario.platform === "linux"
              ? {
                  isDevelopment: false,
                  linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
                  passwordStore: scenario.preReadyLinuxPasswordStore,
                }
              : null,
          linuxPasswordStoreCommandLine: scenario.linuxPasswordStoreCommandLine,
        }),
      ),
      Layer.succeed(
        DesktopShellEnvironment.DesktopShellEnvironment,
        DesktopShellEnvironment.DesktopShellEnvironment.of({
          installIntoProcess: shellInstall,
          awaitDiscovery: Effect.succeed(true),
          awaitUserShellDiscovery: Effect.succeed(true),
          discoveryFinished: Effect.succeed(true),
          updates: Stream.empty,
        }),
      ),
      Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {}),
      Layer.mock(ElectronApp.ElectronApp, {
        whenReady: Deferred.succeed(signals.electronReady, undefined).pipe(Effect.asVoid),
        quit: Effect.void,
        setPath: () => Effect.void,
        on: () => Effect.void,
        removeCommandLineSwitch: (switchName) => recordSwitchCall(`remove:${switchName}`),
        appendCommandLineSwitch: (switchName, value) =>
          recordSwitchCall(`append:${switchName}:${value ?? ""}`),
      }),
      Layer.mock(DesktopAppIdentity.DesktopAppIdentity, {
        resolveUserDataPath: Effect.succeed("/home/t3-test/.t3/userdata"),
        configure: Effect.void,
      }),
      Layer.mock(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(startupSettings),
        load: Deferred.succeed(signals.settingsLoaded, undefined).pipe(Effect.as(startupSettings)),
      }),
      Layer.mock(DesktopApplicationMenu.DesktopApplicationMenu, {
        configure: Deferred.succeed(signals.menuConfigured, undefined).pipe(Effect.asVoid),
      }),
      Layer.mock(DesktopLifecycle.DesktopLifecycle, { register: Effect.void }),
      Layer.mock(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, { register: Effect.void }),
      Layer.mock(DesktopClerk.DesktopClerk, { configure: Effect.void }),
      Layer.mock(DesktopUpdates.DesktopUpdates, {
        configure: Effect.void,
        subscribe: Effect.succeed({
          latest: createInitialDesktopUpdateState(
            "0.0.0",
            { hostArch: "x64", appArch: "x64", runningUnderArm64Translation: false },
            "latest",
          ),
          changes: Stream.empty,
        }),
      }),
      Layer.mock(ElectronSafeStorage.ElectronSafeStorage, {
        selectedStorageBackend: Effect.succeedNone,
      }),
      Layer.succeed(
        PreviewPasskeys.PreviewPasskeys,
        PreviewPasskeys.PreviewPasskeys.of({
          bridgeEnabled: false,
          configure: Effect.void,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
      ),
      DesktopState.layer,
      Layer.mock(DesktopWindow.DesktopWindow, {
        createMainIfBackendReady: Effect.void,
      }),
      Layer.mock(DesktopSnapShot.DesktopSnapShot, { initialize: Effect.void }),
      Layer.mock(ElectronProtocol.ElectronProtocol, {
        registerDesktopProtocol: () => Effect.void,
      }),
      Layer.mock(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
        load: () => Effect.void,
      }),
      Layer.mock(DesktopAppActivation.DesktopAppActivation, { start: Effect.void }),
      Layer.mock(ElectronDialog.ElectronDialog, {
        showErrorBox: () => Effect.void,
      }),
      Layer.succeed(
        DesktopShutdown.DesktopShutdown,
        DesktopShutdown.DesktopShutdown.of({
          request: Effect.void,
          awaitRequest: Effect.void,
          markComplete: Effect.void,
          awaitComplete: Effect.void,
          isComplete: Effect.succeed(false),
        }),
      ),
      // bootstrap returns before touching the backend when the local
      // environment is disabled, but installing the IPC handlers contributes
      // their services to startup's type. Keep them present and unimplemented.
      Layer.mock(BrowserImport.BrowserImport, {}),
      Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
      Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
      Layer.mock(DesktopBackendPool.DesktopBackendPool, {}),
      Layer.mock(DesktopCliCommand.DesktopCliCommand, {
        installOnFirstLaunch: Effect.void,
      }),
      Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
      Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
      Layer.mock(DesktopIpc.DesktopIpc, {}),
      Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {}),
      Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
      Layer.mock(DesktopServerExposure.DesktopServerExposure, {}),
      Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
      Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
      Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
      Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
      Layer.mock(DesktopWslBackend.DesktopWslBackend, {}),
      Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
      Layer.mock(ElectronMenu.ElectronMenu, {}),
      Layer.mock(ElectronShell.ElectronShell, {}),
      Layer.mock(ElectronTheme.ElectronTheme, {}),
      Layer.mock(ElectronWindow.ElectronWindow, {}),
      Layer.mock(LoopbackTunnel.LoopbackTunnel, {}),
      Layer.mock(MacPermissions.MacPermissions, {}),
      Layer.mock(AppleSpeech.AppleSpeech, {}),
      Layer.mock(NetService.NetService, {}),
      Layer.mock(PreviewManager.PreviewManager, {
        isBrowserPartition: () => false,
      }),
    );

    return { signals, layer };
  });

const awaitIndependentElectronWork = (signals: StartupSignals) =>
  Effect.gen(function* () {
    yield* Deferred.await(signals.shellStarted);
    yield* Deferred.await(signals.electronReady);
    yield* Deferred.await(signals.settingsLoaded);
    yield* Deferred.await(signals.menuConfigured);
  });

describe("DesktopApp startup", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect.each([
    {
      label: "Windows",
      scenario: {
        platform: "win32",
        linuxPasswordStoreCommandLine: null,
        preReadyLinuxPasswordStore: null,
      } satisfies StartupScenario,
    },
    {
      label: "Linux with an explicit password-store switch",
      scenario: {
        platform: "linux",
        linuxPasswordStoreCommandLine: "basic",
        preReadyLinuxPasswordStore: null,
      } satisfies StartupScenario,
    },
  ])("$label reaches Electron readiness while the shell environment is pending", ({ scenario }) =>
    Effect.gen(function* () {
      vi.stubEnv("XDG_CURRENT_DESKTOP", "LXQt");
      const { signals, layer } = yield* makeStartupHarness(scenario, () => {});

      yield* Effect.scoped(
        Effect.gen(function* () {
          const startupFiber = yield* Effect.forkChild(DesktopApp.startup);
          yield* awaitIndependentElectronWork(signals);
          assert.isFalse(yield* Deferred.isDone(signals.shellRelease));
          yield* Fiber.join(startupFiber);
          assert.isFalse(yield* Ref.get(signals.shellInterrupted));
          assert.deepEqual(yield* Ref.get(signals.commandLineSwitchCalls), []);
        }).pipe(Effect.provide(layer)),
      );

      // Closing the startup scope must interrupt the pending shell probe.
      assert.isTrue(yield* Ref.get(signals.shellInterrupted));
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
  );

  it.effect("Linux automatic password-store resolution waits for the hydrated environment", () =>
    Effect.gen(function* () {
      vi.stubEnv("XDG_CURRENT_DESKTOP", "LXQt");
      const { signals, layer } = yield* makeStartupHarness(
        {
          platform: "linux",
          linuxPasswordStoreCommandLine: null,
          preReadyLinuxPasswordStore: "kwallet",
        },
        () => vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME"),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const startupFiber = yield* Effect.forkChild(DesktopApp.startup);
          yield* Deferred.await(signals.shellStarted);
          assert.isFalse(yield* Deferred.isDone(signals.electronReady));
          assert.isFalse(yield* Deferred.isDone(signals.settingsLoaded));

          yield* Deferred.succeed(signals.shellRelease, undefined);
          yield* awaitIndependentElectronWork(signals);
          yield* Fiber.join(startupFiber);

          // GNOME selects Electron's protected backend, so the pre-hydration
          // LXQt result must be replaced instead of forcing gnome-libsecret.
          assert.deepEqual(yield* Ref.get(signals.commandLineSwitchCalls), [
            "remove:password-store",
          ]);
        }).pipe(Effect.provide(layer)),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
  );
});

interface StubbedDesktop {
  readonly localEnvironmentEnabled: boolean;
  readonly environment: Partial<DesktopEnvironment.DesktopEnvironment["Service"]>;
  readonly fileSystem: Layer.Layer<FileSystem.FileSystem>;
  readonly record: (event: string) => Effect.Effect<void>;
  readonly windowStarted: Deferred.Deferred<void>;
  readonly registerLinuxUrlHandler: Effect.Effect<void>;
  readonly backends?: ReadonlyArray<{ readonly stop: () => Effect.Effect<void> }>;
  readonly flushRendererHistory?: Effect.Effect<void>;
  readonly tokenRequested?: Deferred.Deferred<void>;
  readonly activationStarted?: Deferred.Deferred<void>;
}

const runStubbedDesktop = (stub: StubbedDesktop) =>
  Effect.gen(function* () {
    const quitting = yield* Ref.make(false);
    const runApp = DesktopApp.program
      .pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
          resolveUserDataPath: Effect.succeed("/isolated/userdata"),
          configure: stub.record("identity"),
        } as DesktopAppIdentity.DesktopAppIdentity["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          setPath: () => Effect.void,
          whenReady: stub.record("ready"),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          showErrorBox: () => Effect.die("unexpected fatal startup error"),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          platform: "linux",
          isDevelopment: false,
          isPackaged: true,
          stateDir: "/isolated/userdata",
          configuredBackendPort: Option.some(3773),
          defaultDesktopSettings: { serverExposureMode: "local-only" },
          ...stub.environment,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: "basic",
        }),
        Effect.provideService(DesktopShellEnvironment.DesktopShellEnvironment, {
          installIntoProcess: Effect.succeed(true),
          awaitDiscovery: Effect.succeed(true),
          awaitUserShellDiscovery: Effect.succeed(true),
          discoveryFinished: Effect.succeed(true),
          updates: Stream.empty,
        }),
        Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
          load: Effect.void,
          get: Effect.succeed({
            localEnvironmentEnabled: stub.localEnvironmentEnabled,
            serverExposureMode: "local-only",
          }),
        } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
        Effect.provideService(DesktopLifecycle.DesktopLifecycle, {
          register: Effect.void,
          relaunch: () => Effect.void,
        }),
        Effect.provideService(DesktopClerk.DesktopClerk, {
          configure: Effect.void,
        } as DesktopClerk.DesktopClerk["Service"]),
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
          selectedStorageBackend: Effect.succeedNone,
        } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]),
        Effect.provideService(PreviewPasskeys.PreviewPasskeys, {
          configure: Effect.void,
        } as PreviewPasskeys.PreviewPasskeys["Service"]),
        Effect.provideService(DesktopApplicationMenu.DesktopApplicationMenu, {
          configure: stub.record("menu"),
        }),
        Effect.provideService(DesktopUpdates.DesktopUpdates, {
          configure: Effect.void,
        } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
        Effect.provideService(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, {
          register: stub.registerLinuxUrlHandler,
        }),
      )
      .pipe(
        Effect.provideService(ElectronProtocol.ElectronProtocol, {
          registerDesktopProtocol: () => Effect.void,
        } as unknown as ElectronProtocol.ElectronProtocol["Service"]),
        Effect.provideService(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
          load: () => Effect.void,
        } as unknown as DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"]),
        Effect.provideService(DesktopSnapShot.DesktopSnapShot, {
          initialize: Effect.void,
        } as DesktopSnapShot.DesktopSnapShot["Service"]),
        Effect.provideService(DesktopState.DesktopState, {
          quitting,
        } as DesktopState.DesktopState["Service"]),
        Effect.provideService(DesktopWindow.DesktopWindow, {
          ensureMain: stub
            .record("window")
            .pipe(Effect.andThen(Deferred.succeed(stub.windowStarted, undefined))),
          createMainIfBackendReady: stub
            .record("window")
            .pipe(Effect.andThen(Deferred.succeed(stub.windowStarted, undefined))),
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Effect.provideService(DesktopBackendPool.DesktopBackendPool, {
          primary: Effect.succeed({
            start: stub.record("backend"),
            currentConfig: Effect.succeedSome({ preflightFailure: Option.none() }),
          }),
          list: Effect.succeed(stub.backends ?? []),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
        Effect.provideService(DesktopServerExposure.DesktopServerExposure, {
          configureFromSettings: () => Effect.succeed({ mode: "local-only" }),
          backendConfig: Effect.succeed({ httpBaseUrl: new URL("http://127.0.0.1:3773") }),
        } as unknown as DesktopServerExposure.DesktopServerExposure["Service"]),
        Effect.provideService(DesktopWslBackend.DesktopWslBackend, {
          reconcile: Effect.void,
        } as DesktopWslBackend.DesktopWslBackend["Service"]),
        Effect.provideService(DesktopAppActivation.DesktopAppActivation, {
          start: stub.activationStarted
            ? Deferred.succeed(stub.activationStarted, undefined)
            : Effect.void,
        } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]),
        Effect.provideService(DesktopRendererHistory.DesktopRendererHistory, {
          shutdown: stub.flushRendererHistory ?? Effect.void,
        } as DesktopRendererHistory.DesktopRendererHistory["Service"]),
      );
    return yield* runApp.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BrowserImport.BrowserImport, {}),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
          Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
          Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
          Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
          Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
          Layer.mock(DesktopIpc.DesktopIpc, {}),
          Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
            getBearerToken: stub
              .record("token")
              .pipe(
                Effect.andThen(
                  stub.tokenRequested
                    ? Deferred.succeed(stub.tokenRequested, undefined)
                    : Effect.void,
                ),
                Effect.as("token"),
              ),
          }),
          Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {}),
          Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
          Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
          Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
          Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
          Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
          Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
          Layer.mock(ElectronMenu.ElectronMenu, {}),
          Layer.mock(ElectronShell.ElectronShell, {}),
          Layer.mock(ElectronTheme.ElectronTheme, {}),
          Layer.mock(ElectronWindow.ElectronWindow, {}),
          Layer.mock(MacPermissions.MacPermissions, {}),
          Layer.mock(AppleSpeech.AppleSpeech, {}),
          Layer.mock(LoopbackTunnel.LoopbackTunnel, {}),
          Layer.mock(PreviewManager.PreviewManager, {
            isBrowserPartition: () => {
              throw new Error("unexpected browser partition lookup");
            },
          }),
          stub.fileSystem,
          Layer.mock(NetService.NetService, {}),
          Path.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected HTTP request")),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });
it.effect.each([false, true])(
  "stops backends together before flushing history and cancels Linux registration, stop defect=%s",
  (stopDefect) =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const registrationStopped = yield* Deferred.make<void>();
      const windowStarted = yield* Deferred.make<void>();
      const firstStopStarted = yield* Deferred.make<void>();
      const secondStopStarted = yield* Deferred.make<void>();
      const releaseStops = yield* Deferred.make<void>();
      const historyStarted = yield* Deferred.make<void>();
      const releaseHistory = yield* Deferred.make<void>();
      const tokenRequested = yield* Deferred.make<void>();
      const events: string[] = [];
      const app = yield* runStubbedDesktop({
        localEnvironmentEnabled: true,
        environment: {},
        fileSystem: FileSystem.layerNoop({}),
        record: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        windowStarted,
        tokenRequested,
        registerLinuxUrlHandler: Deferred.succeed(registrationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRegistration)),
          Effect.ensuring(Deferred.succeed(registrationStopped, undefined)),
        ),
        backends: [
          {
            stop: () =>
              Deferred.succeed(firstStopStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStops)),
                Effect.andThen(stopDefect ? Effect.die("stop defect") : Effect.void),
              ),
          },
          {
            stop: () =>
              Deferred.succeed(secondStopStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStops)),
              ),
          },
        ],
        flushRendererHistory: Deferred.succeed(historyStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseHistory)),
          Effect.asVoid,
        ),
      });
      yield* Deferred.await(registrationStarted);
      yield* Deferred.await(windowStarted);
      yield* Deferred.await(tokenRequested);
      // The backend spawns before menus, and its token is minted without waiting for the renderer.
      assert.deepEqual(
        events.filter((event) => event !== "token"),
        ["identity", "ready", "identity", "backend", "menu", "window"],
      );
      assert.isAbove(events.indexOf("token"), events.indexOf("backend"));
      assert.isFalse(yield* Deferred.isDone(registrationStopped));
      const shutdown = yield* DesktopShutdown.DesktopShutdown;
      yield* shutdown.request;
      yield* Deferred.await(firstStopStarted);
      yield* Deferred.await(secondStopStarted);
      assert.isFalse(yield* Deferred.isDone(historyStarted));
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseStops, undefined);
      yield* Deferred.await(historyStarted);
      assert.isFalse(yield* shutdown.isComplete);
      yield* Deferred.succeed(releaseHistory, undefined);
      const result = yield* Fiber.await(app);
      assert.equal(Exit.isFailure(result), stopDefect);
      assert.isTrue(yield* shutdown.isComplete);
      assert.isTrue(yield* Deferred.isDone(registrationStopped));
    }).pipe(Effect.provide(DesktopShutdown.layer)),
);

it.effect(
  "points a stale t3 launcher at the updated AppImage and accepts t3 <dir> with Local environment off",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-app-" });
      const launcher = DesktopCliShim.launcherPath({
        path,
        baseDir,
        platform: "linux",
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const removedAppImage = path.join(baseDir, "T3-Code-0.1.6-x86_64.AppImage");
      const updatedAppImage = path.join(baseDir, "T3-Code-0.1.7-x86_64.AppImage");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(
        launcher,
        DesktopCliShim.renderCliShim({
          target: { kind: "appimage", appImage: removedAppImage, executableName: "t3code" },
          shimPath: launcher,
          t3Home: baseDir,
        }),
      );
      yield* fs.writeFileString(updatedAppImage, "", { mode: 0o755 });
      const windowStarted = yield* Deferred.make<void>();
      const activationStarted = yield* Deferred.make<void>();

      const app = yield* runStubbedDesktop({
        localEnvironmentEnabled: false,
        activationStarted,
        environment: {
          path,
          baseDir,
          serverRoot: path.join(baseDir, "resources", "app.asar"),
          appImagePath: Option.some(updatedAppImage),
        },
        fileSystem: Layer.succeed(FileSystem.FileSystem, fs),
        record: () => Effect.void,
        windowStarted,
        registerLinuxUrlHandler: Effect.void,
      });
      yield* Deferred.await(windowStarted);
      yield* (yield* DesktopShutdown.DesktopShutdown).request;
      yield* Fiber.join(app);

      const content = yield* fs.readFileString(launcher);
      assert.include(
        content,
        `app='${updatedAppImage}'`,
        "startup left the t3 launcher pointing at the removed AppImage",
      );
      assert.isTrue(
        yield* Deferred.isDone(activationStarted),
        "startup left the t3 <dir> control socket closed",
      );
    }).pipe(Effect.provide(Layer.mergeAll(DesktopShutdown.layer, NodeServices.layer))),
);
