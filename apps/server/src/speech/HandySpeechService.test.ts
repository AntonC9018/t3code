import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as HandySpeechService from "./HandySpeechService.ts";
import { MAX_SPEECH_BYTES } from "./SpeechService.ts";

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

function fixture(
  options: {
    status?: number;
    text?: string;
    texts?: ReadonlyArray<string>;
    ready?: boolean;
    onTranscription?: () => Effect.Effect<void>;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let activeTranscriptions = 0;
  let maxConcurrentTranscriptions = 0;
  let transcriptionCount = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(new URL(request.url).origin).toBe(origin);
      requests.push(request);
      const path = new URL(request.url).pathname;
      const response = HttpClientResponse.fromWeb(
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
              ? {
                  text: options.texts?.[transcriptionCount] ?? options.text ?? " Hello Handy ",
                }
              : { models: [model] },
          { status: path === "/transcribe" ? (options.status ?? 200) : 200 },
        ),
      );
      if (path !== "/transcribe") return response;
      transcriptionCount += 1;
      activeTranscriptions += 1;
      maxConcurrentTranscriptions = Math.max(maxConcurrentTranscriptions, activeTranscriptions);
      return yield* (options.onTranscription?.() ?? Effect.promise(() => Promise.resolve())).pipe(
        Effect.as(response),
        Effect.ensuring(Effect.sync(() => (activeTranscriptions -= 1))),
      );
    }),
  );
  return {
    requests,
    activeTranscriptions: () => activeTranscriptions,
    maxConcurrentTranscriptions: () => maxConcurrentTranscriptions,
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
        supportsStreaming: true,
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

  it.effect("streams cumulative previews and transcribes the full recording on finish", () =>
    Effect.gen(function* () {
      const test = fixture({ texts: [" partial words ", " final words "] });
      const service = yield* test.service;
      const previewChunk = new Uint8Array(new Float32Array(16_000).fill(0.25).buffer);
      expect(yield* service.status).toMatchObject({ supportsStreaming: true });
      expect((yield* service.models).models[0]).toMatchObject({ supportsStreaming: true });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* service.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          expect(yield* stream.feed(previewChunk)).toEqual({ revision: 1, text: null });
          expect(
            test.requests.filter((request) => new URL(request.url).pathname === "/transcribe"),
          ).toHaveLength(0);
          expect(yield* stream.feed(previewChunk)).toEqual({
            revision: 2,
            text: { committed: "", tentative: "partial words" },
          });
          expect(yield* stream.finish).toBe("final words");
        }),
      );

      const transcriptionRequests = test.requests.filter(
        (request) => new URL(request.url).pathname === "/transcribe",
      );
      expect(transcriptionRequests).toHaveLength(2);
      for (const request of transcriptionRequests) {
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") expect(request.body.body.byteLength).toBe(128_000);
        expect(request.headers["x-speech-language"]).toBe(
          DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS.speechLanguage,
        );
      }
    }),
  );

  it.effect("serializes cumulative transcription requests across concurrent feeds", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      const previewChunk = new Uint8Array(new Float32Array(16_000).fill(0.25).buffer);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* service.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          yield* Effect.all(
            Array.from({ length: 4 }, () => stream.feed(previewChunk)),
            { concurrency: "unbounded" },
          );
          expect(test.maxConcurrentTranscriptions()).toBe(1);
          expect(
            test.requests.filter((request) => new URL(request.url).pathname === "/transcribe"),
          ).toHaveLength(2);
          yield* stream.finish;
        }),
      );
    }),
  );

  it.effect("bounds previews and rolls recordings longer than five minutes", () =>
    Effect.gen(function* () {
      const test = fixture({ text: " segment " });
      const service = yield* test.service;
      const chunk = new Uint8Array(new Float32Array(16_000).fill(0.25).buffer);
      const previewMaxBytes = 16 * 16_000 * Float32Array.BYTES_PER_ELEMENT;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* service.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          for (let second = 0; second < 301; second++) yield* stream.feed(chunk);
          expect(yield* stream.finish).toBe("segment segment");
        }),
      );

      const transcriptionRequests = test.requests.filter(
        (request) => new URL(request.url).pathname === "/transcribe",
      );
      const requestBytes = transcriptionRequests.map((request) => {
        expect(request.body._tag).toBe("Uint8Array");
        return request.body._tag === "Uint8Array" ? request.body.body.byteLength : 0;
      });
      expect(requestBytes.some((byteLength) => byteLength === MAX_SPEECH_BYTES)).toBe(true);
      expect(requestBytes.slice(0, -2).every((byteLength) => byteLength <= previewMaxBytes)).toBe(
        true,
      );
      expect(requestBytes.at(-1)).toBe(64_000);
    }),
  );

  it.effect("keeps empty streams request-free and enforces the chunk limit", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* service.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          const emptyFeed = yield* stream.feed(new Uint8Array()).pipe(Effect.flip);
          expect(emptyFeed._tag).toBe("SpeechInvalidAudioError");
          const oversizedFeed = yield* stream
            .feed(new Uint8Array(SPEECH_STREAM_MAX_CHUNK_BYTES + 4))
            .pipe(Effect.flip);
          expect(oversizedFeed._tag).toBe("SpeechInvalidAudioError");
          expect(yield* stream.finish).toBe("");
        }),
      );
      expect(
        test.requests.filter((request) => new URL(request.url).pathname === "/transcribe"),
      ).toHaveLength(0);
    }),
  );

  it.effect("cancels an in-flight preview request when its feed fiber is interrupted", () =>
    Effect.gen(function* () {
      const transcriptionStarted = yield* Deferred.make<void>();
      const neverReleased = yield* Deferred.make<void>();
      const test = fixture({
        onTranscription: () =>
          Deferred.succeed(transcriptionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(neverReleased)),
          ),
      });
      const service = yield* test.service;
      const chunk = new Uint8Array(new Float32Array(16_000).fill(0.25).buffer);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* service.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          yield* stream.feed(chunk);
          const previewFiber = yield* stream.feed(chunk).pipe(Effect.forkChild);
          yield* Deferred.await(transcriptionStarted);
          yield* Fiber.interrupt(previewFiber);
          expect(test.activeTranscriptions()).toBe(0);
        }),
      );
      expect(test.activeTranscriptions()).toBe(0);
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
