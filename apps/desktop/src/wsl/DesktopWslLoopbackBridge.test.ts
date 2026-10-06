import * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopWslLoopbackBridge from "./DesktopWslLoopbackBridge.ts";

const echoServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeNet.Server>((resolve) => {
        const server = NodeNet.createServer((socket) =>
          socket.on("data", (data) => socket.write(data)),
        );
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
);

const serverUrl = (server: NodeNet.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing echo server address");
  return new URL(`http://127.0.0.1:${address.port}/`);
};

it.effect("forwards arbitrary bidirectional bytes through Windows loopback", () =>
  Effect.gen(function* () {
    const server = yield* echoServer;
    const bridge = yield* Effect.acquireRelease(
      DesktopWslLoopbackBridge.start(serverUrl(server)),
      (bridge) => bridge.stop,
    );
    const payload = Buffer.from([0, 255, 1, 2, 128, 13, 10, 99]);
    const received = yield* Effect.promise(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          const socket = NodeNet.createConnection({
            host: bridge.httpBaseUrl.hostname,
            port: Number(bridge.httpBaseUrl.port),
          });
          const chunks: Buffer[] = [];
          socket.once("error", reject);
          socket.once("connect", () => socket.write(payload));
          socket.on("data", (data) => {
            chunks.push(data);
            if (Buffer.concat(chunks).length === payload.length) {
              socket.destroy();
              resolve(Buffer.concat(chunks));
            }
          });
        }),
    );
    assert.deepEqual(received, payload);
  }).pipe(Effect.scoped),
);

it.effect("closes active client sockets when the desktop service scope ends", () =>
  Effect.gen(function* () {
    const server = yield* echoServer;
    let closed: Promise<void> | undefined;
    yield* Effect.gen(function* () {
      const service = yield* DesktopWslLoopbackBridge.DesktopWslLoopbackBridge;
      const bridge = yield* service.start(serverUrl(server));
      const socket = yield* Effect.promise(
        () =>
          new Promise<NodeNet.Socket>((resolve, reject) => {
            const socket = NodeNet.createConnection({
              host: bridge.httpBaseUrl.hostname,
              port: Number(bridge.httpBaseUrl.port),
            });
            socket.once("error", reject);
            socket.once("connect", () => resolve(socket));
          }),
      );
      closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.resume();
    }).pipe(Effect.provide(DesktopWslLoopbackBridge.layer), Effect.scoped);
    if (!closed) return yield* Effect.die("Expected an active bridge client");
    yield* Effect.promise(() => closed!);
  }).pipe(Effect.scoped),
);
