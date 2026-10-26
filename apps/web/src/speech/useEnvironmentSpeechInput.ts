import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  VoiceTranscriptionError,
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type {
  EnvironmentId,
  ClientSettings,
  SpeechPostProcessingOptions,
  ProjectId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechStreamText,
} from "@t3tools/contracts";
import { SpeechTranscriptionOptions } from "@t3tools/contracts";
import { mergeSpeechCustomWords } from "@t3tools/shared/speech";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { usePreparedConnection } from "../state/session";
import { runtime } from "../lib/runtime";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { recordingStorage } from "./recordingStorage";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { toastManager } from "../components/ui/toast";

const decodeTranscriptionOptions = Schema.decodeSync(SpeechTranscriptionOptions);

const INITIAL_STATE: VoiceInputState<true> = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState<true> = { phase: "preparing", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  readonly environmentId: EnvironmentId;
  readonly projectName?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  readonly retainedDraft?:
    | {
        readonly read: () => DraftInput;
        readonly commit: (text: string) => void;
      }
    | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

type RetainedSession = {
  input: HookInput;
  preferences: {
    clientSettings: ClientSettings;
    originatingEnvironment: ReturnType<typeof useEnvironment>;
  };
  postProcessingPrepared: PreparedConnection | null;
  microphoneId: string;
  onCommit: ((text: string) => void) | null;
  ready: Promise<void>;
  recovering: boolean;
  prepared: PreparedConnection | null;
  controller: VoiceInputController<true>;
  state: VoiceInputState<true>;
  level: number;
  preview: SpeechStreamText | null;
  attached: boolean;
  notify: (() => void) | null;
};
const retainedSessions = new Map<string, RetainedSession>();

function releaseUnusedSession(session: RetainedSession) {
  if (!session.attached && !session.recovering && session.state.phase === "idle") {
    if (retainedSessions.get(session.input.ownerKey) === session)
      retainedSessions.delete(session.input.ownerKey);
  }
}

export function resetRetainedSpeechSessionsForTests() {
  for (const session of retainedSessions.values()) session.controller.dispose();
  retainedSessions.clear();
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const retainedKey = input.retainedDraft ? input.ownerKey : null;
  const clientSettingsHydrated = useClientSettingsHydrated();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const configuredEnvironmentId = useClientSettings(
    (settings) => settings.voiceTranscriptionEnvironmentId,
  );
  const transcriptionEnvironmentId = clientSettingsHydrated
    ? (configuredEnvironmentId ?? primaryEnvironmentId)
    : null;
  const transcriptionEnvironment = useEnvironment(transcriptionEnvironmentId);
  const transcriptionConnection = Option.getOrNull(
    usePreparedConnection(transcriptionEnvironmentId),
  );
  const originatingEnvironment = useEnvironment(input.environmentId);
  const cleanupConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const prepared =
    transcriptionEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
      ? transcriptionConnection
      : null;
  const postProcessingPrepared =
    originatingEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
      ? cleanupConnection
      : null;
  const clientSettings = useClientSettings();
  const preferencesRef = useRef({ clientSettings, originatingEnvironment });
  useEffect(() => {
    preferencesRef.current = { clientSettings, originatingEnvironment };
  }, [clientSettings, originatingEnvironment]);
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const [status, setStatus] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [controllerState, setControllerState] = useState({
    prepared,
    ownerKey: retainedKey,
    value: INITIAL_STATE,
  });
  const [queuedStart, setQueuedStart] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly request: number;
  } | null>(null);
  if (controllerState.prepared !== prepared || controllerState.ownerKey !== retainedKey) {
    setControllerState({ prepared, ownerKey: retainedKey, value: INITIAL_STATE });
  }
  const state: VoiceInputState<true> =
    queuedStart?.prepared === prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared && controllerState.ownerKey === retainedKey
        ? controllerState.value
        : INITIAL_STATE;
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(0);
  const [setupModel, setSetupModel] = useState<EnvironmentSpeechModel | null>(null);
  const [setupDownloading, setSetupDownloading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const setupCancelledRef = useRef(false);
  const controllerRef = useRef<VoiceInputController<true> | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestInputRef = useRef(input);
  const microphoneIdRef = useRef(microphoneId);
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  const previousDraftInputRef = useRef({ ownerKey: input.ownerKey, text: input.draftText });

  useEffect(() => {
    latestInputRef.current = input;
    const previous = previousDraftInputRef.current;
    if (previous.ownerKey === input.ownerKey && previous.text === input.draftText) return;
    previousDraftInputRef.current = { ownerKey: input.ownerKey, text: input.draftText };
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input]);

  useEffect(() => {
    microphoneIdRef.current = microphoneId;
  }, [microphoneId]);

  useEffect(() => {
    const session = retainedKey ? retainedSessions.get(retainedKey) : null;
    if (session) {
      session.input = input;
      session.prepared = prepared;
      session.preferences = preferencesRef.current;
      session.postProcessingPrepared = postProcessingPrepared;
      session.microphoneId = microphoneIdRef.current;
    }
  });

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const existing = retainedKey ? retainedSessions.get(retainedKey) : null;
    const attach = (session: RetainedSession) => {
      session.attached = true;
      session.input = latestInputRef.current;
      session.prepared = prepared;
      session.onCommit = (text) => {
        if (pendingSubmissionRef.current?.ownerKey === session.input.ownerKey)
          pendingSubmissionRef.current.text = text;
      };
      const notify = () => {
        if (session.state.phase === "error") pendingSubmissionRef.current = null;
        setControllerState({ prepared, ownerKey: retainedKey, value: session.state });
        setLevel(session.level);
        setPreview(session.preview);
      };
      session.notify = notify;
      controllerRef.current = session.controller;
      notify();
      return () => {
        session.attached = false;
        session.notify = null;
        session.onCommit = null;
        pendingSubmissionRef.current = null;
        startRequestRef.current += 1;
        if (controllerRef.current === session.controller) controllerRef.current = null;
        releaseUnusedSession(session);
      };
    };
    if (existing) return attach(existing);
    if (!prepared) return;
    let retained: RetainedSession | null = null;
    const sessionInput = latestInputRef.current;
    const sessionRevision = {
      ownerKey: sessionInput.ownerKey,
      text: sessionInput.draftText,
      revision: 0,
    };

    const readDraft = (): VoiceDraftSnapshot => {
      const current = retained ? retained.input : latestInputRef.current;
      const draft =
        retained && !retained.attached ? current.retainedDraft!.read() : current.readDraft();
      const revision = retained ? sessionRevision : draftRevisionRef.current;
      if (revision.ownerKey !== current.ownerKey || revision.text !== draft.text) {
        if (retained)
          Object.assign(sessionRevision, { text: draft.text, revision: revision.revision + 1 });
        else
          draftRevisionRef.current = {
            ownerKey: current.ownerKey,
            text: draft.text,
            revision: revision.revision + 1,
          };
      }
      return {
        ownerKey: current.ownerKey,
        text: draft.text,
        selection: draft.selection,
        revision: retained ? sessionRevision.revision : draftRevisionRef.current.revision,
      };
    };

    let disposed = false;
    let controller: VoiceInputController<true>;
    let recordingPreferences: SpeechPostProcessingOptions | undefined;
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      ...(retainedKey
        ? {
            getPrepared: () => retained?.prepared ?? null,
            retainedDraft: { ownerKey: retainedKey, read: readDraft },
          }
        : {}),
      getTranscriptionOptions: () => {
        const { clientSettings, originatingEnvironment } =
          retained?.preferences ?? preferencesRef.current;
        const { projectId, projectName } = retained ? retained.input : latestInputRef.current;
        if (projectId && !originatingEnvironment?.serverConfig) {
          throw new VoiceTranscriptionError(
            "preparation-failed",
            "Reconnect the project environment to load its dictionary.",
          );
        }
        const projectWords =
          projectId && originatingEnvironment?.serverConfig
            ? resolveProjectSettings(originatingEnvironment.serverConfig.settings, projectId)
                .settings.speechProjectCustomWords
            : [];
        const speechCustomWords = mergeSpeechCustomWords(
          clientSettings.speechCustomWords,
          projectWords,
        );
        recordingPreferences = {
          speechPostProcessingEnabled: clientSettings.speechPostProcessingEnabled,
          speechCorrectionWord: clientSettings.speechCorrectionWord,
          speechPostProcessingPrompt: { ...clientSettings.speechPostProcessingPrompt },
          speechCustomWords,
        };
        try {
          return decodeTranscriptionOptions({
            ...clientSettings,
            speechCustomWords,
            ...(projectName && projectName.length <= 200 ? { projectName } : {}),
          });
        } catch (cause) {
          throw new VoiceTranscriptionError(
            "preparation-failed",
            "Personal and project dictionaries together cannot exceed 100 words.",
            { cause },
          );
        }
      },
      getMicrophoneId: () => retained?.microphoneId ?? microphoneIdRef.current,
      onLevel: (value) => {
        if (retained) {
          retained.level = value;
          retained.notify?.();
        } else if (!disposed) setLevel(value);
      },
      onDurationLimit: () => void controller.stop(),
      onText: (text) => {
        if (retained) {
          retained.preview = text;
          retained.notify?.();
        } else if (!disposed) setPreview(text);
      },
      onError: (message) => {
        if (retained) {
          toastManager.add({
            type: "warning",
            title: "Voice recording stopped",
            description: message,
          });
          // Finalize captured audio on device/storage failure rather than discarding it.
          if (controller.currentState.phase === "recording") void controller.stop();
        } else if (!disposed) void controller.interruptRecording(message);
      },
    });
    controller = new VoiceInputController<true>({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      get postProcess(): VoiceInputControllerDependencies<true>["postProcess"] {
        const preferences = recordingPreferences;
        if (!preferences?.speechPostProcessingEnabled || platform.transcriptIsFinal)
          return undefined;
        return async (transcript, options) => {
          const connection = retained ? retained.postProcessingPrepared : postProcessingPrepared;
          if (!connection)
            throw new Error("The project environment is unavailable for transcript cleanup.");
          const result = await runtime.runPromise(
            postProcessEnvironmentTranscript(
              connection,
              transcript,
              { text: options.draft.text, selection: options.draft.selection },
              preferences,
            ),
            options,
          );
          return result.text;
        };
      },
      ...(retainedKey
        ? {
            onTranscriptReady: async (text: string) => {
              await platform.saveTranscript(text);
            },
          }
        : {}),
      onPostProcessingError: () =>
        toastManager.add({
          type: "warning",
          title: "Post-processing failed",
          description: "The original transcription was added.",
        }),
      readDraft,
      commitDraft: (text, selection) => {
        if (retained) {
          const current = retained.input;
          if (retained.attached && !current.disabled) current.commitDraft(text, selection);
          current.retainedDraft!.commit(text);
        } else {
          if (latestInputRef.current.disabled) return;
          latestInputRef.current.commitDraft(text, selection);
        }
        if (retained) retained.onCommit?.(text);
        else if (pendingSubmissionRef.current?.ownerKey === sessionInput.ownerKey)
          pendingSubmissionRef.current.text = text;
      },
      onStateChange: (value) => {
        if (retained) {
          retained.state = value;
          if (value.phase !== "recording" && value.phase !== "transcribing")
            retained.preview = null;
          retained.notify?.();
          releaseUnusedSession(retained);
        } else if (!disposed) {
          if (value.phase === "error") pendingSubmissionRef.current = null;
          setControllerState({ prepared, ownerKey: retainedKey, value });
          if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
        }
      },
    });
    if (retainedKey) {
      retained = {
        input: sessionInput,
        prepared,
        controller,
        state: INITIAL_STATE,
        preferences: preferencesRef.current,
        postProcessingPrepared,
        microphoneId: microphoneIdRef.current,
        onCommit: null,
        ready: Promise.resolve(),
        recovering: true,
        level: 0,
        preview: null,
        attached: true,
        notify: null,
      };
      const session = retained;
      retainedSessions.set(retainedKey, session);
      const detach = attach(session);
      setQueuedStart({ prepared, request: startRequestRef.current });
      session.ready = recordingStorage
        .find(retainedKey)
        .then(async (saved) => {
          if (!saved) return;
          if (saved.transcript !== undefined) {
            const result = resolveTranscriptCommit(
              saved.draft,
              saved.draft,
              saved.transcript,
              saved.locale,
            );
            if (result.kind === "commit" && result.text === readDraft().text) {
              await recordingStorage.remove(saved.id);
              return;
            }
          }
          const { uri, transcription } = await platform.restoreRecording(saved);
          // Browser reloads reset the in-memory revision counter.
          sessionRevision.text = saved.draft.text;
          sessionRevision.revision = saved.draft.revision;
          controller.restoreRecording(uri, saved.draft, transcription);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not restore saved dictation",
            description: String(error),
          });
        })
        .finally(() => {
          session.recovering = false;
          releaseUnusedSession(session);
          if (!disposed) setQueuedStart(null);
        });
      return () => {
        disposed = true;
        if (session.recovering) setQueuedStart(null);
        detach();
      };
    }
    controllerRef.current = controller;
    setControllerState({ prepared, ownerKey: retainedKey, value: INITIAL_STATE });
    setPreview(null);
    setLevel(0);
    return () => {
      disposed = true;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [postProcessingPrepared, prepared, retainedKey]);

  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    void runtime
      .runPromise(getEnvironmentSpeechStatus(prepared))
      .then((next) => {
        if (!disposed) setStatus({ prepared, value: next });
      })
      .catch(() => {
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  const currentStatus = status?.prepared === prepared ? status.value : null;

  useEffect(() => {
    if (!setupOpen || !setupDownloading || !prepared || !currentStatus?.supported) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runtime
        .runPromise(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (!disposed)
            setSetupModel(
              result.models.find((model) => model.id === currentStatus.modelId) ?? null,
            );
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 350);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentStatus, prepared, setupDownloading, setupOpen]);

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    setQueuedStart(null);
    if (!retainedKey) controllerRef.current?.ownerChanged();
    setSetupOpen(false);
  }, [input.ownerKey, input.disabled, retainedKey]);

  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = (submit: (text: string) => void) => {
    if (latestInputRef.current.disabled || state.phase === "preparing") return;
    const controller = controllerRef.current;
    if (!controller || !voiceInputBlocksSubmission(state)) {
      submit(latestInputRef.current.readDraft().text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestInputRef.current.ownerKey, submit };
    if (controller.currentState.phase === "recording") void controller.stop();
  };

  const start = async () => {
    const request = ++startRequestRef.current;
    const expectedController = controllerRef.current;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (latestInputRef.current.disabled || !expectedController) return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === expectedController &&
      latestInputRef.current.ownerKey === expectedOwner &&
      !latestInputRef.current.disabled;
    const session = retainedKey ? retainedSessions.get(retainedKey) : null;
    if (session) await session.ready;
    if (!stillCurrent()) return;
    if (expectedController.currentState.hasRecording) {
      await expectedController.start();
      return;
    }
    if (!prepared || !currentStatus?.supported) return;
    setQueuedStart({ prepared, request });
    let latestStatus: EnvironmentSpeechStatus;
    try {
      latestStatus = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
      if (!stillCurrent()) return;
      if (latestStatus.supported && latestStatus.state === "transcribing") {
        setQueuedStart({ prepared, request });
        // Remember the press and start when the previous stream drains,
        // like Handy does, instead of erroring after a fixed wait.
        // Esc, cancel, or a draft change (stillCurrent) abandons the queue.
        while (latestStatus.supported && latestStatus.state === "transcribing") {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          if (!stillCurrent()) return;
          latestStatus = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
          if (!stillCurrent()) return;
        }
      }
    } catch (error) {
      if (!stillCurrent()) return;
      toastManager.add({
        type: "error",
        title: "Could not start voice input",
        description: error instanceof Error ? error.message : String(error),
      });
      setQueuedStart(null);
      return;
    }
    setQueuedStart(null);
    if (!latestStatus.supported) return;
    setStatus({ prepared, value: latestStatus });
    if (latestStatus.state === "missing-model") {
      setSetupStep(0);
      setSetupOpen(true);
      return;
    }
    if (!stillCurrent()) return;
    setLevel(0);
    await expectedController.start();
  };

  const downloadSetupModel = async () => {
    if (!prepared || !currentStatus?.supported || setupDownloading) return;
    setupCancelledRef.current = false;
    setSetupDownloading(true);
    setSetupError(null);
    try {
      await runtime.runPromise(downloadEnvironmentSpeechModel(prepared, currentStatus.modelId));
      if (setupCancelledRef.current) return;
      const next = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
      setStatus({ prepared, value: next });
      if (!next.supported || next.state === "missing-model") {
        setSetupError("The model is not ready. Try downloading it again.");
        return;
      }
      setSetupStep(1);
    } catch {
      if (!setupCancelledRef.current)
        setSetupError(
          "Could not download the model. Check this environment's connection and try again.",
        );
    } finally {
      setSetupDownloading(false);
    }
  };

  const cancelSetupDownload = async () => {
    if (!prepared || !currentStatus?.supported) return;
    setupCancelledRef.current = true;
    setSetupOpen(false);
    try {
      await runtime.runPromise(
        cancelEnvironmentSpeechModelDownload(prepared, currentStatus.modelId),
      );
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    }
  };

  const startAfterSetup = async () => {
    setSetupOpen(false);
    await start();
  };

  return {
    available:
      (currentStatus?.supported === true || (retainedKey !== null && state.phase !== "idle")) &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId,
    setup: {
      open: setupOpen,
      step: setupStep,
      model: setupModel,
      downloading: setupDownloading,
      error: setupError,
      setOpen: setSetupOpen,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: startAfterSetup,
    },
    state,
    progress: null,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    submitAfterDictation,
    stop: () => controllerRef.current?.stop() ?? Promise.resolve(),
    cancel: () => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controllerRef.current?.cancel();
    },
    skipPostProcessing: () => controllerRef.current?.skipPostProcessing(),
  };
}
