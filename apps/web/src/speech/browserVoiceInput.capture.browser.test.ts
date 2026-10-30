import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

const mocks = vi.hoisted(() => ({ feed: vi.fn() }));

vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({
      supported: true,
      state: "ready",
      supportsStreaming: true,
      supportsTranslation: false,
      languages: ["en"],
      supportsLanguageDetection: false,
    }),
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: () =>
    Promise.resolve({
      feed: mocks.feed,
      finish: async () => "captured speech",
    }),
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));

import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

it("captures microphone samples through the shipped AudioWorklet", async () => {
  const sourceContext = new AudioContext();
  const destination = sourceContext.createMediaStreamDestination();
  const oscillator = sourceContext.createOscillator();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  await sourceContext.resume();

  const originalMediaDevices = navigator.mediaDevices;
  const getUserMedia = vi.fn(async () => destination.stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { ...originalMediaDevices, getUserMedia },
  });

  const platform = createBrowserVoiceInputPlatform({
    prepared: {} as PreparedConnection,
    getTranscriptionOptions: () => DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    getMicrophoneId: () => "",
    onLevel() {},
    onDurationLimit() {},
    onText() {},
    onError: (message) => {
      throw new Error(message);
    },
  });

  try {
    const transcription = await platform.transcriber.prepare({
      signal: new AbortController().signal,
    });
    await platform.recorder.prepareToRecordAsync();
    platform.recorder.record();

    await vi.waitFor(() => expect(mocks.feed).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledOnce();
    const samples = mocks.feed.mock.calls.flatMap(([pcm]) => Array.from(pcm as Float32Array));
    expect(samples.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    await platform.recorder.stop();
    await expect(
      transcription.streaming?.finish({ signal: new AbortController().signal }),
    ).resolves.toBe("captured speech");
  } finally {
    platform.cancelRecording();
    oscillator.stop();
    await sourceContext.close();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    mocks.feed.mockClear();
  }
});
