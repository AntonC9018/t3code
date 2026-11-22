import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { shell } from "electron";

const DOLPHIN_SERVICE = /^org\.kde\.dolphin-\d+$/;
const DOLPHIN_WINDOW = /^\/dolphin\/Dolphin_\d+$/;

const busctl = Effect.fnUntraced(function* (...args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make("busctl", ["--user", ...args], { stdin: "ignore", stderr: "ignore" }),
  );
});

const lines = (output: string) => output.split("\n").map((line) => line.trim());

const dolphinShowsDirectory = Effect.fn("revealDownload.dolphinShowsDirectory")(function* (
  directory: string,
) {
  const url = NodeURL.pathToFileURL(directory).href;
  const services = lines(yield* busctl("list", "--no-legend", "--acquired"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => DOLPHIN_SERVICE.test(name));
  for (const service of services) {
    const windows = lines(yield* busctl("tree", "--list", service)).filter((objectPath) =>
      DOLPHIN_WINDOW.test(objectPath),
    );
    for (const mainWindow of windows) {
      const reply = yield* busctl(
        "call",
        service,
        mainWindow,
        "org.kde.dolphin.MainWindow",
        "isUrlOpen",
        "s",
        url,
      );
      if (reply.trim() === "b true") return true;
    }
  }
  return false;
});

// Dolphin raises its window on every reveal, so skip it when the folder is already open.
export const revealDownload = Effect.fn("revealDownload")(function* (
  target: string,
  directory: string,
) {
  const platform = yield* HostProcess.Platform;
  const alreadyShown =
    platform === "linux" &&
    (yield* dolphinShowsDirectory(directory).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => false),
    ));
  if (!alreadyShown) shell.showItemInFolder(target);
});
