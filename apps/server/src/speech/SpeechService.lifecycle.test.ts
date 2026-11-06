import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type SpeechTranscriptionOptions,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechService from "./SpeechService.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsLongForm: false,
  supportsTranslation: true,
  supportsVocabulary: false,
  begin: vi.fn(
    async (
      _options?: unknown,
      _filterSilence?: boolean,
      _vadPath?: string,
      _correction?: unknown,
    ) => {},
  ),
  feed: vi.fn(async (_pcm: Float32Array) => ({
    revision: 1,
    text: { committed: "", tentative: "hello" },
  })),
  finish: vi.fn(async () => "hello"),
  reset: vi.fn(async () => {}),
  dispose: vi.fn(),
  transcribe: vi.fn(async (_pcm: Float32Array, _options?: unknown) => ({ text: "hello" })),
}));
const loadNative = vi.hoisted(() =>
  vi.fn(
    async (
      _path: string,
      _signal: AbortSignal,
      _moduleUrl?: string,
      backend: "auto" | "cpu" = "auto",
    ) => {
      native.backend = backend === "cpu" ? "CPU" : "Vulkan0";
      return native;
    },
  ),
);
const readyModels = vi.hoisted(() => new Set(["test-model", "fallback-model"]));
const modelDefinitions = vi.hoisted(() => [
  {
    id: "test-model",
    name: "test",
    description: "test",
    size: 4,
    languages: ["en", "fr"],
    accuracy: 1,
    speed: 1,
    recommended: true,
    supportsStreaming: true,
    supportsLanguageDetection: false,
    supportsTranslation: true,
  },
  {
    id: "fallback-model",
    name: "fallback",
    description: "fallback",
    size: 8,
    languages: ["en"],
    accuracy: 2,
    speed: 2,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
  },
]);
vi.mock("./native.ts", () => ({
  loadNativeSpeechModel: loadNative,
  listNativeSpeechGpuDevices: vi.fn(async () => [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }]),
}));
vi.mock("./model.ts", () => ({
  DEFAULT_SPEECH_MODEL_ID: "test-model",
  SPEECH_MODELS: modelDefinitions,
  getSpeechModel: (modelId: string) => modelDefinitions.find((model) => model.id === modelId),
  effectiveSpeechLanguage: (model: { languages: string[] }, intent: string) =>
    intent !== "auto" && model.languages.includes(intent) ? intent : "en",
}));
const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(() =>
  Effect.succeed("test.gguf"),
);
const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: (model) => Effect.sync(() => readyModels.has(model.id)),
    installedPath: (model) =>
      Effect.sync(() => (readyModels.has(model.id) ? "test.gguf" : undefined)),
    download,
    remove: (model) =>
      Effect.sync(() => {
        readyModels.delete(model.id);
      }),
  }),
);
const layer = SpeechService.layer.pipe(
  Layer.provide(store),
  Layer.provideMerge(ServerSettings.layerTest({ speechModelId: "test-model" })),
  Layer.provide(NodeServices.layer),
);
const pcm = () => new Uint8Array(new Float32Array([0.25]).buffer);
it.effect("updates language capabilities when the selected model changes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.status).toMatchObject({
      languages: ["en", "fr"],
      supportsLanguageDetection: false,
    });
    yield* speech.selectModel("fallback-model");
    expect(yield* speech.status).toMatchObject({
      languages: ["en"],
      supportsLanguageDetection: false,
    });
  }).pipe(Effect.provide(layer)),
);

beforeEach(() => {
  vi.clearAllMocks();
  loadNative.mockReset();
  native.feed.mockReset();
  native.finish.mockReset();
  native.transcribe.mockReset();
  native.backend = "Vulkan0";
  native.supportsVocabulary = false;
  readyModels.clear();
  readyModels.add("test-model");
  readyModels.add("fallback-model");
  download.mockImplementation(() => Effect.succeed("test.gguf"));
});

