import { useLayoutEffect } from "react";
import { act, render, fakeTimers } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type ClientSettings,
  type ServerSettings,
  type SpeechTranscriptionOptions,
  type SpeechPostProcessingOptions,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  resetRetainedSpeechSessionsForTests,
  useEnvironmentSpeechInput,
} from "./useEnvironmentSpeechInput";
import { PreviewAnnotationSpeech } from "../components/preview/PreviewAnnotationSpeech";

const mocks = vi.hoisted(() => ({
  voice: null as ReturnType<typeof useEnvironmentSpeechInput> | null,
  retainRecording: false,
  recoveredPostProcessing: undefined as SpeechPostProcessingOptions | undefined,
  recoveredOwner: null as string | null,
  recovery: null as Promise<null> | null,
  transcriptions: vi.fn(),
  backgroundCommitted: vi.fn(),
  voiceCapability: true as boolean | undefined,
  cleanupCapability: true as boolean | undefined,
  statusRequests: vi.fn(),
  postProcessingEnabled: false,
  transcript: null as Promise<string> | null,
  processedTranscript: null as Promise<string> | null,
  draft: "",
  editorDraft: null as string | null,
  disabled: false,
  annotation: false,
  draftThread: false,
  clientPreferences: {} as Partial<ClientSettings>,
  projectId: undefined as ProjectId | undefined,
  originSettings: null as ServerSettings | null,
  originPrepared: {} as PreparedConnection,
  recordingOptions: null as SpeechTranscriptionOptions | null,
  cleanup: vi.fn(),
  committed: vi.fn(),
  busy: false,
  microphoneFailure: true,
  missingModel: false,
  microphoneRequests: 0,
  ownerKey: "draft",
  prepared: {} as PreparedConnection,
  preparedEnvironmentId: null as EnvironmentId | null,
  preparedEnvironmentIds: [] as Array<EnvironmentId | null>,
  primaryEnvironmentId: "primary-environment" as EnvironmentId,
  transcriptionEnvironmentId: null as EnvironmentId | null,
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => (mocks.draftThread ? null : { projectId: mocks.projectId }),
  useProject: () => ({ title: "Annotation project" }),
}));
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: (
    selector: (store: {
      getDraftThreadByRef: () => { projectId: ProjectId | undefined } | null;
    }) => unknown,
  ) =>
    selector({
      getDraftThreadByRef: () => (mocks.draftThread ? { projectId: mocks.projectId } : null),
    }),
}));
vi.mock("./useDictationShortcut", () => ({
  useDictationShortcut: (input: { speech: ReturnType<typeof useEnvironmentSpeechInput> }) => {
    mocks.voice = input.speech;
    return "Ctrl+Space";
  },
}));
vi.mock("../components/chat/VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("../components/chat/ComposerSpeechButton", () => ({
  resolveSpeechPresentation: () => ({ status: "Idle" }),
}));
vi.mock("../components/preview/previewBridge", () => ({ previewBridge: null }));
vi.mock("../state/session", () => ({
  usePreparedConnection: (environmentId: EnvironmentId | null) => {
    mocks.preparedEnvironmentId = environmentId;
    mocks.preparedEnvironmentIds.push(environmentId);
    return Option.some(
      environmentId === "project-environment" ? mocks.originPrepared : mocks.prepared,
    );
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
  useEnvironment: (id: EnvironmentId | null) => ({
    serverConfig: {
      settings: mocks.originSettings ?? DEFAULT_SERVER_SETTINGS,
      environment: {
        capabilities: {
          voiceTranscription:
            id === "project-environment" ? mocks.cleanupCapability : mocks.voiceCapability,
        },
      },
    },
  }),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      voiceTranscriptionEnvironmentId: mocks.transcriptionEnvironmentId,
      speechPostProcessingEnabled: mocks.postProcessingEnabled,
      ...mocks.clientPreferences,
    };
    return selector ? selector(settings) : settings;
  },
  useEnvironmentSettings: () => mocks.postProcessingEnabled,
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({}) }));
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () => {
    mocks.statusRequests();
    return Effect.succeed({
      supported: true,
      state: mocks.busy ? "transcribing" : mocks.missingModel ? "missing-model" : "ready",
      model: "test",
      modelId: "test-model",
      size: 731_357_568,
    });
  },
  postProcessEnvironmentTranscript: (...args: unknown[]) => {
    mocks.cleanup(...args);
    return mocks.processedTranscript
      ? Effect.map(
          Effect.promise(() => mocks.processedTranscript!),
          (text) => ({ text }),
        )
      : Effect.succeed({ text: "Clean transcript" });
  },
  downloadEnvironmentSpeechModel: () =>
    Effect.sync(() => {
      mocks.missingModel = false;
    }),
}));
vi.mock("./recordingStorage", () => ({
  recordingStorage: {
    find: async (ownerKey: string) =>
      mocks.recoveredOwner === ownerKey
        ? {
            id: "saved-audio",
            ownerKey,
            options: {},
            locale: "en",
            draft: { ownerKey, text: "", selection: { start: 0, end: 0 }, revision: 7 },
          }
        : null,
    remove: vi.fn(),
  },
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: (input: {
    getTranscriptionOptions: () => SpeechTranscriptionOptions;
    retainedDraft?: { ownerKey: string };
  }) => ({
    get postProcessingOptions() {
      return mocks.recoveredPostProcessing;
    },
    findRecording: async () =>
      mocks.recovery ??
      (await import("./recordingStorage")).recordingStorage.find(input.retainedDraft!.ownerKey),
    discardSavedRecording: async () => {},
    saveTranscript: async (text: string) => text,
    restoreRecording: async () => ({
      uri: "recording",
      transcription: {
        locale: "en",
        transcribe: async () => {
          mocks.transcriptions();
          return mocks.transcript ?? "Raw transcript";
        },
      },
    }),
    recorder: {
      uri: "recording",
      prepareToRecordAsync: async () => {
        mocks.microphoneRequests += 1;
        if (mocks.microphoneFailure) throw new Error("no microphone");
      },
      record() {},
      stop: async () => {},
    },
    transcriber: {
      prepare: async () => {
        mocks.recordingOptions = input.getTranscriptionOptions();
        return {
          locale: "en",
          transcribe: async () => {
            mocks.transcriptions();
            return mocks.transcript ?? "Raw transcript";
          },
        };
      },
    },
    cancelRecording() {},
    deleteRecording() {},
  }),
}));

