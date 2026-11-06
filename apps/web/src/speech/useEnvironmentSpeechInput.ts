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
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type {
  ClientSettings,
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  ProjectId,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useLatestRef } from "~/hooks/useLatestRef";
import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { runtime } from "../lib/runtime";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { isVoiceRecordingLocked, recordingStorage } from "./recordingStorage";
import {
  notifyVoiceRecordingRecoveryChange,
  subscribeVoiceRecordingRecovery,
} from "./recordingRecoveryEvents";
import { bindAudioGrant, readCleanupGrant, useAudioGrant } from "./voiceConsent";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  downloading: false,
  error: null as string | null,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runtime.runPromise(getEnvironmentSpeechStatus(prepared));
  statusProbes.set(prepared, probe);
  probe.catch(() => {
    if (statusProbes.get(prepared) === probe) statusProbes.delete(prepared);
  });
  return probe;
}

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

function cleanupContext({ text, selection }: DraftInput): DraftInput {
  const limit = 1_024;
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const before = text.slice(Math.max(0, start - limit), start);
  const selected = text.slice(start, Math.min(end, start + limit));
  return {
    text: before + selected + text.slice(end, end + limit),
    selection: { start: before.length, end: before.length + selected.length },
  };
}

type HookInput = {
  /** The draft's own environment. Optional transcript cleanup runs there, never on the audio destination. */
  readonly environmentId: EnvironmentId;
  /** The draft's project: its vocabulary on that environment and its name become recognition hints. */
  readonly projectId?: ProjectId | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
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
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
  cleanup: boolean;
  retainedDraft: HookInput["retainedDraft"];
  preferences: {
    clientSettings: ClientSettings;
    originatingEnvironment: ReturnType<typeof useEnvironment>;
  };
  postProcessingPrepared: PreparedConnection | null;
  microphoneId: string;
};

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 */
export function useVoiceTranscriptionDestination() {
  const hydrated = useClientSettingsHydrated();
  const grant = useAudioGrant();
  const environmentId = hydrated && grant ? grant.destination.environmentId : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const supported = environment?.serverConfig?.environment.capabilities.voiceTranscription === true;
  return {
    environmentId,
    grantId: grant?.id ?? null,
    label: environment?.label ?? null,
    prepared: supported && canDictate ? connection : null,
  };
}

type DraftRevision = { ownerKey: string; text: string; revision: number };