const customWordsOptions: SpeechTranscriptionOptions = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [{ term: "T3 Code", aliases: [] }],
};
const correctionWordOptions: SpeechTranscriptionOptions = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [
    { term: "sorry", aliases: [] },
    { term: "T3 Code", aliases: [] },
  ],
  speechCorrectionWord: "sorry",
};
const correctionOf = (call: ReadonlyArray<unknown> | undefined) => call?.[3];

it.effect("prepares a batch model before audio arrives and reuses it for transcription", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.selectModel("fallback-model");
    yield* speech.prepareModel;
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(loadNative).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("unloads after the chosen idle period and reloads on the next recording", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* TestClock.adjust(2 * 60_000 - 1);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps prepared batch models through the maximum recording and honors Never", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.prepareModel;
    yield* TestClock.adjust(2 * 60_000);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.updateModelUnloadTimeout("never");
    yield* TestClock.adjust(60 * 60_000);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.updateModelUnloadTimeout("immediately");
    yield* TestClock.adjust(0);
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("waits for an active stream before immediate unloading", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("immediately");
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* TestClock.adjust(60_000);
      expect(native.dispose).not.toHaveBeenCalled();
      yield* stream.finish;
    }).pipe(Effect.scoped);
    yield* TestClock.adjust(0);
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("waits for timer-owned model disposal when the service scope closes", () =>
  Effect.gen(function* () {
    const disposing = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    native.dispose.mockImplementationOnce(() => {
      disposing.resolve();
      return disposed.promise;
    });
    let closed = false;
    const service = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* speech.updateModelUnloadTimeout("immediately");
      yield* TestClock.adjust(0);
    }).pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.promise(() => disposing.promise);
    yield* Effect.yieldNow;
    expect(closed).toBe(false);
    disposed.resolve();
    yield* Fiber.join(service);
    expect(closed).toBe(true);
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);

it.effect("recognizes the correction word without showing it in the dictionary", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "I want orange, sory, yellow." });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm(), correctionWordOptions)).toBe(
      "I want orange, sorry, yellow.",
    );
    expect(yield* speech.status).not.toHaveProperty("customWords");
  }).pipe(Effect.provide(layer)),
);

it.effect("includes the correction word in the model's vocabulary", () =>
  Effect.gen(function* () {
    native.supportsVocabulary = true;
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm(), correctionWordOptions);
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      vocabulary: ["sorry", "T3 Code"],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("applies the selected language to transcription and streaming", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;

    yield* speech.transcribe(pcm(), {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "fr",
    });
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({ language: "fr" });
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      });
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(native.begin.mock.calls[0]?.[0]).toMatchObject({ language: "fr" });
  }).pipe(Effect.provide(layer)),
);

it.effect("translates supported non-English batch transcription to English", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;

    yield* speech.transcribe(pcm(), {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "fr",
      speechTranslateToEnglish: true,
    });
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      language: "fr",
      task: "translate",
      targetLanguage: "en",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("passes the correction word to the inference child", () =>
  Effect.gen(function* () {
    native.feed.mockResolvedValueOnce({
      revision: 1,
      text: { committed: "orange, sory,", tentative: "yellow" },
    });
    native.finish.mockResolvedValueOnce("orange, sory, yellow");
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(correctionWordOptions);
      expect(yield* stream.feed(pcm())).toMatchObject({
        text: { committed: "orange, sory,", tentative: "yellow" },
      });
      expect(yield* stream.finish).toBe("orange, sory, yellow");
      expect(correctionOf(native.begin.mock.calls[0])).toMatchObject({
        customWords: ["sorry", "T3 Code"],
      });
    }).pipe(Effect.scoped);
  }).pipe(Effect.provide(layer)),
);

it.effect("corrects custom words for models without prompt support", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "open t 3 code" });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm(), customWordsOptions)).toBe("open T3 Code");
  }).pipe(Effect.provide(layer)),
);

