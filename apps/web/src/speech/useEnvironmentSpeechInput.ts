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
  resolveLiveTranscriptCancel,
  resolveLiveTranscriptUpdate,
  type VoiceDraftSnapshot,
  type VoiceLiveTranscript,
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
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { toastManager } from "../components/ui/toast";
import { isVoiceRecordingLocked, recordingStorage } from "./recordingStorage";
import {
  notifyVoiceRecordingRecoveryChange,
  subscribeVoiceRecordingRecovery,
} from "./recordingRecoveryEvents";

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
  readonly closedQuestionRecordings?:
    | {
        readonly ownerKeyPrefix: string;
        readonly isDestinationAvailable: (ownerKey: string) => boolean;
      }
    | undefined;
  readonly retainedDraft?:
    | {
        readonly read: () => DraftInput | null;
        readonly commit: (text: string, recordingId?: string) => string | void;
        readonly hasDelivered?: (recordingId: string) => boolean;
        readonly forgetDelivered?: (recordingId: string) => void;
      }
    | undefined;
  readonly readDraft: () => DraftInput | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

type SpeechSessionContext = {
  ownerKey: string;
  closedQuestionRecovery: boolean;
  projectId: ProjectId | undefined;
  projectName: string | undefined;
  retainedDraft: HookInput["retainedDraft"];
  preferences: {
    clientSettings: ClientSettings;
    originatingEnvironment: ReturnType<typeof useEnvironment>;
  };
  postProcessingPrepared: PreparedConnection | null;
  microphoneId: string;
  prepared: PreparedConnection | null;
};

type DraftRevision = { ownerKey: string; text: string; revision: number };

type SpeechSession = {
  context: SpeechSessionContext;
  recoveryAccepted: boolean;
  revision: DraftRevision;
  attachment: {
    disabled: boolean | undefined;
    readDraft: HookInput["readDraft"];
    commitDraft: HookInput["commitDraft"];
    onCommit: (text: string) => void;
    notify: () => void;
  } | null;
  ready: Promise<void>;
  recover: () => Promise<void>;
  recovering: boolean;
  controller: VoiceInputController<true>;
  state: VoiceInputState<true>;
  level: number;
  preview: SpeechStreamText | null;
  liveTranscript: VoiceLiveTranscript | null;
};
const retainedSessions = new Map<string, SpeechSession>();

function releaseUnusedSession(session: SpeechSession) {
  if (!session.attachment && !session.recovering && session.state.phase === "idle") {
    if (retainedSessions.get(session.context.ownerKey) === session)
      retainedSessions.delete(session.context.ownerKey);
  }
}

function readSessionDraft(session: SpeechSession): VoiceDraftSnapshot | null {
  if (session.context.closedQuestionRecovery && !session.recoveryAccepted) return null;
  const draft = session.attachment
    ? session.attachment.readDraft()
    : session.context.retainedDraft?.read();
  if (!draft) return null;
  const revision = session.revision;
  if (revision.ownerKey !== session.context.ownerKey || revision.text !== draft.text) {
    Object.assign(revision, {
      ownerKey: session.context.ownerKey,
      text: draft.text,
      revision: revision.revision + 1,
    });
  }
  return {
    ownerKey: session.context.ownerKey,
    text: draft.text,
    selection: draft.selection,
    revision: revision.revision,
  };
}

