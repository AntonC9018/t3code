import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OPENVINO_SPEECH_MODEL_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechService from "./SpeechService.ts";

const backend = vi.hoisted(() => ({
  ready: vi.fn(async () => true),
  transcribe: vi.fn(async () => ({ text: "hello" })),
  load: vi.fn(async () => ({
    backend: "openvino-gpu",
    supportsStreaming: false,
    supportsInitialPrompt: false,
    transcribe: backend.transcribe,
    dispose: async () => {},
  })),
}));

vi.mock("./openvino.ts", () => ({
  openVinoSpeechUrl: (value: string | undefined) => (value ? new URL(value) : null),
  isOpenVinoSpeechReady: backend.ready,
  loadOpenVinoSpeechModel: backend.load,
}));

const layer = SpeechService.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "speech-openvino-" })),
  Layer.provide(ServerSettings.layerTest({ speechLanguage: "en" })),
  Layer.provide(NodeServices.layer),
);

const previousUrl = process.env.T3_SPEECH_OPENVINO_URL;
beforeEach(() => {
  process.env.T3_SPEECH_OPENVINO_URL = "http://127.0.0.1:8001/";
  vi.clearAllMocks();
  backend.ready.mockResolvedValue(true);
  backend.transcribe.mockResolvedValue({ text: "hello" });
});
afterEach(() => {
  if (previousUrl === undefined) delete process.env.T3_SPEECH_OPENVINO_URL;
  else process.env.T3_SPEECH_OPENVINO_URL = previousUrl;
});

it.effect("offers the WSL model to web clients and transcribes through it", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.status).toMatchObject({
      supported: true,
      state: "ready",
      modelId: OPENVINO_SPEECH_MODEL_ID,
      supportsStreaming: false,
      effectiveLanguage: "en",
    });
    expect(yield* speech.models).toMatchObject({
      models: [{ id: OPENVINO_SPEECH_MODEL_ID, active: true, state: "installed" }],
    });
    yield* speech.prepareModel;
    const pcm = new Uint8Array(new Float32Array([0.25]).buffer);
    expect(yield* speech.transcribe(pcm)).toBe("hello");
    expect(backend.load).toHaveBeenCalledOnce();
    expect(backend.transcribe).toHaveBeenCalledWith(
      new Float32Array([0.25]),
      expect.objectContaining({ language: "en" }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("reports an unavailable voice server before recording", () =>
  Effect.gen(function* () {
    backend.ready.mockResolvedValue(false);
    const speech = yield* SpeechService.SpeechService;
    expect(yield* speech.status).toMatchObject({ supported: false });
    expect(backend.load).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer)),
);