it.effect("passes custom words as vocabulary when the model supports it", () =>
  Effect.gen(function* () {
    native.supportsVocabulary = true;
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm(), customWordsOptions);
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({ vocabulary: ["T3 Code"] });
  }).pipe(Effect.provide(layer)),
);

it.effect("passes vocabulary hints to the streaming inference child for correction", () =>
  Effect.gen(function* () {
    native.feed.mockResolvedValueOnce({
      revision: 1,
      text: { committed: "", tentative: "acme studio" },
    });
    const speech = yield* SpeechService.SpeechService;
    const text = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [{ term: "Acme Studio", aliases: [] }],
      });
      return yield* stream.feed(pcm());
    }).pipe(Effect.scoped);
    expect(text.text?.tentative).toBe("acme studio");
    expect(correctionOf(native.begin.mock.calls[0])).toMatchObject({
      customWords: ["Acme Studio"],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("applies aliases even when the model accepts a vocabulary prompt", () =>
  Effect.gen(function* () {
    native.supportsVocabulary = true;
    native.transcribe.mockResolvedValueOnce({ text: "open t three code" });
    const speech = yield* SpeechService.SpeechService;
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [{ term: "T3 Code", aliases: ["t three code"] }],
      }),
    ).toBe("open T3 Code");
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({ vocabulary: ["T3 Code"] });
  }).pipe(
    Effect.provide(
      SpeechService.layer.pipe(
        Layer.provide(store),
        Layer.provide(
          ServerSettings.layerTest({
            speechModelId: "test-model",
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("removes filler words from batch transcription", () =>
  Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "Um, I uhh think this works." });
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe(
      "I think this works.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("removes filler words when a stream is finalized", () =>
  Effect.gen(function* () {
    native.finish.mockResolvedValueOnce("Um, I uhh think this works.");
    const speech = yield* SpeechService.SpeechService;
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      return yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(result).toBe("I think this works.");
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves filler words when removal is disabled", () => {
  const disabledLayer = SpeechService.layer.pipe(
    Layer.provide(store),
    Layer.provide(
      ServerSettings.layerTest({
        speechModelId: "test-model",
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    native.transcribe.mockResolvedValueOnce({ text: "Um, I uhh think this works." });
    const speech = yield* SpeechService.SpeechService;
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechRemoveFillerWords: false,
      }),
    ).toBe("Um, I uhh think this works.");
  }).pipe(Effect.provide(disabledLayer));
});

it.effect("holds model ownership until the stream scope closes and preserves silence", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      const busy = yield* Effect.result(speech.selectModel("fallback-model"));
      expect(Result.isFailure(busy) && busy.failure).toMatchObject({ _tag: "SpeechBusyError" });
      yield* stream.feed(new Uint8Array(new Float32Array(160).buffer));
      expect(native.feed.mock.calls[0]?.[0]).toHaveLength(160);
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.selectModel("fallback-model");
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts live stream audio beyond five minutes in bounded chunks", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      const frame = new Uint8Array(new Float32Array(16_000).buffer);
      for (let second = 0; second < 301; second++) yield* stream.feed(frame);
      expect(native.feed).toHaveBeenCalledTimes(301);
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
  }).pipe(
    Effect.provide(
      layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
    ),
  ),
);

it.effect("resets cancelled streams and reuses the loaded model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* stream.feed(pcm());
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("disposes a stream when resetting it fails", () =>
  Effect.gen(function* () {
    native.reset.mockRejectedValueOnce(new Error("reset failed"));
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.live("stops an unresponsive stream reset and releases the busy slot", () =>
  Effect.gen(function* () {
    native.reset.mockImplementationOnce(() => new Promise(() => {}));
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(yield* speech.status).toMatchObject({ state: "ready" });
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("releases a stream cancelled while settings are loading", () =>
  Effect.gen(function* () {
    const settingsRead = Promise.withResolvers<void>();
    const delayedSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        let firstRead = true;
        return {
          ...settings,
          getSettings: Effect.suspend(() => {
            if (!firstRead) return settings.getSettings;
            firstRead = false;
            settingsRead.resolve();
            return Effect.never;
          }),
        };
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })));
    const testLayer = SpeechService.layer.pipe(
      Layer.provide(store),
      Layer.provide(delayedSettings),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const starting = yield* speech
        .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => settingsRead.promise);
      yield* Fiber.interrupt(starting);
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
        yield* stream.finish;
      }).pipe(Effect.scoped);
      expect(loadNative).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("recovers the busy slot when a settings read fails", () =>
  Effect.gen(function* () {
    let reads = 0;
    const failingSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        return {
          ...settings,
          getSettings: Effect.suspend(() => {
            reads += 1;
            if (reads === 1)
              return Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-file",
                  cause: new Error("settings boom"),
                }),
              );
            return settings.getSettings;
          }),
        };
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ speechModelId: "test-model" })));
    const testLayer = SpeechService.layer.pipe(
      Layer.provide(store),
      Layer.provide(failingSettings),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const first = yield* speech
        .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.scoped, Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("reuses the model when a cancelled feed finishes during reset", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof native.feed>>>();
    native.feed.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    native.reset.mockImplementationOnce(async () => {
      pending.resolve({ revision: 1, text: { committed: "", tentative: "hello" } });
      await pending.promise;
    });
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* stream.feed(pcm()).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
    }).pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects invalid streaming audio and resets the stream", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* stream.feed(new Uint8Array([1, 2, 3]));
    }).pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechInvalidAudioError",
      byteLength: 3,
    });
    expect(native.feed).not.toHaveBeenCalled();
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer)),
);
it.effect("reports a missing model during stream preparation without downloading it", () =>
  Effect.gen(function* () {
    readyModels.clear();
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(
        speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped),
      );
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechModelNotFoundError",
      modelId: "test-model",
    });
    expect(download).not.toHaveBeenCalled();
  }),
);
it.effect("preserves a busy error during stream preparation", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(
      new SpeechService.SpeechBusyError({ operation: "model preparation" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(
        speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped),
      );
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechBusyError",
      operation: "model preparation",
    });
  }),
);
it.effect("reports a missing model during transcription preparation without downloading it", () =>
  Effect.gen(function* () {
    readyModels.clear();
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechModelNotFoundError",
      modelId: "test-model",
    });
    expect(download).not.toHaveBeenCalled();
  }),
);
it.effect("preserves a busy error during transcription preparation", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(
      new SpeechService.SpeechBusyError({ operation: "model preparation" }),
    );
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS));
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechBusyError",
      operation: "model preparation",
    });
  }),
);
it.effect("releases the loaded native model when its service scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
      expect(native.dispose).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);
