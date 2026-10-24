import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FetchHttpClient } from "effect/http";
import { EnvironmentId, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import {
  transcribeEnvironmentPcm,
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechModels,
  downloadEnvironmentSpeechModel,
  removeEnvironmentSpeechModel,
  getEnvironmentSpeechStreamUrl,
  postProcessEnvironmentTranscript,
} from "./environment.ts";

const environmentId = Schema.decodeSync(EnvironmentId)("voice-test");
const prepared = (
  httpBaseUrl: string,
  httpAuthorization: PreparedHttpAuthorization | null = null,
): PreparedConnection => ({
  environmentId,
  label: "test",
  httpBaseUrl,
  socketUrl: "ws://localhost/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "test",
    httpBaseUrl,
    wsBaseUrl: "ws://localhost",
  }),
});
it.effect.each([
  "http://192.168.1.1:3000",
  "http://100.101.102.103:3000",
  "http://server.tailnet.ts.net:3000",
  "https://remote.example",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
])("allows existing environment transport %s", (url) =>
  Effect.gen(function* () {
    const fetch = vi.fn(async () => Response.json({ text: "hello" }));
    expect(
      yield* transcribeEnvironmentPcm(
        prepared(url),
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ).toEqual({ text: "hello" });
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error", credentials: "include" }),
    );
  }),
);

it.effect.each([
  "https://remote.example",
  "http://192.168.1.1:3000",
  "http://100.101.102.103:3000",
  "http://server.tailnet.ts.net:3000",
])("authenticates voice requests without browser cookies over %s", (url) =>
  Effect.gen(function* () {
    let credentials: RequestCredentials | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials;
      return Response.json({ text: "hello" });
    });
    yield* transcribeEnvironmentPcm(
      prepared(url, { _tag: "Bearer", token: "secret" }),
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(credentials).toBeUndefined();
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  }),
);

it.effect("cancels a long batch recording without starting later requests", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          started.resolve();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const fiber = yield* transcribeEnvironmentPcm(
      prepared("https://remote.example"),
      new Uint8Array(16_000 * 4 * 301),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    expect(fetch).toHaveBeenCalledOnce();
  }),
);

it.effect.each([61, 301, 601])(
  "transcribes a %s-second recording as bounded contiguous requests without losing PCM",
  (durationSeconds) =>
    Effect.gen(function* () {
      const samples = new Float32Array(16_000 * durationSeconds);
      for (let index = 0; index < samples.length; index++)
        samples[index] = ((index * 17) % 101) / 100;
      const pcm = new Uint8Array(samples.buffer);
      const requests: Uint8Array[] = [];
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
        return Response.json({ text: `part ${requests.length}` });
      });
      const result = yield* transcribeEnvironmentPcm(
        prepared("https://remote.example"),
        pcm,
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      const decoded = requests.map((request) => decodeSpeechPcmRequest(request).pcm);
      expect(decoded.every((chunk) => chunk.byteLength <= 16_000 * 4 * 30)).toBe(true);
      expect(requests.length).toBeGreaterThan(2);
      expect(decoded.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(pcm.byteLength);
      let offset = 0;
      for (const chunk of decoded) {
        // Compare byte spans without a deep-equality assertion retaining
        // millions of diagnostic entries for the ten-minute fixture.
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const expected = new Uint8Array(pcm.buffer, pcm.byteOffset + offset, chunk.byteLength);
        expect(bytes.every((byte, index) => byte === expected[index])).toBe(true);
        offset += chunk.byteLength;
      }
      expect(offset).toBe(pcm.byteLength);
      expect(result.text).toBe(requests.map((_, index) => `part ${index + 1}`).join(" "));
    }),
);

it.effect(
  "sends resolved preferences and project vocabulary to a remote transcription environment",
  () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const decoded = decodeSpeechPcmRequest(
          new Uint8Array(await new Response(init?.body).arrayBuffer()),
        );
        expect(decoded.options).toMatchObject({
          projectName: "T3 Code",
          speechLanguage: "fr",
          speechCustomWords: [{ term: "Effect", aliases: [] }],
        });
        expect(decoded.pcm).toEqual(new Uint8Array(4));
        expect(new Headers(init?.headers).has("x-t3-project-id")).toBe(false);
        return Response.json({ text: "hello" });
      });
      yield* transcribeEnvironmentPcm(prepared("https://remote.example"), new Uint8Array(4), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        projectName: "T3 Code",
        speechLanguage: "fr",
        speechCustomWords: [{ term: "Effect", aliases: [] }],
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(fetch).toHaveBeenCalledOnce();
    }),
);

it.effect.each([
  "http://192.168.1.1:3000",
  "http://100.101.102.103:3000",
  "http://server.tailnet.ts.net:3000",
])("supports voice setup, streaming, and cleanup over authenticated transport %s", (url) =>
  Effect.gen(function* () {
    const connection = prepared(url, { _tag: "Bearer", token: "secret" });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(init?.redirect).toBe("error");
      const path = new URL(String(input)).pathname;
      if (path === "/api/voice/status") return Response.json({ supported: false, reason: "test" });
      if (path === "/api/auth/websocket-ticket")
        return Response.json({ ticket: "voice-ticket", expiresAt: "2026-10-05T00:00:00.000Z" });
      if (path === "/api/voice/post-process") return Response.json({ text: "Clean transcript" });
      return Response.json({ models: [] });
    });
    yield* Effect.gen(function* () {
      expect(yield* getEnvironmentSpeechStatus(connection)).toEqual({
        supported: false,
        reason: "test",
      });
      expect(yield* getEnvironmentSpeechModels(connection)).toEqual({ models: [] });
      expect(yield* downloadEnvironmentSpeechModel(connection, "test-model")).toEqual({
        models: [],
      });
      expect(yield* removeEnvironmentSpeechModel(connection, "test-model")).toEqual({ models: [] });
      expect(yield* getEnvironmentSpeechStreamUrl(connection)).toBe(
        `${url.replace("http:", "ws:")}/ws/voice?wsTicket=voice-ticket`,
      );
      expect(
        yield* postProcessEnvironmentTranscript(
          connection,
          "Raw transcript",
          { text: "", selection: { start: 0, end: 0 } },
          {
            speechPostProcessingEnabled: true,
            speechCorrectionWord: "sorry",
            speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
            speechCustomWords: [],
          },
        ),
      ).toEqual({ text: "Clean transcript" });
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(fetch).toHaveBeenCalledTimes(6);
  }),
);
