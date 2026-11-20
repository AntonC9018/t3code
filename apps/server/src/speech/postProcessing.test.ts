import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsSnapshot,
  type SpeechPostProcessingOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { describe, expect, vi } from "vite-plus/test";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6-luna",
      name: "GPT-6 Luna",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "low", label: "Low" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const runPostProcess = (
  input: {
    readonly transcript: string;
    readonly cwd: string;
    readonly settings?: ServerSettingsSnapshot;
    readonly options?: Partial<SpeechPostProcessingOptions>;
    readonly draft?: EnvironmentSpeechPostProcessingRequest["draft"];
  },
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
  providers: ReadonlyArray<ServerProvider> = [codexProvider],
) =>
  SpeechPostProcessing.postProcessTranscript({
    ...input,
    settings: input.settings ?? DEFAULT_SERVER_SETTINGS,
    draft: input.draft ?? { text: "", selection: { start: 0, end: 0 } },
    options: { ...DEFAULT_CLIENT_SETTINGS, ...input.options },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({
          generateTranscriptionPostProcessing: generate,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      ),
    ),
  );

describe("postProcessTranscript", () => {
  it.effect("uses a pinned Claude model selection when set and usable", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      const claude: ServerProvider = {
        ...codexProvider,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [
          {
            slug: "claude-haiku-4-5",
            name: "Haiku",
            isCustom: false,
            capabilities: {
              optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
            },
          },
        ],
      };
      const pinnedClaude: ModelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
        options: [{ id: "thinking", value: false }],
      };
      expect(
        yield* runPostProcess(
          {
            transcript: "raw",
            cwd: "C:/neutral",
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              speechPostProcessingModelSelection: pinnedClaude,
            },
          },
          generate,
          [{ ...codexProvider, installed: false }, claude],
        ),
      ).toBe("Clean text.");
      expect(generate.mock.calls[0]?.[0].modelSelection).toEqual(pinnedClaude);
    }),
  );

  it.effect("follows textGenerationModelSelection when unpinned and uses built-in prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "  Clean text.  " }),
      );
      const settings = DEFAULT_SERVER_SETTINGS;

      expect(
        yield* runPostProcess(
          {
            transcript: "uh clean text",
            cwd: "C:/neutral",
            settings,
          },
          generate,
        ),
      ).toBe("Clean text.");
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "C:/neutral",
          modelSelection: settings.textGenerationModelSelection,
          prompt: expect.stringContaining("<transcript>\nuh clean text\n</transcript>"),
        }),
      );
      expect(generate.mock.calls[0]?.[0].prompt).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("uses custom instructions when selected", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      yield* runPostProcess(
        {
          transcript: "clean text",
          cwd: "C:/neutral",
          options: {
            speechPostProcessingPrompt: {
              mode: "custom",
              customInstructions: "Keep technical terms verbatim.",
            },
          },
        },
        generate,
      );
      const prompt = generate.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain("Keep technical terms verbatim.");
      expect(prompt).not.toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("uses built-in cleanup while custom instructions are blank", () =>
    Effect.gen(function* () {
      const generate = vi.fn(
        (
          _input: Parameters<
            TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
          >[0],
        ) => Effect.succeed({ transcription: "Clean text." }),
      );
      yield* runPostProcess(
        {
          transcript: "clean text",
          cwd: "C:/neutral",
          options: {
            speechPostProcessingPrompt: { mode: "custom", customInstructions: "" },
          },
        },
        generate,
      );
      expect(generate.mock.calls[0]?.[0].prompt).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    }),
  );

  it.effect("does not call a provider for a blank transcript", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "unexpected" }));
      expect(yield* runPostProcess({ transcript: "  ", cwd: "C:/neutral" }, generate)).toBe("  ");
      expect(generate).not.toHaveBeenCalled();
    }),
  );

  it.effect("adds context-sensitive correction instructions to the prompt", () =>
    Effect.gen(function* () {
      const generate = vi.fn(() => Effect.succeed({ transcription: "I want yellow." }));
      const options = { speechCorrectionWord: "err" };
      yield* runPostProcess(
        {
          transcript: "I want orange, err, yellow.",
          cwd: "C:/neutral",
          options,
        },
        generate,
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Correction cue: "err"'),
        }),
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            "If the cue is an intended part of the sentence, keep it",
          ),
        }),
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            "<transcript>\nI want orange, err, yellow.\n</transcript>",
          ),
        }),
      );
    }),
  );

  it.effect("preserves the original when the provider returns blank output", () =>
    Effect.gen(function* () {
      expect(
        yield* runPostProcess(
          {
            transcript: "raw text",
            cwd: "C:/neutral",
          },
          () => Effect.succeed({ transcription: "   " }),
        ),
      ).toBe("raw text");
    }),
  );

  it.effect("reapplies dictionary aliases after AI cleanup", () =>
    Effect.gen(function* () {
      expect(
        yield* runPostProcess(
          {
            transcript: "Use MiniMax.",
            cwd: "C:/neutral",
            options: {
              speechCustomWords: [{ term: "MiniMax", aliases: ["mini max"] }],
            },
          },
          () => Effect.succeed({ transcription: "Use mini max." }),
        ),
      ).toBe("Use MiniMax.");
    }),
  );
});

const textGenerationSelection = {
  instanceId: ProviderInstanceId.make("fakeapi"),
  model: "fake-model",
};
const acpSelection = { instanceId: ProviderInstanceId.make("acp_local"), model: "default" };

it.effect("cleanup pinned to a provider that cannot generate text uses the text model", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello, world." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: acpSelection.instanceId,
              driver: "acpRegistry",
              enabled: true,
              installed: true,
              supportsTextGeneration: false,
            },
          ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [acpSelection.instanceId]: {
              driver: "acpRegistry",
              enabled: true,
              config: { source: "local", commandPath: "acp-agent" },
            },
          },
          textGenerators: {
            [textGenerationSelection.instanceId]: {
              kind: "openaiCompatible",
              baseUrl: "http://127.0.0.1:18999/v1",
              enabled: true,
            },
          },
          textGenerationModelSelection: textGenerationSelection,
          speechPostProcessingModelSelection: acpSelection,
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
      yield* postProcessing.process({
        options: {
          speechCustomWords: [],
          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
        },
        transcript: "um hello world",
        draft: { text: "", selection: { start: 0, end: 0 } },
      } as never);
    }).pipe(Effect.provide(layer));
    const selection = yield* Ref.get(used);
    assert.deepStrictEqual(
      { instanceId: selection?.instanceId, model: selection?.model },
      textGenerationSelection,
    );
  }),
);