it.effect("preserves invalid PCM errors through the service boundary", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(
        speech.transcribe(new Uint8Array(3), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      );
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechInvalidAudioError",
      byteLength: 3,
    });
  }),
);
it.effect("retries accelerated inference on CPU after the native process fails", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("worker stopped"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("uses a selected GPU without falling back to CPU after inference fails", () =>
  Effect.gen(function* () {
    const failure = new Error("GPU failed");
    native.transcribe.mockRejectedValueOnce(failure);
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const acceleration = 'gpu:["vulkan","gpu-1"]';
      expect(yield* speech.updateAcceleration(acceleration)).toMatchObject({ acceleration });
      const result = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "SpeechOperationError",
        operation: "inference",
        cause: failure,
      });
      expect(loadNative).toHaveBeenCalledTimes(1);
      expect(loadNative.mock.calls[0]?.[3]).toBe(acceleration);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports an unavailable selected GPU without loading CPU", () =>
  Effect.gen(function* () {
    loadNative.mockRejectedValueOnce(new Error("The selected speech GPU is unavailable."));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration('gpu:["vulkan","missing"]');
      const result = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reloads a cached model after acceleration changes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* speech.updateAcceleration("cpu");
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
    expect(native.dispose).toHaveBeenCalled();
  }).pipe(Effect.provide(layer)),
);

it.effect("applies an acceleration change after an active stream finishes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
        expect(yield* speech.updateAcceleration("cpu")).toMatchObject({
          state: "transcribing",
          acceleration: "cpu",
        });
        yield* stream.finish;
      }),
    );
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
  }).pipe(Effect.provide(layer)),
);

