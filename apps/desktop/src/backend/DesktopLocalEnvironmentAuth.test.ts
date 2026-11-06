import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const config = {
  executablePath: "/electron",
  args: [],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  bootstrapDelivery: "fd3",
  extendEnv: true,
  preflightFailure: Option.none(),
} satisfies DesktopBackendManager.DesktopBackendStartConfig;

function backendPoolLayer(options?: {
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly ready?: Effect.Effect<boolean>;
}) {
  const primary: DesktopBackendManager.DesktopBackendInstance = {
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Local environment"),
    currentConfig: Effect.succeedSome(options?.config ?? config),
    waitForReady: () => options?.ready ?? Effect.succeed(true),
    start: Effect.die("unexpected backend start"),
    stop: () => Effect.die("unexpected backend stop"),
    snapshot: Effect.die("unexpected backend snapshot"),
  };
  return Layer.mock(DesktopBackendPool.DesktopBackendPool, {
    primary: Effect.succeed(primary),
    list: Effect.succeed([primary]),
  });
}

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const waiting = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<boolean>();
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const layerTest = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            backendPoolLayer({
              ready: Deferred.succeed(waiting, undefined).pipe(
                Effect.andThen(Deferred.await(ready)),
              ),
            }),
            layerHttpClient,
            NodeCrypto.layerMac,
          ),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const tokens = yield* Effect.all([auth.getBearerToken, auth.getBearerToken]).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(waiting);
        yield* TestClock.adjust(Duration.seconds(16));
        assert.strictEqual(yield* Ref.get(requestCount), 0);
        yield* Deferred.succeed(ready, true);
        return yield* Fiber.join(tokens);
      }).pipe(Effect.provide(layerTest));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "exchanges the current window's token when the backend was launched with a secret",
    () =>
      Effect.gen(function* () {
        const presented = yield* Ref.make<string | null>(null);
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            return Ref.set(presented, new URLSearchParams(body).get("subject_token")).pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      access_token: "desktop-bearer-token",
                      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                      token_type: "Bearer",
                      expires_in: 3600,
                      scope: "orchestration:read",
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              ),
            );
          }),
        );
        const poolLayer = backendPoolLayer({
          config: {
            ...config,
            bootstrap: { ...config.bootstrap, desktopBootstrapSecret: "desktop-secret" },
          },
        });

        yield* TestClock.setTime(DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1);
        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          return yield* auth.getBearerToken;
        }).pipe(
          Effect.provide(
            DesktopLocalEnvironmentAuth.layer.pipe(
              Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer, NodeCrypto.layerMac)),
            ),
          ),
        );

        assert.strictEqual(
          yield* Ref.get(presented),
          yield* currentDesktopBootstrapToken(
            "desktop-secret",
            DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1,
          ).pipe(Effect.provide(NodeCrypto.layerMac)),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const tokenResponse = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          access_token: "desktop-bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const makeExchange = (failures: number, failure: () => Response) =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failures
                ? HttpClientResponse.fromWeb(request, failure())
                : tokenResponse(request),
            ),
          ),
        ),
      );
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(backendPoolLayer(), layerHttpClient, NodeCrypto.layerMac)),
          ),
        ),
      );
      return { auth, requestCount };
    });

  it.effect("authenticates automatically after backend startup exceeds the auth timeout", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const available = yield* Ref.make(false);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.get(available).pipe(
            Effect.map((isAvailable) =>
              isAvailable
                ? tokenResponse(request)
                : HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            ),
          ),
        ),
      );
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                backendPoolLayer({ ready: Deferred.await(ready).pipe(Effect.as(true)) }),
                layerHttpClient,
                NodeCrypto.layerMac,
              ),
            ),
          ),
        ),
      );
      const request = yield* auth.getBearerToken.pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(30));
      assert.isUndefined(request.pollUnsafe());

      yield* Ref.set(available, true);
      yield* Deferred.succeed(ready, undefined);
      assert.deepEqual(yield* Fiber.join(request), Exit.succeed("desktop-bearer-token"));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps transient authentication failures bounded after backend readiness", () =>
    Effect.gen(function* () {
      const { auth } = yield* makeExchange(Infinity, () => new Response(null, { status: 503 }));
      const request = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(16));
      const error = yield* Fiber.join(request);
      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthSessionBootstrapError");
      assert.propertyVal(error.cause, "_tag", "TimeoutError");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails without exchanging a credential when the backend stops before readiness", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<boolean>();
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                backendPoolLayer({ ready: Deferred.await(stopped) }),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("unexpected authentication request")),
                ),
                NodeCrypto.layerMac,
              ),
            ),
          ),
        ),
      );
      const request = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(stopped, false);

      const error = yield* Fiber.join(request);
      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthBackendNotConfiguredError");
    }),
  );

  it.effect("resumes local authentication promptly when a starting backend becomes available", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        1,
        () => new Response(null, { status: 503 }),
      );
      const delivered = yield* Ref.make(false);
      yield* auth.getBearerToken.pipe(
        Effect.tap(() => Ref.set(delivered, true)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.millis(100));
      assert.isTrue(yield* Ref.get(delivered));
      assert.strictEqual(yield* Ref.get(requestCount), 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejected bootstrap credential", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(1, () =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-1",
          },
          { status: 401 },
        ),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthSessionBootstrapError");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