// Retained controllers must close over session data only; editor callbacks live in attachment.
function createSpeechSession(
  context: SpeechSessionContext,
  revision: DraftRevision,
): SpeechSession {
  if (!context.prepared) throw new Error("The transcription environment is disconnected.");
  let session: SpeechSession;
  let controller: VoiceInputController<true>;
  let recordingPreferences: SpeechPostProcessingOptions | undefined;
  const platform = createBrowserVoiceInputPlatform({
    prepared: context.prepared,
    onRecordingRemoved: (recordingId) => {
      try {
        session.context.retainedDraft?.forgetDelivered?.(recordingId);
      } catch {
        // A stale receipt is harmless once its audio has been removed.
      }
    },
    getPrepared: () => session.context.prepared,
    ...(context.retainedDraft
      ? {
          retainedDraft: {
            ownerKey: context.ownerKey,
            read: () => readSessionDraft(session)!,
          },
        }
      : {}),
    getTranscriptionOptions: () => {
      const { clientSettings, originatingEnvironment } = session.context.preferences;
      const { projectId, projectName } = session.context;
      if (projectId && !originatingEnvironment?.serverConfig) {
        throw new VoiceTranscriptionError(
          "preparation-failed",
          "Reconnect the project environment to load its dictionary.",
        );
      }
      const projectWords =
        projectId && originatingEnvironment?.serverConfig
          ? resolveProjectSettings(originatingEnvironment.serverConfig.settings, projectId).settings
              .speechProjectCustomWords
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
    getMicrophoneId: () => session.context.microphoneId,
    getPostProcessingOptions: () => recordingPreferences,
    onLevel: (value) => {
      session.level = value;
      session.attachment?.notify();
    },
    onDurationLimit: () => void controller.stop(),
    onText: (text, locale = "auto") => {
      session.preview = text;
      session.attachment?.notify();
      session.controller.updateStreamingTranscript(`${text.committed}${text.tentative}`, locale);
    },
    onStorageWarning: (message) => {
      toastManager.add({
        type: "warning",
        title: "Transcript backup unavailable",
        description: message,
      });
    },
    onError: (message) => {
      if (session.context.retainedDraft) {
        toastManager.add({
          type: "warning",
          title: "Voice recording stopped",
          description: message,
        });
        // Finalize captured audio on device/storage failure rather than discarding it.
        if (controller.currentState.phase === "recording") void controller.stop();
      } else if (session.attachment) void controller.interruptRecording(message);
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
      const preferences = platform.postProcessingOptions ?? recordingPreferences;
      if (!preferences?.speechPostProcessingEnabled || platform.transcriptIsFinal) return undefined;
      return async (transcript, options) => {
        const connection = session.context.postProcessingPrepared;
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
    ...(context.retainedDraft
      ? {
          onTranscriptReady: async (text: string, draft: VoiceDraftSnapshot) => {
            await platform.saveTranscript(text, draft);
          },
        }
      : {}),
    onPostProcessingError: () =>
      toastManager.add({
        type: "warning",
        title: "Post-processing failed",
        description: "The original transcription was added.",
      }),
    readDraft: () => readSessionDraft(session),
    onStreamingTranscript: (text, captured, locale) => {
      if (session.context.retainedDraft) return null;
      const current = readSessionDraft(session);
      if (!current) return null;
      const update = resolveLiveTranscriptUpdate(current, session.liveTranscript, text, locale);
      if (!update) return null;
      session.liveTranscript = update.live;
      Object.assign(session.revision, {
        ownerKey: update.draft.ownerKey,
        text: update.draft.text,
        revision: update.draft.revision,
      });
      session.attachment?.commitDraft(update.draft.text, update.draft.selection);
      session.attachment?.onCommit(update.draft.text);
      return update.draft;
    },
    onStreamingCancel: () => {
      const current = readSessionDraft(session);
      const live = session.liveTranscript;
      session.liveTranscript = null;
      if (!current || !live) return;
      const draft = resolveLiveTranscriptCancel(current, live);
      if (!draft) return;
      Object.assign(session.revision, {
        ownerKey: draft.ownerKey,
        text: draft.text,
        revision: draft.revision,
      });
      session.attachment?.commitDraft(draft.text, draft.selection);
    },
    commitDraft: (text, selection) => {
      if (session.context.closedQuestionRecovery && !session.recoveryAccepted)
        throw new Error("Choose Recover to draft to insert this saved question recording.");
      const attachment = session.attachment;
      let deliveredText = text;
      if (session.context.retainedDraft) {
        deliveredText =
          session.context.retainedDraft.commit(text, platform.recordingId ?? undefined) ?? text;
        if (attachment && !attachment.disabled) {
          const deliveredSelection =
            deliveredText === text
              ? selection
              : (attachment.readDraft()?.selection ?? {
                  start: deliveredText.length,
                  end: deliveredText.length,
                });
          attachment.commitDraft(deliveredText, deliveredSelection);
        }
      } else {
        if (!attachment || attachment.disabled) return;
        attachment.commitDraft(text, selection);
      }
      attachment?.onCommit(deliveredText);
    },
    onStateChange: (value) => {
      session.state = value;
      if (value.phase === "idle") session.liveTranscript = null;
      if (value.phase !== "recording" && value.phase !== "transcribing") session.preview = null;
      session.attachment?.notify();
      releaseUnusedSession(session);
      if (session.context.retainedDraft && (value.phase === "idle" || value.phase === "error"))
        notifyVoiceRecordingRecoveryChange();
    },
  });
  session = {
    context,
    recoveryAccepted: false,
    revision,
    attachment: null,
    controller,
    state: INITIAL_STATE,
    ready: Promise.resolve(),
    recovering: false,
    level: 0,
    preview: null,
    liveTranscript: null,
    recover: () => {
      if (!session.context.retainedDraft) return Promise.resolve();
      if (session.recovering) return session.ready;
      session.recovering = true;
      session.ready = platform
        .findRecording()
        .then(async (saved) => {
          if (!saved) return;
          if (session.context.retainedDraft?.hasDelivered?.(saved.id)) {
            await platform.discardSavedRecording();
            return;
          }
          if (
            !session.context.retainedDraft?.hasDelivered &&
            saved.transcriptIsFinal === true &&
            saved.transcript !== undefined
          ) {
            const result = resolveTranscriptCommit(
              saved.draft,
              saved.draft,
              saved.transcript,
              saved.locale,
            );
            if (result.kind === "commit" && result.text === readSessionDraft(session)?.text) {
              await platform.discardSavedRecording();
              return;
            }
          }
          // A peer's recording can become recoverable after a failed microphone start.
          if (controller.currentState.phase === "error" && !controller.currentState.hasRecording)
            controller.cancel();
          const { uri, transcription } = await platform.restoreRecording(saved);
          // Browser reloads reset the in-memory revision counter.
          session.revision.text = saved.draft.text;
          session.revision.revision = saved.draft.revision;
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
          session.attachment?.notify();
          releaseUnusedSession(session);
        });
      session.attachment?.notify();
      return session.ready;
    },
  };
  return session;
}

export function resetRetainedSpeechSessionsForTests() {
  for (const session of retainedSessions.values()) session.controller.dispose();
  retainedSessions.clear();
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const [closedQuestionSelection, setClosedQuestionSelection] = useState<{
    chatOwnerKey: string;
    recordingOwnerKey: string | null;
  } | null>(null);
  const closedQuestionOwner =
    input.closedQuestionRecordings && closedQuestionSelection?.chatOwnerKey === input.ownerKey
      ? closedQuestionSelection.recordingOwnerKey
      : null;
  const retainedKey = input.retainedDraft ? (closedQuestionOwner ?? input.ownerKey) : null;
  const closedQuestionRecordings = input.closedQuestionRecordings;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to voice-recording recovery changes while this chat owner is mounted and resolves its retained recording.
  useEffect(() => {
    if (!closedQuestionRecordings || !input.retainedDraft) return;
    let disposed = false;
    let request = 0;
    const chatOwnerKey = input.ownerKey;
    const refresh = async () => {
      const currentRequest = ++request;
      const normalSession = retainedSessions.get(chatOwnerKey);
      if (normalSession && normalSession.state.phase !== "idle") return;
      const prefix = closedQuestionRecordings.ownerKeyPrefix;
      const saved = await recordingStorage.listByOwnerPrefix(prefix);
      const owners = new Set([
        ...saved.map((recording) => recording.ownerKey),
        ...[...retainedSessions.entries()]
          .filter(
            ([owner, session]) =>
              owner.startsWith(prefix) &&
              (session.state.hasRecording || voiceInputBlocksSubmission(session.state)),
          )
          .map(([owner]) => owner),
      ]);
      let recordingOwnerKey: string | null = null;
      for (const owner of owners) {
        if (closedQuestionRecordings.isDestinationAvailable(owner)) continue;
        if (retainedSessions.has(owner)) {
          recordingOwnerKey = owner;
          break;
        }
        if (!(await isVoiceRecordingLocked(owner))) {
          recordingOwnerKey = owner;
          break;
        }
      }
      if (!disposed && currentRequest === request)
        setClosedQuestionSelection((previous) =>
          previous?.chatOwnerKey === chatOwnerKey &&
          previous.recordingOwnerKey === recordingOwnerKey
            ? previous
            : { chatOwnerKey, recordingOwnerKey },
        );
    };
    const notify = () => void refresh().catch(() => undefined);
    const unsubscribe = subscribeVoiceRecordingRecovery(notify);
    notify();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [closedQuestionRecordings, input.ownerKey, input.retainedDraft]);
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
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const sessionContext: SpeechSessionContext = {
    ownerKey: retainedKey ?? input.ownerKey,
    closedQuestionRecovery: closedQuestionOwner !== null,
    projectId: input.projectId,
    projectName: input.projectName,
    retainedDraft: input.retainedDraft,
    preferences: { clientSettings, originatingEnvironment },
    prepared,
    postProcessingPrepared,
    microphoneId,
  };
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
  const sessionRef = useRef<SpeechSession | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestInputRef = useRef(input);
  const latestSessionContextRef = useRef(sessionContext);
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  const previousDraftInputRef = useRef({ ownerKey: input.ownerKey, text: input.draftText });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps async speech callbacks and the draft revision check in step with the latest editor props.
  useEffect(() => {
    latestInputRef.current = input;
    const previous = previousDraftInputRef.current;
    if (previous.ownerKey === input.ownerKey && previous.text === input.draftText) return;
    previousDraftInputRef.current = { ownerKey: input.ownerKey, text: input.draftText };
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      Object.assign(revision, {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      });
    }
  }, [input]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps a retained session's mutable context and editor callbacks in step with React inputs.
  useEffect(() => {
    latestSessionContextRef.current = sessionContext;
    const session = sessionRef.current;
    if (
      !session ||
      (session.context.retainedDraft ? session.context.ownerKey : null) !== retainedKey
    )
      return;
    session.context = sessionContext;
    if (session.attachment) {
      session.attachment.disabled = input.disabled;
      session.attachment.readDraft = input.readDraft;
      session.attachment.commitDraft = input.commitDraft;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attaches the controller to this hook's owner and detaches or disposes it on connection or owner changes.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const existing = retainedKey ? retainedSessions.get(retainedKey) : null;
    if (!existing && !prepared) return;
    const context = { ...latestSessionContextRef.current, prepared, postProcessingPrepared };
    const currentInput = latestInputRef.current;
    const session =
      existing ??
      createSpeechSession(
        context,
        retainedKey
          ? { ownerKey: currentInput.ownerKey, text: currentInput.draftText, revision: 0 }
          : draftRevisionRef.current,
      );
    session.context = context;
    const attachment = {
      disabled: currentInput.disabled,
      readDraft: currentInput.readDraft,
      commitDraft: currentInput.commitDraft,
      onCommit: (text: string) => {
        if (pendingSubmissionRef.current?.ownerKey === session.context.ownerKey)
          pendingSubmissionRef.current.text = text;
      },
      notify: () => {
        if (session.state.phase === "error") pendingSubmissionRef.current = null;
        setControllerState({
          prepared,
          ownerKey: retainedKey,
          value: session.recovering ? WAITING_STATE : session.state,
        });
        setLevel(session.level);
        setPreview(session.preview);
        if (session.state.phase === "idle") {
          const pending = pendingSubmissionRef.current;
          if (!pending) return;
          pendingSubmissionRef.current = null;
          const latestInput = latestInputRef.current;
          if (
            !latestInput.disabled &&
            pending.ownerKey === latestInput.ownerKey &&
            pending.text !== undefined
          )
            pending.submit(pending.text);
        }
      },
    };
    session.attachment = attachment;
    sessionRef.current = session;
    if (retainedKey && !existing) retainedSessions.set(retainedKey, session);
    attachment.notify();
    if (retainedKey && !existing) void session.recover();
    return () => {
      if (session.attachment === attachment) session.attachment = null;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      if (sessionRef.current === session) sessionRef.current = null;
      if (retainedKey) releaseUnusedSession(session);
      else session.controller.dispose();
    };
  }, [postProcessingPrepared, prepared, retainedKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads speech capability status for the prepared connection and ignores results after it changes.
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls model download progress while the setup dialog is open and clears its timer on exit.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels active recording and queued submission work when the owner changes or becomes disabled.
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    setQueuedStart(null);
    if (!retainedKey) sessionRef.current?.controller.ownerChanged();
    setSetupOpen(false);
  }, [input.ownerKey, input.disabled, retainedKey]);

  const submitAfterDictation = (submit: (text: string) => void) => {
    if (latestInputRef.current.disabled || state.phase === "preparing") return;
    const controller = sessionRef.current?.controller;
    if (!controller || !voiceInputBlocksSubmission(state)) {
      const draft = latestInputRef.current.readDraft();
      if (draft) submit(draft.text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestInputRef.current.ownerKey, submit };
    if (controller.currentState.phase === "recording") void controller.stop();
  };

  const start = async () => {
    const request = ++startRequestRef.current;
    const expectedController = sessionRef.current?.controller;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (latestInputRef.current.disabled || !expectedController) return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      sessionRef.current?.controller === expectedController &&
      latestInputRef.current.ownerKey === expectedOwner &&
      !latestInputRef.current.disabled;
    const session = retainedKey ? retainedSessions.get(retainedKey) : null;
    if (session) {
      await session.ready;
      if (
        stillCurrent() &&
        !expectedController.currentState.hasRecording &&
        (expectedController.currentState.phase === "idle" ||
          expectedController.currentState.phase === "error")
      )
        await session.recover();
    }
    if (!stillCurrent()) return;
    if (expectedController.currentState.hasRecording) {
      if (session?.context.closedQuestionRecovery && !session.recoveryAccepted) {
        session.recoveryAccepted = true;
        await expectedController.retryIntoCurrentDraft();
      } else await expectedController.start();
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
    recoveringClosedQuestion: closedQuestionOwner !== null,
    progress: null,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    submitAfterDictation,
    stop: () => sessionRef.current?.controller.stop() ?? Promise.resolve(),
    cancel: () => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      sessionRef.current?.controller.cancel();
    },
    skipPostProcessing: () => sessionRef.current?.controller.skipPostProcessing(),
  };
}