function probeInput(): Parameters<typeof useEnvironmentSpeechInput>[0] {
  return {
    environmentId: "project-environment" as EnvironmentId,
    projectId: mocks.projectId,
    ownerKey: mocks.ownerKey,
    draftText: mocks.draft,
    disabled: mocks.disabled,
    readDraft: () => ({
      text: mocks.editorDraft ?? mocks.draft,
      selection: {
        start: (mocks.editorDraft ?? mocks.draft).length,
        end: (mocks.editorDraft ?? mocks.draft).length,
      },
    }),
    commitDraft: mocks.committed,
    retainedDraft: mocks.retainRecording
      ? {
          read: () => ({ text: "", selection: { start: 0, end: 0 } }),
          commit: (
            (owner) => (text: string) =>
              mocks.backgroundCommitted(owner, text)
          )(mocks.ownerKey),
        }
      : undefined,
  };
}

function Probe({ input }: { input: Parameters<typeof useEnvironmentSpeechInput>[0] }) {
  const value = useEnvironmentSpeechInput(input);
  useLayoutEffect(() => {
    mocks.voice = value;
  });
  return null;
}

async function mountProbe() {
  return render(
    mocks.annotation ? (
      <PreviewAnnotationSpeech
        threadRef={{
          environmentId: "project-environment" as EnvironmentId,
          threadId: ThreadId.make("annotation-thread"),
        }}
        tabId="annotation-tab"
        config={{ sessionId: "annotation-session", keybindings: [] }}
      />
    ) : (
      <Probe input={probeInput()} />
    ),
  );
}

