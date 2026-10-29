import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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

vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({
  installDesktopIpcHandlers: () => Effect.void,
}));

vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({
  listen: Effect.void,
}));

import { startup } from "./DesktopApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

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
                  linuxWmClass: "t3code",
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
        }),
      ),
      Layer.mock(ElectronApp.ElectronApp, {
        whenReady: Deferred.succeed(signals.electronReady, undefined).pipe(Effect.asVoid),
        quit: Effect.void,
        setPath: () => Effect.void,
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
      Layer.mock(DesktopUpdates.DesktopUpdates, { configure: Effect.void }),
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
      Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
      Layer.mock(DesktopBackendPool.DesktopBackendPool, {}),
      Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
      Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
      Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
      Layer.mock(DesktopIpc.DesktopIpc, {}),
      Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {}),
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
      Layer.mock(MacPermissions.MacPermissions, {}),
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
          const startupFiber = yield* Effect.forkChild(startup);
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
          const startupFiber = yield* Effect.forkChild(startup);
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
