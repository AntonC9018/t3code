import {
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
  SpeechGpuDevice,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as SpeechService from "./SpeechService.ts";
import {
  applySpeechAliases,
  applySpeechCustomWords,
  normalizeSpeechCustomWords,
  transcriptionCustomWords,
} from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";

const HandyModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  size_mb: Schema.Finite,
  is_downloaded: Schema.Boolean,
  is_downloading: Schema.Boolean,
  accuracy_score: Schema.Finite,
  speed_score: Schema.Finite,
  is_recommended: Schema.Boolean,
  supported_languages: Schema.Array(Schema.String),
  supports_translation: Schema.Boolean,
  supports_language_detection: Schema.Boolean,
});
const HandyModels = Schema.Struct({ models: Schema.Array(HandyModel) });
const HandyStatus = Schema.Struct({
  ready: Schema.Boolean,
  busy: Schema.Boolean,
  model_id: Schema.NullOr(Schema.String),
  model: Schema.NullOr(HandyModel),
  acceleration: SpeechAcceleration,
  model_unload_timeout: SpeechModelUnloadTimeout,
  gpu_devices: Schema.Array(SpeechGpuDevice),
});
const Transcript = Schema.Struct({ text: Schema.String });
const isSpeechInvalidAudioError = Schema.is(SpeechService.SpeechInvalidAudioError);