function resetMocks() {
  mocks.voice = null;
  resetRetainedSpeechSessionsForTests();
  mocks.retainRecording = false;
  mocks.recoveredPostProcessing = undefined;
  mocks.recoveredOwner = null;
  mocks.recovery = null;
  mocks.transcriptions.mockClear();
  mocks.backgroundCommitted.mockClear();
  mocks.voiceCapability = true;
  mocks.cleanupCapability = true;
  mocks.statusRequests.mockClear();
  mocks.postProcessingEnabled = false;
  mocks.busy = false;
  mocks.microphoneFailure = true;
  mocks.missingModel = false;
  mocks.microphoneRequests = 0;
  mocks.ownerKey = "draft";
  mocks.transcriptionEnvironmentId = null;
  mocks.preparedEnvironmentId = null;
  mocks.preparedEnvironmentIds = [];
  mocks.clientPreferences = {};
  mocks.projectId = undefined;
  mocks.originSettings = null;
  mocks.recordingOptions = null;
  mocks.transcript = null;
  mocks.processedTranscript = null;
  mocks.draft = "";
  mocks.editorDraft = null;
  mocks.disabled = false;
  mocks.annotation = false;
  mocks.draftThread = false;
  mocks.cleanup.mockClear();
  mocks.committed.mockClear();
}

function setup(): Disposable {
  resetMocks();
  return { [Symbol.dispose]: resetMocks };
}

it("keeps dictation when a focus rerender arrives before the editor text prop catches up", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.editorDraft = "Latest editor text";
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.state.phase).toBe("recording");
  // The imperative editor snapshot is current, but an unrelated focus render
  // still carries the previous React draft prop.
  await screen.rerender(<Probe input={probeInput()} />);
  await act(() => mocks.voice!.stop());
  expect(mocks.voice!.state.phase).toBe("idle");
  expect(mocks.committed).toHaveBeenCalledWith(
    "Latest editor text Raw transcript",
    expect.anything(),
  );
});
it.each([false, true])(
  "includes project-only aliases in annotation transcription and cleanup (draft thread: %s)",
  async (draftThread) => {
    using _state = setup();
    mocks.annotation = true;
    mocks.draftThread = draftThread;
    mocks.microphoneFailure = false;
    mocks.postProcessingEnabled = true;
    mocks.projectId = ProjectId.make("annotation-project");
    const words = [{ term: "Effect", aliases: ["a fact"] }];
    mocks.originSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [mocks.projectId]: { speechProjectCustomWords: words } },
    };
    await using _screen = await mountProbe();
    await act(() => mocks.voice!.start());
    expect(mocks.recordingOptions).toMatchObject({
      projectName: "Annotation project",
      speechCustomWords: words,
    });
    await act(() => mocks.voice!.stop());
    expect(mocks.cleanup).toHaveBeenCalledWith(
      mocks.originPrepared,
      "Raw transcript",
      { text: "", selection: { start: 0, end: 0 } },
      expect.objectContaining({ speechCustomWords: words }),
    );
  },
);
it("queues a recording while the environment is transcribing and starts when it drains", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.busy = true;
  await using _screen = await mountProbe();
  using _timers = fakeTimers();
  let starting!: Promise<void>;
  await act(async () => {
    starting = mocks.voice!.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(mocks.voice!.state.phase).toBe("preparing");
  expect(mocks.voice!.preparing).toBe(true);
  const submitted = vi.fn();
  await act(() => mocks.voice!.submitAfterDictation(submitted));
  expect(submitted).not.toHaveBeenCalled();
  expect(mocks.microphoneRequests).toBe(0);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(mocks.voice!.state.phase).toBe("recording");
  expect(mocks.voice!.preparing).toBe(false);
  expect(submitted).not.toHaveBeenCalled();
  expect(mocks.microphoneRequests).toBe(1);
});
it("starts a recording requested while a cancelled stream is finishing", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  using _timers = fakeTimers();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.state.phase).toBe("recording");
  await act(() => mocks.voice!.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = mocks.voice!.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(mocks.voice!.state.phase).toBe("preparing");
  expect(mocks.microphoneRequests).toBe(1);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(mocks.voice!.state.phase).toBe("recording");
  expect(mocks.microphoneRequests).toBe(2);
});
it("discards a queued recording when cancelled again", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  using _timers = fakeTimers();
  await act(() => mocks.voice!.start());
  await act(() => mocks.voice!.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = mocks.voice!.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(mocks.voice!.state.phase).toBe("preparing");
  await act(() => mocks.voice!.cancel());
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(mocks.voice!.state.phase).toBe("idle");
  expect(mocks.microphoneRequests).toBe(1);
});
it("discards a queued recording when the draft owner changes", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  await using screen = await mountProbe();
  using _timers = fakeTimers();
  await act(() => mocks.voice!.start());
  await act(() => mocks.voice!.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = mocks.voice!.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  mocks.ownerKey = "another-draft";
  await screen.rerender(<Probe input={probeInput()} />);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(mocks.voice!.state.phase).toBe("idle");
  expect(mocks.microphoneRequests).toBe(1);
});
it("opens setup before requesting microphone access for a missing model", async () => {
  using _state = setup();
  mocks.missingModel = true;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.setup.open).toBe(true);
  expect(mocks.voice!.setup.step).toBe(0);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => mocks.voice!.setup.download());
  expect(mocks.voice!.setup.step).toBe(1);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => mocks.voice!.setup.startRecording());
  expect(mocks.microphoneRequests).toBe(1);
});
it("does not request microphone access when the editor is already disabled", async () => {
  using _state = setup();
  mocks.disabled = true;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.microphoneRequests).toBe(0);
  expect(mocks.voice!.state.phase).toBe("idle");
});