type SpeechSession = {
  readonly prepared: PreparedConnection;
  readonly grantId: string;
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
  controller: VoiceInputController;
  state: VoiceInputState;
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

function disposeRetainedSession(session: SpeechSession) {
  if (retainedSessions.get(session.context.ownerKey) === session)
    retainedSessions.delete(session.context.ownerKey);
  session.controller.dispose();
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
  prepared: PreparedConnection,
  grantId: string,
): SpeechSession {
  const hasAudioConsent = bindAudioGrant(grantId);
  let session: SpeechSession;
  let controller: VoiceInputController;
  let recordingPreferences:
    | {
        readonly cleanup: SpeechPostProcessingOptions | null;
        readonly cleanupGrant: string | null;
        readonly environmentId: EnvironmentId;
      }
    | undefined;
  const platform = createBrowserVoiceInputPlatform({
    prepared,
    hasAudioConsent,
    onRecordingRemoved: (recordingId) => {
      try {
        session.context.retainedDraft?.forgetDelivered?.(recordingId);
      } catch {
        // A stale receipt is harmless once its audio has been removed.
      }
    },
    ...(context.retainedDraft
      ? {
          retainedDraft: {
            ownerKey: context.ownerKey,
            read: () => readSessionDraft(session)!,
          },
        }
      : {}),
    getTranscriptionOptions: (): SpeechTranscriptionOptions => {
      const { clientSettings, originatingEnvironment } = session.context.preferences;
      const { projectId, projectName, environmentId, cleanup } = session.context;
      if (projectId && !originatingEnvironment?.serverConfig) {
        throw new VoiceTranscriptionError({
          code: "preparation-failed",
          message: "Reconnect the project environment to load its dictionary.",
        });
      }
      const projectWords =
        projectId && originatingEnvironment?.serverConfig
          ? resolveProjectSettings(originatingEnvironment.serverConfig.settings, projectId).settings
              .speechProjectCustomWords
          : [];
      const cleanupGrant =
        cleanup && clientSettings.speechPostProcessingEnabled ? readCleanupGrant() : null;
      const cleanupEnabled = cleanupGrant !== null;
      const cue =
        cleanupEnabled && session.context.postProcessingPrepared
          ? clientSettings.speechCorrectionWord
          : "";
      const speechCustomWords = resolveSpeechVocabulary({
        personal: clientSettings.speechCustomWords,
        project: projectWords,
        hints: [cue, projectName ?? ""],
      });
      recordingPreferences = {
        cleanupGrant,
        environmentId,
        cleanup: cleanupEnabled
          ? {
              speechCustomWords,
              speechPostProcessingPrompt: clientSettings.speechPostProcessingPrompt,
              ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
            }
          : null,
      };
      return {
        speechLanguage: clientSettings.speechLanguage,
        speechTranslateToEnglish: clientSettings.speechTranslateToEnglish,
        speechCustomWords,
        speechRemoveFillerWords: clientSettings.speechRemoveFillerWords,
        ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
        speechSilenceFiltering: clientSettings.speechSilenceFiltering,
      };
    },
    getMicrophoneId: () => session.context.microphoneId,
    getPostProcessingOptions: () => recordingPreferences?.cleanup ?? undefined,
    onLevel: (value) => {
      session.level = value;
      session.attachment?.notify();
    },
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
  controller = new VoiceInputController({
    recorder: platform.recorder,
    getTranscriber: () => platform.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: async () => platform.cancelRecording(),
    deleteRecording: platform.deleteRecording,
    postProcess: (transcript, options) => {
      const preferences = recordingPreferences;
      const cleanup = platform.postProcessingOptions ?? preferences?.cleanup ?? null;
      const { context: current } = session;
      const cleanupGrant = preferences ? preferences.cleanupGrant : readCleanupGrant();
      if (
        !cleanup ||
        platform.transcriptIsFinal ||
        !current.cleanup ||
        !hasAudioConsent() ||
        cleanupGrant === null ||
        cleanupGrant !== readCleanupGrant() ||
        (preferences && preferences.environmentId !== current.environmentId) ||
        current.ownerKey !== options.draft.ownerKey
      )
        return null;
      const target = current.postProcessingPrepared;
      if (!target)
        return Promise.reject(
          new Error("The draft's environment is unavailable for transcript cleanup."),
        );
      return runtime
        .runPromise(
          postProcessEnvironmentTranscript(
            target,
            transcript,
            cleanupContext(options.draft),
            cleanup,
            () => hasAudioConsent() && cleanupGrant === readCleanupGrant(),
          ),
          options,
        )
        .then((result) => result.text);
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
        title: "Transcript cleanup failed",
        description: "The original transcript was added.",
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
    prepared,
    grantId,
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
      request += 1;
      const currentRequest = request;
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
  const destination = useVoiceTranscriptionDestination();
  const prepared = destination.prepared;
  const grantId = destination.grantId;
  const originatingEnvironment = useEnvironment(input.environmentId);
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const postProcessingPrepared =
    canCleanUp &&
    originatingEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
      ? originatingConnection
      : null;
  const clientSettings = useClientSettings();
  const sessionContext: SpeechSessionContext = {
    ownerKey: retainedKey ?? input.ownerKey,
    closedQuestionRecovery: closedQuestionOwner !== null,
    environmentId: input.environmentId,
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    cleanup: input.cleanup !== false,
    retainedDraft: input.retainedDraft,
    preferences: { clientSettings, originatingEnvironment },
    postProcessingPrepared,
    microphoneId: clientSettings.voiceMicrophone,
  };
  const [status, setStatus] = useState<{
    readonly prepared: PreparedConnection;
    readonly value: EnvironmentSpeechStatus | null;
  } | null>(null);
  const [controllerState, setControllerState] = useState({
    prepared,
    grantId,
    ownerKey: retainedKey,
    value: INITIAL_STATE,
  });
  const [queuedStart, setQueuedStart] = useState<PreparedConnection | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  if (
    controllerState.prepared !== prepared ||
    controllerState.grantId !== grantId ||
    controllerState.ownerKey !== retainedKey
  ) {
    setControllerState({ prepared, grantId, ownerKey: retainedKey, value: INITIAL_STATE });
    setSetup(INITIAL_SETUP);
    setQueuedStart(null);
    setPreview(null);
    setLevel(0);
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setQueuedStart(null);
    setSetup(INITIAL_SETUP);
  }
  const state: VoiceInputState =
    queuedStart === prepared && prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared &&
          controllerState.grantId === grantId &&
          controllerState.ownerKey === retainedKey
        ? controllerState.value
        : INITIAL_STATE;
  const sessionRef = useRef<SpeechSession | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestInputRef = useLatestRef(input);
  const latestSessionContextRef = useRef(sessionContext);
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks committed draft revisions so a late transcript cannot overwrite an edited draft
  useEffect(() => {
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input.ownerKey, input.draftText]);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attaches the controller bound to the consented destination and disposes it with the consent, the connection, or the owner.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    let existing = retainedKey ? retainedSessions.get(retainedKey) : undefined;
    if (existing && (existing.prepared !== prepared || existing.grantId !== grantId)) {
      disposeRetainedSession(existing);
      existing = undefined;
    }
    if (!existing && (!prepared || !grantId)) return;
    const currentInput = latestInputRef.current;
    const session =
      existing ??
      createSpeechSession(
        latestSessionContextRef.current,
        retainedKey
          ? { ownerKey: currentInput.ownerKey, text: currentInput.draftText, revision: 0 }
          : draftRevisionRef.current,
        prepared!,
        grantId!,
      );
    session.context = latestSessionContextRef.current;
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
          grantId,
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
  }, [grantId, latestInputRef, prepared, retainedKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    void probeSpeechStatus(prepared)
      .then((value) => {
        if (!disposed) setStatus({ prepared, value });
      })
      .catch(() => {
        if (!disposed) setStatus({ prepared, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);
  const currentStatus = status?.prepared === prepared ? status.value : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !currentStatus?.supported) return;
    const modelId = currentStatus.modelId;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runtime
        .runPromise(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === modelId) ?? null;
          setSetup((current) => ({ ...current, model }));
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
  }, [currentStatus, prepared, setup.downloading, setup.open]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels active recording and queued submission work when the owner changes or becomes disabled.
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    if (!retainedKey) sessionRef.current?.controller.ownerChanged();
  }, [input.ownerKey, input.disabled, retainedKey]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
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
  });

  const start = useStableCallback(async () => {
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
    if (!prepared) return;
    setQueuedStart(prepared);
    let latestStatus: EnvironmentSpeechStatus;
    try {
      latestStatus = await probeSpeechStatus(prepared, true);
      if (!stillCurrent()) return;
      // Remember the press and start when the previous stream drains, like Handy does,
      // instead of erroring after a fixed wait. Esc, cancel, or a draft change abandons the queue.
      while (latestStatus.supported && latestStatus.state === "transcribing") {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (!stillCurrent()) return;
        latestStatus = await probeSpeechStatus(prepared, true);
        if (!stillCurrent()) return;
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
    setStatus({ prepared, value: latestStatus });
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: "Voice input is not available",
        description: latestStatus.reason,
      });
      return;
    }
    if (latestStatus.state === "missing-model") {
      setSetup({ ...INITIAL_SETUP, open: true });
      return;
    }
    setLevel(0);
    await expectedController.start();
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || setup.downloading) return;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      await runtime.runPromise(downloadEnvironmentSpeechModel(prepared, currentStatus.modelId));
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: next.supported && next.state !== "missing-model" ? 1 : current.step,
        error:
          next.supported && next.state !== "missing-model"
            ? null
            : "The model is not ready. Try downloading it again.",
      }));
    } catch {
      if (request !== startRequestRef.current) return;
      setSetup((current) => ({
        ...current,
        downloading: false,
        error: "Could not download the model. Check this environment's connection and try again.",
      }));
    }
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runtime.runPromise(
        cancelEnvironmentSpeechModelDownload(prepared, currentStatus.modelId),
      );
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  return {
    available:
      prepared !== null &&
      ((status?.prepared === prepared && status.value?.supported !== false) ||
        (retainedKey !== null && state.phase !== "idle")) &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        await start();
      },
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
    stop: useStableCallback(() => sessionRef.current?.controller.stop() ?? Promise.resolve()),
    cancel: useStableCallback(() => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      sessionRef.current?.controller.cancel();
    }),
    skipPostProcessing: useStableCallback(() =>
      sessionRef.current?.controller.skipPostProcessing(),
    ),
  };
}