export const make = Effect.fn("HandySpeechService.make")(function* (url: string, token: string) {
  const origin = yield* Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "127.0.0.1" ||
        parsed.pathname !== "/" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error("Handy must use an HTTP IPv4 loopback origin.");
      }
      if (!/^[a-zA-Z0-9]{32,}$/.test(token))
        throw new Error("Handy requires a separate local server token.");
      return parsed.origin;
    },
    catch: (cause) =>
      new SpeechService.SpeechOperationError({ operation: "Handy configuration", cause }),
  });
  const client = yield* HttpClient.HttpClient;
  const request = <A, I>(
    input: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    operation: string,
    timeout: Duration.Input = "3 minutes",
  ) =>
    client
      .execute(input.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.scoped,
        Effect.timeout(timeout),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(
          (cause) =>
            new SpeechService.SpeechOperationError({
              operation: `Handy ${operation}`,
              // HttpClient failures retain the request, including its bearer
              // header. Keep that private token out of errors/logged causes.
              cause:
                HttpClientError.isHttpClientError(cause) && cause.response?.status === 409
                  ? "Handy is busy."
                  : "Handy HTTP request failed.",
            }),
        ),
      );
  const readStatus = request(
    HttpClientRequest.get(`${origin}/status`),
    HandyStatus,
    "status",
    "5 seconds",
  );
  const status = readStatus.pipe(
    Effect.map((remote): EnvironmentSpeechStatus => ({
      supported: true,
      state: !remote.ready ? "missing-model" : remote.busy ? "transcribing" : "ready",
      modelId: remote.model_id || "handy",
      model: remote.model?.name ?? "Handy",
      size: (remote.model?.size_mb ?? 0) * 1024 * 1024,
      supportsStreaming: false,
      supportsTranslation: remote.model?.supports_translation ?? false,
      supportsLanguageDetection: remote.model?.supports_language_detection ?? true,
      languages: remote.model?.supported_languages ?? [],
      acceleration: remote.acceleration,
      modelUnloadTimeout: remote.model_unload_timeout,
      gpuDevices: remote.gpu_devices,
    })),
  );
  const models = Effect.gen(function* () {
    const remote = yield* request(
      HttpClientRequest.get(`${origin}/models`),
      HandyModels,
      "models",
      "5 seconds",
    );
    const selected = yield* readStatus;
    return {
      models: remote.models.map((model): EnvironmentSpeechModel => ({
        id: model.id,
        name: model.name,
        description: model.description,
        size: model.size_mb * 1024 * 1024,
        languages: model.supported_languages,
        accuracy: model.accuracy_score,
        speed: model.speed_score,
        recommended: model.is_recommended,
        supportsStreaming: false,
        supportsTranslation: model.supports_translation,
        supportsLanguageDetection: model.supports_language_detection,
        supportsRecognitionHints: false,
        active: model.id === selected.model_id,
        state: model.is_downloading
          ? "downloading"
          : model.is_downloaded
            ? "installed"
            : "downloadable",
      })),
    };
  });
  const select = (modelId: string, download: boolean) =>
    request(
      HttpClientRequest.post(`${origin}/model`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ model_id: modelId, download }),
      ),
      HandyModels,
      "model selection",
      download ? "15 minutes" : "3 minutes",
    ).pipe(Effect.andThen(models));
  const managedInHandy = (operation: string) =>
    Effect.fail(
      new SpeechService.SpeechOperationError({
        operation,
        cause: "This setting is managed by Handy.",
      }),
    );
  const control = (payload: { action: string; model_id?: string; value?: string }) =>
    request(
      HttpClientRequest.post(`${origin}/control`).pipe(HttpClientRequest.bodyJsonUnsafe(payload)),
      Schema.Unknown,
      "control",
    );
  return SpeechService.SpeechService.of({
    status,
    models,
    downloadModel: (modelId) => select(modelId, true),
    selectModel: (modelId) => select(modelId, false),
    prepareModel: status.pipe(
      Effect.flatMap((snapshot) =>
        snapshot.supported && snapshot.state === "missing-model"
          ? Effect.fail(new SpeechService.SpeechModelNotFoundError({ modelId: snapshot.modelId }))
          : Effect.void,
      ),
    ),
    transcribe: (pcmBytes, options) =>
      Effect.gen(function* () {
        const pcm = yield* Effect.try({
          try: () => SpeechService.decodeSpeechPcm(pcmBytes),
          catch: (cause) =>
            isSpeechInvalidAudioError(cause)
              ? cause
              : new SpeechService.SpeechOperationError({ operation: "Handy audio", cause }),
        });
        if (pcm.length === 0) return "";
        const result = yield* request(
          HttpClientRequest.post(`${origin}/transcribe`).pipe(
            HttpClientRequest.bodyUint8Array(
              new Uint8Array(pcm.buffer),
              "application/octet-stream",
            ),
            HttpClientRequest.setHeader("X-Speech-Language", options.speechLanguage),
            HttpClientRequest.setHeader(
              "X-Speech-Translate",
              String(options.speechTranslateToEnglish),
            ),
          ),
          Transcript,
          "transcription",
        ).pipe(
          Effect.catchTag(
            "SpeechOperationError",
            Effect.fnUntraced(function* (error) {
              if (error.cause === "Handy is busy.") {
                return yield* new SpeechService.SpeechBusyError({ operation: "transcription" });
              }
              return yield* error;
            }),
          ),
        );
        const dictionary = normalizeSpeechCustomWords(options.speechCustomWords);
        const corrected = applySpeechAliases(
          applySpeechCustomWords(result.text, transcriptionCustomWords(options)),
          dictionary,
        );
        return (
          options.speechRemoveFillerWords
            ? removeSpeechFillerWords(
                corrected,
                options.speechLanguage,
                options.speechPostProcessingEnabled ? options.speechCorrectionWord : undefined,
              )
            : corrected
        ).trim();
      }),
    startStream: () => managedInHandy("Handy streaming"),
    cancelDownload: (modelId) =>
      control({ action: "cancel_download", model_id: modelId }).pipe(Effect.andThen(models)),
    removeModel: (modelId) =>
      control({ action: "remove_model", model_id: modelId }).pipe(Effect.andThen(models)),
    updateAcceleration: (acceleration) =>
      control({ action: "acceleration", value: acceleration }).pipe(Effect.andThen(status)),
    updateModelUnloadTimeout: (timeout) =>
      control({ action: "unload_timeout", value: timeout }).pipe(Effect.andThen(status)),
  });
});