it("abandons setup recording when the editor becomes disabled", async () => {
  using _state = setup();
  mocks.missingModel = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  await act(() => mocks.voice!.setup.download());
  const startRecording = mocks.voice!.setup.startRecording;
  mocks.disabled = true;
  await screen.rerender(<Probe input={probeInput()} />);
  await act(() => startRecording());
  expect(mocks.microphoneRequests).toBe(0);
  expect(mocks.voice!.setup.open).toBe(false);
  expect(mocks.voice!.state.phase).toBe("idle");
});

it("abandons queued dictation when the editor becomes disabled, even if re-enabled", async () => {
  using _state = setup();
  mocks.busy = true;
  mocks.microphoneFailure = false;
  await using screen = await mountProbe();
  using _timers = fakeTimers();
  let starting!: Promise<void>;
  await act(async () => {
    starting = mocks.voice!.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(mocks.voice!.state.phase).toBe("preparing");
  mocks.disabled = true;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state.phase).toBe("idle");
  mocks.disabled = false;
  await screen.rerender(<Probe input={probeInput()} />);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(mocks.microphoneRequests).toBe(0);
  expect(mocks.voice!.state.phase).toBe("idle");
});

it("discards a pending transcript when the editor becomes disabled", async () => {
  using _state = setup();
  const transcript = deferredTranscript();
  mocks.transcript = transcript.promise;
  mocks.microphoneFailure = false;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = mocks.voice!.stop();
  });
  expect(mocks.voice!.state.phase).toBe("transcribing");
  mocks.disabled = true;
  await screen.rerender(<Probe input={probeInput()} />);
  await act(async () => {
    transcript.resolve("Late words");
    await stopping;
  });
  expect(mocks.committed).not.toHaveBeenCalled();
  expect(mocks.voice!.state.phase).toBe("idle");
});

it("uses the primary environment for transcription by default", async () => {
  using _state = setup();
  await using screen = await mountProbe();
  expect(mocks.preparedEnvironmentIds).toContain(mocks.primaryEnvironmentId);

  mocks.transcriptionEnvironmentId = "voice-environment" as EnvironmentId;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.preparedEnvironmentIds).toContain(mocks.transcriptionEnvironmentId);
});
it("clears the previous connection's recording error when replacing the controller", async () => {
  using _state = setup();
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.state.phase).toBe("error");
  const previousConnection = mocks.prepared;
  mocks.prepared = {} as PreparedConnection;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state).toEqual({ phase: "idle", error: null, errorAction: null });
  mocks.prepared = previousConnection;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state).toEqual({ phase: "idle", error: null, errorAction: null });
});

