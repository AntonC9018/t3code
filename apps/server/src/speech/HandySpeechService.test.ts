import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as HandySpeechService from "./HandySpeechService.ts";

const origin = "http://127.0.0.1:8003";
const token = "0123456789abcdef0123456789abcdef";
const model = {
  id: "parakeet-test",
  name: "Parakeet test",
  description: "Fixture model",
  size_mb: 178,
  is_downloaded: true,
  is_downloading: false,
  accuracy_score: 0.9,
  speed_score: 0.95,
  is_recommended: true,
  supported_languages: ["en", "ru"],
  supports_translation: false,
  supports_language_detection: true,
};
const audio = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function fixture(options: { status?: number; text?: string; ready?: boolean } = {}) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(new URL(request.url).origin).toBe(origin);
      requests.push(request);
      const path = new URL(request.url).pathname;
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          path === "/status"
            ? {
                ready: options.ready ?? true,
                busy: false,
                model_id: model.id,
                model,
                acceleration: "cpu",
                model_unload_timeout: "min_5",
                gpu_devices: [],
              }
            : path === "/transcribe"
              ? { text: options.text ?? " Hello Handy " }
              : { models: [model] },
          { status: path === "/transcribe" ? (options.status ?? 200) : 200 },
        ),
      );
    }),
  );
  return {
    requests,
    service: HandySpeechService.make(origin, token).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    ),
  };
}

describe("HandySpeechService", () => {
  it.effect("sends validated PCM and per-request language options to the local backend", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      expect(
        yield* service.transcribe(audio, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "ru",
          speechTranslateToEnglish: true,
        }),
      ).toBe("Hello Handy");
      expect(test.requests).toHaveLength(1);
      const request = test.requests[0]!;
      expect(request.headers["x-speech-language"]).toBe("ru");
      expect(request.headers["x-speech-translate"]).toBe("true");
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array") expect(request.body.body).toEqual(audio);
    }),
  );

  it.effect("rejects malformed audio before any HTTP request and skips silence", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      const invalid = yield* service
        .transcribe(new Uint8Array(3), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.flip);
      expect(invalid._tag).toBe("SpeechInvalidAudioError");
      expect(
        yield* service.transcribe(new Uint8Array(64), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      ).toBe("");
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("preserves a busy response as a domain error", () =>
    Effect.gen(function* () {
      const service = yield* fixture({ status: 409 }).service;
      const error = yield* service
        .transcribe(audio, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.flip);
      expect(error._tag).toBe("SpeechBusyError");
    }),
  );

  it.effect("maps unavailable inference to a recoverable operation error", () =>
    Effect.gen(function* () {
      const service = yield* fixture({ status: 503 }).service;
      const error = yield* service
        .transcribe(audio, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.flip);
      expect(error._tag).toBe("SpeechOperationError");
      expect(yield* encodeJson(error)).not.toContain(token);
    }),
  );

  it.effect("lists Handy models and requests catalog-based model selection", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      const result = yield* service.downloadModel(model.id);
      expect(result.models[0]).toMatchObject({
        id: model.id,
        active: true,
        state: "installed",
        supportsStreaming: false,
      });
      const selection = test.requests.find((request) => request.method === "POST")!;
      if (selection.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
      const selectionBody = yield* decodeJson(new TextDecoder().decode(selection.body.body));
      expect(selectionBody).toEqual({ model_id: model.id, download: true });
      expect(yield* service.status).toMatchObject({
        state: "ready",
        languages: ["en", "ru"],
        size: 178 * 1024 * 1024,
        acceleration: "cpu",
        modelUnloadTimeout: "min_5",
      });
    }),
  );

  it.effect("reports a missing model before preparing inference", () =>
    Effect.gen(function* () {
      const service = yield* fixture({ ready: false }).service;
      const error = yield* service.prepareModel.pipe(Effect.flip);
      expect(error._tag).toBe("SpeechModelNotFoundError");
    }),
  );

  it.effect("rejects remote destinations and invalid tokens during configuration", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://192.168.1.2:8003",
        "http://localhost:8003",
        "https://127.0.0.1:8003",
        `${origin}/api`,
        `${origin}/?secret=x`,
      ]) {
        const error = yield* HandySpeechService.make(url, token).pipe(Effect.flip);
        expect(error._tag).toBe("SpeechOperationError");
      }
      const error = yield* HandySpeechService.make(origin, "short").pipe(Effect.flip);
      expect(error._tag).toBe("SpeechOperationError");
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
    ),
  );
});
