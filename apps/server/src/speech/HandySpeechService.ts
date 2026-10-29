import {
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
  SpeechGpuDevice,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type SpeechStreamText,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as SpeechService from "./SpeechService.ts";
import { decodeSpeechPcm, MAX_SPEECH_BYTES } from "./SpeechService.ts";
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
const STREAM_PREVIEW_INTERVAL_BYTES = 2 * 16_000 * Float32Array.BYTES_PER_ELEMENT;
const STREAM_PREVIEW_MAX_BYTES = 16 * 16_000 * Float32Array.BYTES_PER_ELEMENT;

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
      supportsStreaming: true,
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
        supportsStreaming: true,
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
  const control = (payload: { action: string; model_id?: string; value?: string }) =>
    request(
      HttpClientRequest.post(`${origin}/control`).pipe(HttpClientRequest.bodyJsonUnsafe(payload)),
      Schema.Unknown,
      "control",
    );
  const transcribePcm = Effect.fn("HandySpeechService.transcribePcm")(function* (
    pcmBytes: Uint8Array,
    options: SpeechTranscriptionOptions,
  ) {
    const pcm = yield* Effect.try({
      try: () => decodeSpeechPcm(pcmBytes),
      catch: (cause) =>
        isSpeechInvalidAudioError(cause)
          ? cause
          : new SpeechService.SpeechOperationError({ operation: "Handy audio", cause }),
    });
    if (pcm.length === 0) return "";
    const result = yield* request(
      HttpClientRequest.post(`${origin}/transcribe`).pipe(
        HttpClientRequest.bodyUint8Array(new Uint8Array(pcm.buffer), "application/octet-stream"),
        HttpClientRequest.setHeader("X-Speech-Language", options.speechLanguage),
        HttpClientRequest.setHeader("X-Speech-Translate", String(options.speechTranslateToEnglish)),
      ),
      Transcript,
      "transcription",
    ).pipe(
      Effect.catchTags({
        SpeechOperationError: Effect.fnUntraced(function* (error) {
          if (error.cause === "Handy is busy.") {
            return yield* new SpeechService.SpeechBusyError({ operation: "transcription" });
          }
          return yield* error;
        }),
      }),
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
  });
  return SpeechService.SpeechService.of({
    status,
    models,
    downloadModel: Effect.fn("HandySpeechService.downloadModel")((modelId) =>
      select(modelId, true),
    ),
    selectModel: Effect.fn("HandySpeechService.selectModel")((modelId) => select(modelId, false)),
    prepareModel: status.pipe(
      Effect.flatMap((snapshot) =>
        snapshot.supported && snapshot.state === "missing-model"
          ? Effect.fail(new SpeechService.SpeechModelNotFoundError({ modelId: snapshot.modelId }))
          : Effect.void,
      ),
    ),
    transcribe: Effect.fn("HandySpeechService.transcribe")((pcmBytes, options) =>
      transcribePcm(pcmBytes, options),
    ),
    startStream: Effect.fn("HandySpeechService.startStream")(function* (
      options: SpeechTranscriptionOptions,
    ) {
      const serial = yield* Semaphore.make(1);
      const batchChunks: Uint8Array[] = [];
      const previewChunks: Uint8Array[] = [];
      const finalizedTranscripts: string[] = [];
      let batchBytes = 0;
      let previewBytes = 0;
      let lastPreviewBytes = 0;
      let finalizedPreviewText = "";
      let revision = 0;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          batchChunks.length = 0;
          previewChunks.length = 0;
          finalizedTranscripts.length = 0;
          batchBytes = 0;
          previewBytes = 0;
        }),
      );
      const snapshot = (chunks: ReadonlyArray<Uint8Array>, byteLength: number) => {
        const audio = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return audio;
      };
      const cumulativePreview = (segmentText: string) =>
        [...finalizedTranscripts, finalizedPreviewText, segmentText]
          .filter((text) => text.length > 0)
          .join(" ");
      const ensureOpen = () =>
        closed
          ? Effect.fail(
              new SpeechService.SpeechOperationError({
                operation: "Handy streaming transcription",
                cause: "Speech stream is closed.",
              }),
            )
          : Effect.void;
      return {
        feed: (pcmBytes: Uint8Array) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              yield* ensureOpen();
              if (pcmBytes.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES) {
                return yield* new SpeechService.SpeechInvalidAudioError({
                  byteLength: pcmBytes.byteLength,
                  message: "Speech stream chunk size limit exceeded.",
                });
              }
              const pcm = yield* Effect.try({
                try: () => decodeSpeechPcm(pcmBytes, true),
                catch: (cause) =>
                  isSpeechInvalidAudioError(cause)
                    ? cause
                    : new SpeechService.SpeechOperationError({ operation: "Handy audio", cause }),
              });
              if (batchBytes + pcm.byteLength > MAX_SPEECH_BYTES) {
                const completed = yield* transcribePcm(snapshot(batchChunks, batchBytes), options);
                if (completed.length > 0) finalizedTranscripts.push(completed);
                batchChunks.length = 0;
                batchBytes = 0;
                previewChunks.length = 0;
                previewBytes = 0;
                lastPreviewBytes = 0;
                finalizedPreviewText = "";
              }
              const chunk = new Uint8Array(pcm.buffer);
              batchChunks.push(chunk);
              batchBytes += pcm.byteLength;
              previewChunks.push(chunk);
              previewBytes += pcm.byteLength;
              let text: SpeechStreamText | null = null;
              if (
                previewBytes - lastPreviewBytes >= STREAM_PREVIEW_INTERVAL_BYTES ||
                previewBytes >= STREAM_PREVIEW_MAX_BYTES
              ) {
                const segmentText = yield* transcribePcm(
                  snapshot(previewChunks, previewBytes),
                  options,
                );
                lastPreviewBytes = previewBytes;
                const tentative = cumulativePreview(segmentText);
                if (tentative.length > 0) text = { committed: "", tentative };
                if (previewBytes >= STREAM_PREVIEW_MAX_BYTES) {
                  if (segmentText.length > 0) {
                    finalizedPreviewText = [finalizedPreviewText, segmentText]
                      .filter((part) => part.length > 0)
                      .join(" ");
                  }
                  previewChunks.length = 0;
                  previewBytes = 0;
                  lastPreviewBytes = 0;
                }
              }
              return { revision: ++revision, text };
            }),
          ),
        finish: serial.withPermits(1)(
          Effect.gen(function* () {
            yield* ensureOpen();
            closed = true;
            if (batchBytes > 0) {
              const completed = yield* transcribePcm(snapshot(batchChunks, batchBytes), options);
              if (completed.length > 0) finalizedTranscripts.push(completed);
            }
            batchChunks.length = 0;
            previewChunks.length = 0;
            batchBytes = 0;
            previewBytes = 0;
            return finalizedTranscripts.join(" ");
          }),
        ),
      } satisfies SpeechService.SpeechStream;
    }),
    cancelDownload: Effect.fn("HandySpeechService.cancelDownload")((modelId) =>
      control({ action: "cancel_download", model_id: modelId }).pipe(Effect.andThen(models)),
    ),
    removeModel: Effect.fn("HandySpeechService.removeModel")((modelId) =>
      control({ action: "remove_model", model_id: modelId }).pipe(Effect.andThen(models)),
    ),
    updateAcceleration: Effect.fn("HandySpeechService.updateAcceleration")((acceleration) =>
      control({ action: "acceleration", value: acceleration }).pipe(Effect.andThen(status)),
    ),
    updateModelUnloadTimeout: Effect.fn("HandySpeechService.updateModelUnloadTimeout")((timeout) =>
      control({ action: "unload_timeout", value: timeout }).pipe(Effect.andThen(status)),
    ),
  });
});