it(" replacing post-processing settings does not strand recording state", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.state.phase).toBe("recording");
  mocks.postProcessingEnabled = true;
  await screen.rerender(<Probe input={probeInput()} />);
  await act(() => mocks.voice!.cancel());
  expect(mocks.voice!.state.phase).toBe("idle");
  mocks.postProcessingEnabled = false;
});

it("transcribes on the selected host and cleans on the thread environment using one preference snapshot", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.postProcessingEnabled = true;
  mocks.transcriptionEnvironmentId = "voice-environment" as EnvironmentId;
  mocks.projectId = ProjectId.make("project-one");
  mocks.originSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [mocks.projectId]: { speechProjectCustomWords: [{ term: "Effect", aliases: ["a fact"] }] },
      [ProjectId.make("other-project")]: {
        speechProjectCustomWords: [{ term: "Unrelated", aliases: [] }],
      },
    },
  };
  mocks.clientPreferences = {
    speechLanguage: "fr",
    speechCorrectionWord: "pardon",
    speechCustomWords: [{ term: "T3 Code", aliases: [] }],
  };
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.voice!.state.phase).toBe("recording");
  expect(mocks.recordingOptions).toMatchObject({
    speechLanguage: "fr",
    speechCorrectionWord: "pardon",
    speechCustomWords: [
      { term: "Effect", aliases: ["a fact"] },
      { term: "T3 Code", aliases: [] },
    ],
  });
  mocks.clientPreferences = {
    speechLanguage: "en",
    speechCorrectionWord: "sorry",
    speechCustomWords: [],
  };
  mocks.postProcessingEnabled = false;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state.phase).toBe("recording");
  await act(() => mocks.voice!.stop());
  expect(mocks.cleanup).toHaveBeenCalledWith(
    mocks.originPrepared,
    "Raw transcript",
    { text: "", selection: { start: 0, end: 0 } },
    expect.objectContaining({
      speechCorrectionWord: "pardon",
      speechPostProcessingEnabled: true,
      speechCustomWords: mocks.recordingOptions!.speechCustomWords,
    }),
  );
  expect(mocks.committed).toHaveBeenCalledWith("Clean transcript", expect.anything());
  expect(mocks.preparedEnvironmentIds).toContain(mocks.transcriptionEnvironmentId);
  mocks.postProcessingEnabled = false;
});

it("preserves the original transcript without cleanup when the client disables it", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.postProcessingEnabled = false;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  await act(() => mocks.voice!.stop());
  expect(mocks.cleanup).not.toHaveBeenCalled();
  expect(mocks.committed).toHaveBeenCalledWith("Raw transcript", expect.anything());
});

function deferredTranscript() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("finishes recording and submits the existing draft with the final transcript exactly once", async () => {
  using _state = setup();
  const transcript = deferredTranscript();
  mocks.transcript = transcript.promise;
  mocks.draft = "Existing";
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  const submitted = vi.fn();
  await act(() => {
    mocks.voice!.submitAfterDictation(submitted);
    mocks.voice!.submitAfterDictation(submitted);
  });
  expect(mocks.voice!.state.phase).toBe("transcribing");
  expect(submitted).not.toHaveBeenCalled();
  await act(async () => transcript.resolve("dictated text"));
  expect(submitted).toHaveBeenCalledExactlyOnceWith("Existing dictated text");
});

it("queues submission during post-processing and waits for the cleaned transcript", async () => {
  using _state = setup();
  const processed = deferredTranscript();
  mocks.processedTranscript = processed.promise;
  mocks.postProcessingEnabled = true;
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = mocks.voice!.stop();
  });
  expect(mocks.voice!.state.phase).toBe("post-processing");
  const submitted = vi.fn();
  await act(() => mocks.voice!.submitAfterDictation(submitted));
  expect(submitted).not.toHaveBeenCalled();
  await act(async () => {
    processed.resolve("Cleaned words");
    await stopping;
  });
  expect(submitted).toHaveBeenCalledExactlyOnceWith("Cleaned words");
});

