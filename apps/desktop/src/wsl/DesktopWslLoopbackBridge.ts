import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WslLoopbackBridgeError extends Schema.TaggedError<WslLoopbackBridgeError>()(
  "WslLoopbackBridgeError",
  { cause: Schema.Defect() },
) {}

export interface Bridge {
  readonly httpBaseUrl: URL;
  readonly stop: Effect.Effect<void>;
}

export class DesktopWslLoopbackBridge extends Context.Service<
  DesktopWslLoopbackBridge,
  {
    readonly start: (target: URL) => Effect.Effect<Bridge, WslLoopbackBridgeError>;
  }
>()("@t3tools/desktop/wsl/DesktopWslLoopbackBridge") {}

// Tailscale's Windows service cannot reliably dial a WSL NAT address. Keep its
// target on Windows loopback and forward raw TCP so HTTP and WebSockets share
// the same path. The desktop owns every socket and closes them on shutdown.
export const start = (target: URL): Effect.Effect<Bridge, WslLoopbackBridgeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Bridge>((resolve, reject) => {
        const sockets = new Set<NodeNet.Socket>();
        const server = NodeNet.createServer((incoming) => {
          const outgoing = NodeNet.createConnection({
            host: target.hostname,
            port: Number(target.port),
          });
          for (const socket of [incoming, outgoing]) {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => {
              incoming.destroy();
              outgoing.destroy();
            });
          }
          incoming.on("close", () => outgoing.destroy());
          outgoing.on("close", () => incoming.destroy());
          incoming.pipe(outgoing);
          outgoing.pipe(incoming);
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            server.close();
            reject(new Error("WSL bridge did not expose a loopback port."));
            return;
          }
          const stop = Effect.promise(
            () =>
              new Promise<void>((done) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => done());
              }),
          );
          resolve({ httpBaseUrl: new URL(`http://127.0.0.1:${address.port}/`), stop });
        });
      }),
    catch: (cause) => new WslLoopbackBridgeError({ cause }),
  });

export const layer = Layer.effect(
  DesktopWslLoopbackBridge,
  Effect.gen(function* () {
    const bridges = new Set<Bridge>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach(bridges, (bridge) => bridge.stop, { discard: true }),
    );
    return DesktopWslLoopbackBridge.of({
      start: (target) =>
        start(target).pipe(
          Effect.map((bridge) => {
            bridges.add(bridge);
            return {
              ...bridge,
              stop: bridge.stop.pipe(
                Effect.andThen(Effect.sync(() => bridges.delete(bridge))),
                Effect.asVoid,
              ),
            };
          }),
        ),
    });
  }),
);