it.effect("replays streaming audio on CPU after an accelerated feed crashes", () =>
  Effect.gen(function* () {
    native.feed.mockRejectedValueOnce(new Error("worker stopped"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const stream = yield* speech.startStream(customWordsOptions);
      expect((yield* stream.feed(pcm())).text).toEqual({ committed: "", tentative: "hello" });
      expect(loadNative).toHaveBeenCalledTimes(2);
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
      expect(native.begin).toHaveBeenCalledTimes(2);
      expect(native.begin.mock.calls[1]).toEqual(native.begin.mock.calls[0]);
      expect(correctionOf(native.begin.mock.calls[1])).toMatchObject({ customWords: ["T3 Code"] });
      expect(native.feed).toHaveBeenCalledTimes(2);
      yield* stream.finish;
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

it.effect("keeps client revisions increasing across CPU replay and subsequent feeds", () =>
  Effect.gen(function* () {
    const text = { committed: "", tentative: "hello" };
    native.feed
      .mockResolvedValueOnce({ revision: 10, text })
      .mockRejectedValueOnce(new Error("worker stopped"))
      .mockResolvedValueOnce({ revision: 1, text })
      .mockResolvedValueOnce({ revision: 2, text })
      .mockResolvedValueOnce({ revision: 3, text });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      expect(yield* stream.feed(pcm())).toEqual({ revision: 10, text });
      expect(yield* stream.feed(pcm())).toEqual({ revision: 12, text });
      expect(loadNative.mock.calls[1]?.[3]).toBe("cpu");
      expect(native.feed).toHaveBeenCalledTimes(4);
      expect(yield* stream.feed(pcm())).toEqual({ revision: 13, text });
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

it.effect("reports a selected GPU streaming failure without replaying on CPU", () =>
  Effect.gen(function* () {
    native.feed.mockRejectedValueOnce(new Error("GPU failed"));
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration('gpu:["vulkan","gpu-1"]');
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
          return yield* stream.feed(pcm()).pipe(Effect.result);
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer));
  }),
);
it.effect(
  "reports an explicitly cancelled download without wrapping it as an operation failure",
  () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      download.mockImplementationOnce(() =>
        Effect.suspend(() => {
          started.resolve();
          return Effect.never;
        }),
      );
      yield* Effect.gen(function* () {
        const speech = yield* SpeechService.SpeechService;
        const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* speech.cancelDownload("test-model");
        const result = yield* Effect.result(Fiber.join(request));
        expect(Result.isSuccess(result) && result.success).toMatchObject({
          models: expect.any(Array),
        });
      }).pipe(Effect.provide(layer));
    }),
);
it.effect("reports verification while a model download is still pending", () =>
  Effect.gen(function* () {
    const verifying = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<string>();
    download.mockImplementationOnce((_model, progress) =>
      Effect.promise(() => {
        progress?.onProgress?.(4);
        progress?.onVerificationStart?.();
        verifying.resolve();
        return finished.promise;
      }),
    );
    const speech = yield* SpeechService.SpeechService;
    const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
    yield* Effect.promise(() => verifying.promise);
    try {
      expect(
        (yield* speech.models(false)).models.find((model) => model.id === "test-model"),
      ).toMatchObject({
        state: "verifying",
        downloaded: 4,
      });
    } finally {
      finished.resolve("test.gguf");
    }
    const result = yield* Fiber.join(request);
    expect(result.models.find((model) => model.id === "test-model")).toMatchObject({
      state: "installed",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("reports unsupported hosts without wrapping a synthetic cause", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS));
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechUnsupportedPlatformError",
      platform: "win32",
      architecture: "arm64",
    });
  }),
);
it.effect("selects another installed model after removing the active model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const models = yield* speech.removeModel("test-model");
    const status = yield* speech.status;
    expect(status).toMatchObject({
      supported: true,
      state: "ready",
      modelId: "fallback-model",
    });
    expect(models.models.find((model) => model.id === "fallback-model")?.active).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("does not mark a deleted model active when no models remain installed", () =>
  Effect.gen(function* () {
    readyModels.delete("fallback-model");
    const speech = yield* SpeechService.SpeechService;
    const models = yield* speech.removeModel("test-model");
    const status = yield* speech.status;
    expect(status).toMatchObject({ supported: true, state: "missing-model" });
    expect(models.models.every((model) => !model.active)).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("stops a cancelled batch transcription and reloads on retry", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return new Promise<never>(() => {});
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      expect(yield* speech.status).toMatchObject({ state: "ready" });
      expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
      expect(native.dispose).toHaveBeenCalledOnce();
      expect(loadNative).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("closes its scope without waiting for hung native inference", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return new Promise(() => {});
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);

it.effect("a failed stream begin does not poison the next stream", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    native.begin
      .mockRejectedValueOnce(new Error("native stream creation failed"))
      .mockRejectedValueOnce(new Error("native stream creation failed on CPU"));
    const result = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.scoped, Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(native.dispose).toHaveBeenCalledTimes(2);
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledTimes(3);
  }).pipe(Effect.provide(layer)),
);

it.effect("failed CPU fallback is disposed", () =>
  Effect.gen(function* () {
    native.transcribe.mockRejectedValueOnce(new Error("GPU failed"));
    const failure = new Error("CPU failed");
    native.transcribe.mockRejectedValueOnce(failure);
    const speech = yield* SpeechService.SpeechService;
    const result = yield* speech
      .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.result);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechOperationError",
      operation: "inference",
      cause: failure,
    });
    yield* Effect.promise(async () => {});
    expect(native.dispose).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps consecutive clients' transcription preferences isolated", () =>
  Effect.gen(function* () {
    native.supportsVocabulary = true;
    const speech = yield* SpeechService.SpeechService;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const before = yield* settingsService.getSettings;
    native.transcribe.mockResolvedValueOnce({ text: "pair a keet" });
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
        speechCustomWords: [{ term: "Parakeet", aliases: ["pair a keet"] }],
      }),
    ).toBe("Parakeet");
    expect(native.transcribe.mock.calls[0]?.[1]).toMatchObject({
      language: "fr",
      vocabulary: ["Parakeet"],
    });
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(native.transcribe.mock.calls[1]?.[1]).toMatchObject({ language: "en" });
    expect(native.transcribe.mock.calls[1]?.[1]).not.toHaveProperty("vocabulary");
    expect(yield* settingsService.getSettings).toEqual(before);
  }).pipe(Effect.provide(layer)),
);
it.effect("uses the supplied dictionary in live transcription", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    native.feed.mockResolvedValueOnce({
      revision: 1,
      text: { committed: "", tentative: "pair a keet" },
    });
    const result = yield* Effect.gen(function* () {
      const stream = yield* speech.startStream({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [{ term: "Parakeet", aliases: ["pair a keet"] }],
      });
      return yield* stream.feed(pcm());
    }).pipe(Effect.scoped);
    expect(result.text?.tentative).toBe("pair a keet");
    expect(native.begin.mock.calls[0]?.[0]).toMatchObject({ language: "en" });
    expect(correctionOf(native.begin.mock.calls[0])).toEqual({
      customWords: ["Parakeet"],
      dictionary: [{ term: "Parakeet", aliases: ["pair a keet"] }],
    });
  }).pipe(Effect.provide(layer)),
);