it.each(["cancel", "owner", "error", "disabled"] as const)(
  "abandons queued submission on %s",
  async (reason) => {
    using _state = setup();
    const transcript = deferredTranscript();
    mocks.transcript = transcript.promise;
    mocks.microphoneFailure = false;
    await using screen = await mountProbe();
    await act(() => mocks.voice!.start());
    const submitted = vi.fn();
    await act(() => mocks.voice!.submitAfterDictation(submitted));
    if (reason === "cancel") await act(() => mocks.voice!.cancel());
    if (reason === "owner") {
      mocks.ownerKey = "other";
      await screen.rerender(<Probe input={probeInput()} />);
    }
    if (reason === "disabled") {
      mocks.disabled = true;
      await screen.rerender(<Probe input={probeInput()} />);
    }
    await act(async () => {
      if (reason === "error") transcript.reject(new Error("Transcription failed"));
      else transcript.resolve("Late words");
    });
    expect(submitted).not.toHaveBeenCalled();
  },
);

it("finishing dictation alone leaves the completed text for editing", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  await act(() => mocks.voice!.stop());
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("Raw transcript", { start: 14, end: 14 });
});

it("does not submit when the recording contains no speech", async () => {
  using _state = setup();
  mocks.transcript = Promise.resolve("");
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  const submitted = vi.fn();
  await act(() => mocks.voice!.submitAfterDictation(submitted));
  expect(mocks.voice!.state.phase).toBe("error");
  expect(submitted).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  "does not probe an environment with voice capability %s",
  async (capability) => {
    using _state = setup();
    mocks.voiceCapability = capability;
    await using _screen = await mountProbe();
    expect(mocks.statusRequests).not.toHaveBeenCalled();
    expect(mocks.voice!.available).toBe(false);
    await act(() => mocks.voice!.start());
    expect(mocks.microphoneRequests).toBe(0);
  },
);

it("starts probing when an environment advertises voice support after connecting", async () => {
  using _state = setup();
  mocks.voiceCapability = undefined;
  await using screen = await mountProbe();
  expect(mocks.statusRequests).not.toHaveBeenCalled();
  mocks.voiceCapability = true;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.statusRequests).toHaveBeenCalledOnce();
});
it.each([false, undefined])(
  "preserves transcription without probing an older cleanup host (%s)",
  async (capability) => {
    using _state = setup();
    mocks.cleanupCapability = capability;
    mocks.microphoneFailure = false;
    mocks.postProcessingEnabled = true;
    await using _screen = await mountProbe();
    await act(() => mocks.voice!.start());
    await act(() => mocks.voice!.stop());
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.committed).toHaveBeenCalledWith("Raw transcript", expect.anything());
  },
);

it("delivers a pending chat transcription to its original draft after switching chats", async () => {
  using _state = setup();
  const transcript = deferredTranscript();
  mocks.transcript = transcript.promise;
  mocks.microphoneFailure = false;
  mocks.retainRecording = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = mocks.voice!.stop();
  });
  mocks.ownerKey = "other-chat";
  await screen.rerender(<Probe input={probeInput()} />);
  await act(async () => {
    transcript.resolve("Saved words");
    await stopping;
  });
  expect(mocks.backgroundCommitted).toHaveBeenCalledWith("draft", "Saved words");
  expect(mocks.committed).not.toHaveBeenCalled();
});

it("keeps an active recording with its original chat and reattaches its controls", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.retainRecording = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  mocks.ownerKey = "other-chat";
  await screen.rerender(<Probe input={probeInput()} />);
  await vi.waitFor(() => expect(mocks.voice!.state.phase).toBe("idle"));
  mocks.ownerKey = "draft";
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state.phase).toBe("recording");
  await act(() => mocks.voice!.stop());
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("Raw transcript", expect.anything());
  expect(mocks.microphoneRequests).toBe(1);
});

it("finishes transcription into the original draft even after the composer unmounts", async () => {
  using _state = setup();
  const transcript = deferredTranscript();
  mocks.transcript = transcript.promise;
  mocks.microphoneFailure = false;
  mocks.retainRecording = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = mocks.voice!.stop();
  });
  await screen.unmount();
  await act(async () => {
    transcript.resolve("Saved words");
    await stopping;
  });
  expect(mocks.backgroundCommitted).toHaveBeenCalledExactlyOnceWith("draft", "Saved words");
});

it("restores saved chat audio after a reload and retries without requesting the microphone", async () => {
  using _state = setup();
  mocks.retainRecording = true;
  mocks.recoveredOwner = "draft";
  await using _screen = await mountProbe();
  expect(mocks.voice!.state).toMatchObject({ phase: "error", hasRecording: true });
  await act(() => mocks.voice!.start());
  expect(mocks.microphoneRequests).toBe(0);
  expect(mocks.transcriptions).toHaveBeenCalledOnce();
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("Raw transcript", expect.anything());
});

it("uses the saved cleanup preference snapshot when retrying audio after reload", async () => {
  using _state = setup();
  mocks.retainRecording = true;
  mocks.recoveredOwner = "draft";
  mocks.postProcessingEnabled = false;
  mocks.recoveredPostProcessing = {
    speechPostProcessingEnabled: true,
    speechCorrectionWord: "fix",
    speechPostProcessingPrompt: { ...DEFAULT_CLIENT_SETTINGS.speechPostProcessingPrompt },
    speechCustomWords: [{ term: "Effect", aliases: ["a fact"] }],
  };
  await using _screen = await mountProbe();
  await act(() => mocks.voice!.start());
  expect(mocks.cleanup).toHaveBeenCalledWith(
    mocks.originPrepared,
    "Raw transcript",
    expect.anything(),
    mocks.recoveredPostProcessing,
  );
  expect(mocks.committed).toHaveBeenCalledWith("Clean transcript", expect.anything());
});

it("clears recovery preparation after the connection changes while storage is pending", async () => {
  using _state = setup();
  mocks.retainRecording = true;
  let resolveRecovery!: (value: null) => void;
  const recovery = new Promise<null>((resolve) => {
    resolveRecovery = resolve;
  });
  mocks.recovery = recovery;
  await using screen = await mountProbe();
  expect(mocks.voice!.state.phase).toBe("preparing");
  mocks.prepared = {} as PreparedConnection;
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state.phase).toBe("preparing");
  await act(async () => {
    resolveRecovery(null);
    await recovery;
  });
  expect(mocks.voice!.state.phase).toBe("idle");
});

it("checks for newly recoverable audio before opening the microphone", async () => {
  using _state = setup();
  mocks.retainRecording = true;
  mocks.microphoneFailure = false;
  await using _screen = await mountProbe();
  mocks.recoveredOwner = "draft";
  await act(() => mocks.voice!.start());
  expect(mocks.microphoneRequests).toBe(0);
  expect(mocks.transcriptions).toHaveBeenCalledOnce();
});

it("retries a failed transcription after leaving and returning to the chat", async () => {
  using _state = setup();
  const transcript = deferredTranscript();
  mocks.transcript = transcript.promise;
  mocks.microphoneFailure = false;
  mocks.retainRecording = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = mocks.voice!.stop();
  });
  mocks.ownerKey = "other-chat";
  await screen.rerender(<Probe input={probeInput()} />);
  await act(async () => {
    transcript.reject(new Error("offline"));
    await stopping;
  });
  mocks.ownerKey = "draft";
  mocks.transcript = Promise.resolve("Recovered text");
  await screen.rerender(<Probe input={probeInput()} />);
  expect(mocks.voice!.state).toMatchObject({ phase: "error", hasRecording: true });
  await act(() => mocks.voice!.start());
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("Recovered text", expect.anything());
  expect(mocks.microphoneRequests).toBe(1);
});

it("reattaches queued Send to a remounted composer", async () => {
  using _state = setup();
  mocks.microphoneFailure = false;
  mocks.retainRecording = true;
  await using screen = await mountProbe();
  await act(() => mocks.voice!.start());
  await screen.unmount();
  await using _remounted = await mountProbe();
  const submitted = vi.fn();
  await act(() => mocks.voice!.submitAfterDictation(submitted));
  expect(submitted).toHaveBeenCalledExactlyOnceWith("Raw transcript");
});
