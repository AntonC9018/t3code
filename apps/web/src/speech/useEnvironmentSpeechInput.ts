import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  getSpeechModelDownloadOutcome,
  postProcessEnvironmentTranscript,
  resolveLiveTranscriptCancel,
  resolveLiveTranscriptUpdate,
  resolveTranscriptCommit,
  selectEnvironmentSpeechModel,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  VoiceTranscriptionError,
  type VoiceDraftSnapshot,
  type VoiceInputErrorCode,
  type VoiceInputState,
  type VoiceLiveTranscript,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope, CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import type {
  ClientSettings,
  CloudSpeechModelId,
  CloudSpeechProvider,
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  ProjectId,
  SpeechBenchmarkTier,
  SpeechCustomWords,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { chooseSetupSpeechModel, resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { msg, useGT } from "gt-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLatestRef } from "~/hooks/useLatestRef";
import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { m } from "../i18n/messages";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { preferredSpeechLanguages } from "./preferredSpeechLanguages";
import {
  notifyVoiceRecordingRecoveryChange,
  subscribeVoiceRecordingRecovery,
} from "./recordingRecoveryEvents";
import { isVoiceRecordingLocked, recordingStorage } from "./recordingStorage";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { bindAudioGrant, readCleanupGrant, useAudioChoice } from "./voiceConsent";
import {
  IDLE_VOICE_STATE,
  presentVoiceOwner,
  useRetainedVoiceInputSession,
  useVoiceInputSessionActivity,
  useVoiceInputSessionSnapshot,
  type VoiceInputTarget,
} from "./voiceInputSession";

const WAITING_STATE: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  language: null as string | null,
  downloading: false,
  catalogFailed: false,
  error: null as string | null,
  consent: false,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared));
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
  readonly draftText?: string | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * Until a destination is chosen, voice input is offered and its first gesture opens Voice
   * settings. False hides it instead, for editors whose draft would not survive the navigation.
   */
  readonly offerSetup?: boolean | undefined;
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
  /** Names the draft in the indicator shown while a recording's editor is off screen. */
  readonly label?: string | null | undefined;
  /** False while the editor stays mounted out of sight, so the indicator still shows. */
  readonly presented?: boolean | undefined;
  /**
   * A draft that is stored outside its editor keeps recording when the editor shows another
   * owner or unmounts; the transcript lands in the stored draft instead.
   */
  readonly persistentDraft?:
    | {
        readonly readStoredText: () => string | null;
        readonly commitStoredText: (text: string) => void;
        readonly open: () => void;
      }
    | undefined;
};

type SpeechSessionContext = {
  ownerKey: string;
  closedQuestionRecovery: boolean;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
  projectWords: SpeechCustomWords;
  originatingEnvironment: ReturnType<typeof useEnvironment>;
  cleanup: boolean;
  retainedDraft: HookInput["retainedDraft"];
  clientSettings: ClientSettings;
  cleanupPrepared: PreparedConnection | null;
};

/**
 * Audio goes only to the destination chosen on this device, never a fallback; changing that
 * choice or losing the connection abandons the recording unless it is retained for retry.
 * Until a choice is made, voice input offers to open Voice settings instead of sending audio.
 */
export function useVoiceTranscriptionDestination() {
  const gt = useGT();
  const hydrated = useClientSettingsHydrated();
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const environmentId = hydrated && grant ? grant.destination.environmentId : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cloud = grant?.destination.kind === "cloud" ? grant.destination : undefined;
  const provider = cloud?.provider;
  const model = cloud?.provider === "openrouter" ? cloud.model : undefined;
  const supported =
    environment?.serverConfig?.environment.capabilities[
      provider ? "cloudVoiceTranscription" : "voiceTranscription"
    ] === true;
  return {
    ...(hydrated && choice === null ? { offerFirstRunSetup: true } : {}),
    environmentId,
    ...(provider ? { cloudProvider: provider } : {}),
    ...(model ? { cloudModel: model } : {}),
    grantId: grant?.id ?? null,
    label:
      provider && environment
        ? gt("{provider} via {environment}", {
            provider: CLOUD_SPEECH_LABELS[provider],
            environment: environment.label,
          })
        : (environment?.label ?? null),
    prepared: supported && canDictate ? connection : null,
  };
}

type DraftRevision = { ownerKey: string; text: string; revision: number };

type RetainedSpeechSession = {
  readonly connection: { current: PreparedConnection };
  readonly grantId: string;
  readonly cloudProvider: CloudSpeechProvider | undefined;
  readonly cloudModel: CloudSpeechModelId | undefined;
  context: SpeechSessionContext;
  recoveryAccepted: boolean;
  consentWithdrawn: boolean;
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
  recordingStartedAt: number | null;
  level: number;
  preview: SpeechStreamText | null;
  liveTranscript: VoiceLiveTranscript | null;
};

const retainedSessions = new Map<string, RetainedSpeechSession>();

function releaseUnusedSession(session: RetainedSpeechSession) {
  if (!session.attachment && !session.recovering && session.state.phase === "idle") {
    if (retainedSessions.get(session.context.ownerKey) === session)
      retainedSessions.delete(session.context.ownerKey);
  }
}

function withdrawSessionConsent(session: RetainedSpeechSession) {
  session.consentWithdrawn = true;
  if (retainedSessions.get(session.context.ownerKey) === session)
    retainedSessions.delete(session.context.ownerKey);
  session.controller.dispose();
}

function notifySavedDictationDiscarded() {
  toastManager.add({
    type: "warning",
    title: m(msg("Saved dictation discarded")),
    description: m(msg("Voice transcription settings changed after it was recorded.")),
  });
}

function readSessionDraft(session: RetainedSpeechSession): VoiceDraftSnapshot | null {
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
  cloudProvider: CloudSpeechProvider | undefined,
  cloudModel: CloudSpeechModelId | undefined,
): RetainedSpeechSession {
  const hasAudioConsent = bindAudioGrant(grantId);
  const connection = { current: prepared };
  let session: RetainedSpeechSession;
  let controller: VoiceInputController;
  let recordingPreferences:
    | {
        readonly cleanup: SpeechPostProcessingOptions | null;
        readonly cleanupGrant: string | null;
        readonly environmentId: EnvironmentId;
      }
    | undefined;
  const platform = createBrowserVoiceInputPlatform({
    get prepared() {
      return connection.current;
    },
    cloudProvider,
    cloudModel,
    hasAudioConsent,
    getStreamingEnabled: () => session.context.clientSettings.speechStreaming,
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
            grantId,
            read: () => readSessionDraft(session)!,
          },
        }
      : {}),
    getTranscriptionOptions: (): SpeechTranscriptionOptions => {
      const {
        clientSettings,
        originatingEnvironment,
        projectId,
        projectName,
        environmentId,
        cleanup,
      } = session.context;
      if (projectId && !originatingEnvironment?.serverConfig) {
        throw new VoiceTranscriptionError({
          code: "preparation-failed",
          message: m(msg("Reconnect the project environment to load its dictionary.")),
        });
      }
      const projectWords =
        projectId && originatingEnvironment?.serverConfig
          ? resolveProjectSettings(originatingEnvironment.serverConfig.settings, projectId).settings
              .speechProjectCustomWords
          : session.context.projectWords;
      const cleanupGrant = cleanup ? readCleanupGrant() : null;
      const cleanupEnabled = cleanupGrant !== null;
      const cue =
        cleanupEnabled && session.context.cleanupPrepared
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
    getMicrophoneId: chooseRecordingMicrophone,
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
        title: m(msg("Transcript backup unavailable")),
        description: message,
      });
    },
    onError: (message, code?: VoiceInputErrorCode) => {
      if (session.context.retainedDraft) {
        toastManager.add({
          type: "warning",
          title: m(msg("Voice recording stopped")),
          description: message,
        });
        // Finalize captured audio on device/storage failure rather than discarding it.
        if (controller.currentState.phase === "recording") void controller.stop();
      } else if (session.attachment) void controller.interruptRecording(message, null, code);
    },
  });
  controller = new VoiceInputController({
    resolve: m,
    retryFailedRecording: true,
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
      const target = current.cleanupPrepared;
      if (!target)
        return Promise.reject(
          new Error(m(msg("The draft's environment is unavailable for transcript cleanup."))),
        );
      return runEnvironmentSpeech(
        postProcessEnvironmentTranscript(
          target,
          transcript,
          cleanupContext(options.draft),
          cleanup,
          () => hasAudioConsent() && cleanupGrant === readCleanupGrant(),
        ),
        options,
      ).then((result) => result.text);
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
        title: m(msg("Transcript cleanup failed")),
        description: m(msg("The original transcript was added.")),
      }),
    readDraft: () => readSessionDraft(session),
    onStreamingTranscript: (text, _captured, locale) => {
      if (session.context.retainedDraft) return null;
      const current = readSessionDraft(session);
      if (!current) return null;
      const update = resolveLiveTranscriptUpdate(current, session.liveTranscript, text, locale);
      if (!update) return null;
      session.liveTranscript = update.live;
      Object.assign(session.revision, {
        ownerKey: update.draft.ownerKey,
        text: update.draft.text,
        revision: update.draft.revision ?? session.revision.revision + 1,
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
        revision: draft.revision ?? session.revision.revision + 1,
      });
      session.attachment?.commitDraft(draft.text, draft.selection);
    },
    commitDraft: (text, selection) => {
      if (session.context.closedQuestionRecovery && !session.recoveryAccepted)
        throw new Error(m(msg("Choose Recover to draft to insert this saved question recording.")));
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
      session.recordingStartedAt =
        value.phase !== "recording" ? null : (session.recordingStartedAt ?? Date.now());
      if (value.phase === "idle") session.liveTranscript = null;
      if (value.phase !== "recording" && value.phase !== "transcribing") session.preview = null;
      session.attachment?.notify();
      releaseUnusedSession(session);
      if (session.context.retainedDraft && (value.phase === "idle" || value.phase === "error"))
        notifyVoiceRecordingRecoveryChange();
    },
  });
  session = {
    connection,
    grantId,
    cloudProvider,
    cloudModel,
    context,
    recoveryAccepted: false,
    consentWithdrawn: false,
    revision,
    attachment: null,
    controller,
    state: IDLE_VOICE_STATE,
    recordingStartedAt: null,
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
          // Delivered text needs no audio; anything else only goes to the grant it was recorded under.
          if (saved.grantId !== session.grantId || session.consentWithdrawn) {
            await platform.discardSavedRecording();
            notifySavedDictationDiscarded();
            return;
          }
          // A peer's recording can become recoverable after a failed microphone start.
          if (controller.currentState.phase === "error" && !controller.currentState.hasRecording)
            controller.cancel();
          const { uri, transcription } = await platform.restoreRecording(saved);
          if (session.consentWithdrawn) {
            platform.deleteRecording(uri);
            notifySavedDictationDiscarded();
            return;
          }
          // Browser reloads reset the in-memory revision counter.
          session.revision.text = saved.draft.text;
          session.revision.revision = saved.draft.revision ?? 0;
          controller.restoreRecording(uri, saved.draft, transcription);
        })
        .catch(async (error: unknown) => {
          if (session.consentWithdrawn) {
            await platform.discardSavedRecording().catch(() => undefined);
            notifySavedDictationDiscarded();
            return;
          }
          toastManager.add({
            type: "error",
            title: m(msg("Could not restore saved dictation")),
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
  const navigate = useNavigate();
  const [closedQuestionSelection, setClosedQuestionSelection] = useState<{
    chatOwnerKey: string;
    recordingOwnerKey: string | null;
  } | null>(null);
  const closedQuestionOwner =
    input.closedQuestionRecordings && closedQuestionSelection?.chatOwnerKey === input.ownerKey
      ? closedQuestionSelection.recordingOwnerKey
      : null;
  const useRetained = Boolean(input.retainedDraft);
  const retainedKey = useRetained ? (closedQuestionOwner ?? input.ownerKey) : null;
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
  const cloudProvider = destination.cloudProvider;
  const cloudModel = destination.cloudModel;
  const originatingEnvironment = useEnvironment(input.environmentId);
  const draftCapabilities = originatingEnvironment?.serverConfig?.environment.capabilities;
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const cleanupPrepared =
    canCleanUp &&
    (draftCapabilities?.voiceTranscription || draftCapabilities?.cloudVoiceTranscription)
      ? originatingConnection
      : null;
  const clientSettings = useClientSettings();
  const projectId = input.projectId ?? null;
  const projectWords = useEnvironmentSettings(
    input.environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.speechProjectCustomWords,
  );

  const sessionContext: SpeechSessionContext = {
    ownerKey: retainedKey ?? input.ownerKey,
    closedQuestionRecovery: closedQuestionOwner !== null,
    environmentId: input.environmentId,
    projectId,
    projectName: input.projectName ?? null,
    projectWords,
    originatingEnvironment,
    cleanup: input.cleanup !== false,
    retainedDraft: input.retainedDraft,
    clientSettings,
    cleanupPrepared,
  };

  const [status, setStatus] = useState<{
    readonly prepared: PreparedConnection;
    readonly value: EnvironmentSpeechStatus | null;
  } | null>(null);
  const [queuedStart, setQueuedStart] = useState<PreparedConnection | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [previousDestination, setPreviousDestination] = useState({ prepared, grantId });
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  const [retainedControllerState, setRetainedControllerState] = useState<{
    prepared: PreparedConnection | null;
    grantId: string | null;
    ownerKey: string | null;
    value: VoiceInputState;
    recordingStartedAt: number | null;
  }>({
    prepared,
    grantId,
    ownerKey: retainedKey,
    value: IDLE_VOICE_STATE,
    recordingStartedAt: null,
  });
  const [retainedLevel, setRetainedLevel] = useState(0);
  const [retainedPreview, setRetainedPreview] = useState<SpeechStreamText | null>(null);

  if (previousDestination.prepared !== prepared || previousDestination.grantId !== grantId) {
    setPreviousDestination({ prepared, grantId });
    setSetup(INITIAL_SETUP);
    setQueuedStart(null);
  }
  if (
    useRetained &&
    (retainedControllerState.prepared !== prepared ||
      retainedControllerState.grantId !== grantId ||
      retainedControllerState.ownerKey !== retainedKey)
  ) {
    setRetainedControllerState({
      prepared,
      grantId,
      ownerKey: retainedKey,
      value: IDLE_VOICE_STATE,
      recordingStartedAt: null,
    });
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setQueuedStart(null);
    setSetup(INITIAL_SETUP);
  }

  const sharedSession = useRetainedVoiceInputSession(
    useRetained
      ? { prepared: null, grantId: null, cloudProvider: undefined, cloudModel: undefined }
      : { prepared, grantId, cloudProvider, cloudModel },
  );
  const snapshot = useVoiceInputSessionSnapshot(sharedSession);
  const owns = !useRetained && snapshot.target?.ownerKey === input.ownerKey;
  const activity = useVoiceInputSessionActivity(sharedSession, input.ownerKey);
  const retainedState: VoiceInputState =
    queuedStart === prepared && prepared
      ? WAITING_STATE
      : retainedControllerState.prepared === prepared &&
          retainedControllerState.grantId === grantId &&
          retainedControllerState.ownerKey === retainedKey
        ? retainedControllerState.value
        : IDLE_VOICE_STATE;
  const sharedState: VoiceInputState =
    queuedStart === prepared && prepared ? WAITING_STATE : owns ? snapshot.state : IDLE_VOICE_STATE;
  const state: VoiceInputState = useRetained ? retainedState : sharedState;
  // One microphone: another draft's recording leaves this editor without voice input until it ends.
  const busyElsewhere = !useRetained && !owns && voiceInputBlocksSubmission(snapshot.state);

  const retainedSessionRef = useRef<RetainedSpeechSession | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestInputRef = useLatestRef(input);
  const latestSessionContextRef = useRef(sessionContext);
  const draftRevisionRef = useRef({
    ownerKey: input.ownerKey,
    text: input.draftText ?? "",
    revision: 0,
  });
  const latestRef = useRef({
    input,
    clientSettings,
    cleanupPrepared,
    projectWords,
    session: sharedSession,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props before an async completion can read them through the session
  useLayoutEffect(() => {
    latestRef.current = {
      input,
      clientSettings,
      cleanupPrepared,
      projectWords,
      session: sharedSession,
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks committed draft revisions so a late transcript cannot overwrite an edited draft
  useEffect(() => {
    const draftText = input.draftText ?? "";
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input.ownerKey, input.draftText]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps a retained session's mutable context and editor callbacks in step with React inputs.
  useEffect(() => {
    latestSessionContextRef.current = sessionContext;
    const retained = retainedSessionRef.current;
    if (
      !retained ||
      (retained.context.retainedDraft ? retained.context.ownerKey : null) !== retainedKey
    )
      return;
    retained.context = sessionContext;
    if (retained.attachment) {
      retained.attachment.disabled = input.disabled;
      retained.attachment.readDraft = input.readDraft;
      retained.attachment.commitDraft = input.commitDraft;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attaches a retained controller bound to the consented destination so unsent audio survives reloads and reconnects.
  useEffect(() => {
    if (!useRetained || !retainedKey || typeof navigator === "undefined") return;
    let existing = retainedSessions.get(retainedKey);
    if (existing && existing.grantId !== grantId) {
      withdrawSessionConsent(existing);
      existing = undefined;
    }
    // Consent is unchanged across a reconnect, so unsent audio stays and retries on the new link.
    if (existing && prepared) existing.connection.current = prepared;
    if (!existing && (!prepared || !grantId)) return;
    const currentInput = latestInputRef.current;
    const retained =
      existing ??
      createSpeechSession(
        latestSessionContextRef.current,
        { ownerKey: currentInput.ownerKey, text: currentInput.draftText ?? "", revision: 0 },
        prepared!,
        grantId!,
        cloudProvider,
        cloudModel,
      );
    retained.context = latestSessionContextRef.current;
    const attachment = {
      disabled: currentInput.disabled,
      readDraft: currentInput.readDraft,
      commitDraft: currentInput.commitDraft,
      onCommit: (text: string) => {
        if (pendingSubmissionRef.current?.ownerKey === retained.context.ownerKey)
          pendingSubmissionRef.current.text = text;
      },
      notify: () => {
        if (retained.state.phase === "error") pendingSubmissionRef.current = null;
        setRetainedControllerState({
          prepared,
          grantId,
          ownerKey: retainedKey,
          value: retained.recovering ? WAITING_STATE : retained.state,
          recordingStartedAt: retained.recordingStartedAt,
        });
        setRetainedLevel(retained.level);
        setRetainedPreview(retained.preview);
        if (retained.state.phase === "idle") {
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
    retained.attachment = attachment;
    retainedSessionRef.current = retained;
    if (!existing) retainedSessions.set(retainedKey, retained);
    attachment.notify();
    if (!existing) void retained.recover();
    return () => {
      if (retained.attachment === attachment) retained.attachment = null;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      if (retainedSessionRef.current === retained) retainedSessionRef.current = null;
      releaseUnusedSession(retained);
    };
  }, [cloudModel, cloudProvider, grantId, latestInputRef, prepared, retainedKey, useRetained]);

  const mountedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons this editor's pending work, and a recording that cannot outlive it, on unmount or a destination change
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      sharedSession?.ownerChanged(latestRef.current.input.ownerKey);
    };
  }, [sharedSession]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the global indicator this draft is on screen
  useEffect(
    () =>
      useRetained || input.presented === false ? undefined : presentVoiceOwner(input.ownerKey),
    [input.ownerKey, input.presented, useRetained],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared || cloudProvider) return;
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
  }, [prepared, cloudProvider]);
  const currentStatus = !cloudProvider && status?.prepared === prepared ? status.value : null;
  const setupModelId = setup.model?.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !setupModelId) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runEnvironmentSpeech(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === setupModelId) ?? null;
          if (model)
            setSetup((current) => ({
              ...current,
              model: { ...model, recommended: current.model?.recommended ?? false },
            }));
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
  }, [prepared, setup.downloading, setup.open, setupModelId]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons any queued submission, and a recording that cannot outlive its editor, when the draft's owner changes or becomes disabled
  useEffect(() => {
    const previous = previousOwnerRef.current;
    if (previous === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    if (!useRetained) {
      if (previous !== input.ownerKey) sharedSession?.ownerChanged(previous);
      else if (sharedSession?.ownerKey === input.ownerKey) sharedSession.cancel();
    }
  }, [input.ownerKey, input.disabled, sharedSession, useRetained]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a queued submission only after the transcript has committed to the draft
  useEffect(() => {
    if (useRetained) return;
    const pending = pendingSubmissionRef.current;
    if (state.phase === "error") pendingSubmissionRef.current = null;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled, useRetained]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing") return;
    if (useRetained) {
      const controller = retainedSessionRef.current?.controller;
      if (!controller || !voiceInputBlocksSubmission(state)) {
        const draft = latestRef.current.input.readDraft();
        if (draft) submit(draft.text);
        return;
      }
      if (pendingSubmissionRef.current) return;
      pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
      if (controller.currentState.phase === "recording") void controller.stop();
      return;
    }
    if (!sharedSession || !voiceInputBlocksSubmission(state)) {
      const draft = latestRef.current.input.readDraft();
      if (draft) submit(draft.text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
    if (sharedSession.state.phase === "recording") void sharedSession.stop();
  });

  const createTarget = useStableCallback((): VoiceInputTarget => {
    const owner = latestRef.current.input.ownerKey;
    const readContext = () => {
      const current = latestRef.current;
      return {
        environmentId: current.input.environmentId,
        projectName: current.input.projectName ?? null,
        projectWords: current.projectWords,
        clientSettings: current.clientSettings,
        cleanup: current.input.cleanup !== false,
        cleanupPrepared: current.cleanupPrepared,
      };
    };
    // Once this editor shows another draft, its environment and cleanup must not see this one.
    const startContext = readContext();
    const persistent = latestRef.current.input.persistentDraft ?? null;
    // While this editor shows the owner, the live editor is the draft; otherwise the stored one.
    const live = () => mountedRef.current && latestRef.current.input.ownerKey === owner;
    return {
      ownerKey: owner,
      label: latestRef.current.input.label ?? null,
      persistent: persistent !== null,
      open: persistent?.open ?? null,
      readDraft: () => {
        if (live()) return latestRef.current.input.readDraft();
        const text = persistent?.readStoredText();
        return text == null ? null : { text, selection: { start: text.length, end: text.length } };
      },
      commitDraft: (text, selection) => {
        if (!live()) {
          persistent?.commitStoredText(text);
          return;
        }
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
        if (pendingSubmissionRef.current?.ownerKey === owner)
          pendingSubmissionRef.current.text = text;
      },
      readContext: () => (live() ? readContext() : startContext),
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a remounted editor takes over its draft's running recording so a queued Send still sees the transcript
  useEffect(() => {
    if (
      !useRetained &&
      sharedSession?.ownerKey === input.ownerKey &&
      voiceInputBlocksSubmission(sharedSession.state)
    )
      sharedSession.adopt(createTarget());
  }, [sharedSession, input.ownerKey, createTarget, useRetained]);

  const loadSetupCatalog = useStableCallback(
    async (
      connection: PreparedConnection,
      selectedModelId: string,
      benchmarkTier: SpeechBenchmarkTier,
      request: number,
    ) => {
      setSetup({ ...INITIAL_SETUP, open: true });
      const catalog = await runEnvironmentSpeech(
        getEnvironmentSpeechModels(connection, true),
      ).catch(() => null);
      if (request !== startRequestRef.current) return;
      const choice = chooseSetupSpeechModel(catalog?.models ?? [], {
        selectedModelId,
        intent: latestRef.current.clientSettings.speechLanguage,
        preferred: preferredSpeechLanguages(),
        benchmarkTier,
      });
      setSetup((current) => ({
        ...current,
        model: choice ? { ...choice.model, recommended: choice.recommended } : null,
        language: choice?.language ?? null,
        catalogFailed: catalog === null,
        error: choice
          ? null
          : catalog
            ? m(
                msg(
                  "No model matches your language. Choose a model or change the language in Voice settings.",
                ),
              )
            : m(msg("Could not load transcription models. Check the connection and try again.")),
      }));
    },
  );

  const start = useStableCallback(async () => {
    if (latestRef.current.input.disabled || (setup.open && setup.downloading)) return;
    if (!grantId) {
      if (destination.offerFirstRunSetup && latestRef.current.input.offerSetup !== false)
        await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
      return;
    }
    const request = ++startRequestRef.current;
    const owner = latestRef.current.input.ownerKey;
    if (useRetained) {
      const expectedController = retainedSessionRef.current?.controller;
      if (!expectedController || !prepared) return;
      const stillCurrent = () =>
        request === startRequestRef.current &&
        retainedSessionRef.current?.controller === expectedController &&
        latestRef.current.input.ownerKey === owner &&
        !latestRef.current.input.disabled;
      const retained = retainedKey ? retainedSessions.get(retainedKey) : null;
      if (retained) {
        await retained.ready;
        if (
          stillCurrent() &&
          !expectedController.currentState.hasRecording &&
          (expectedController.currentState.phase === "idle" ||
            expectedController.currentState.phase === "error")
        )
          await retained.recover();
      }
      if (!stillCurrent()) return;
      if (expectedController.currentState.hasRecording) {
        if (retained?.context.closedQuestionRecovery && !retained.recoveryAccepted) {
          retained.recoveryAccepted = true;
          await expectedController.retryIntoCurrentDraft();
        } else await expectedController.start();
        return;
      }
      if (cloudProvider) {
        setRetainedLevel(0);
        await expectedController.start();
        return;
      }
      setSetup(INITIAL_SETUP);
      setQueuedStart(prepared);
      let latestStatus: EnvironmentSpeechStatus;
      try {
        latestStatus = await probeSpeechStatus(prepared, true);
        if (!stillCurrent()) return;
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
          title: m(msg("Could not start voice input")),
          description: error instanceof Error ? error.message : String(error),
        });
        setQueuedStart(null);
        return;
      }
      if (!stillCurrent()) return;
      setStatus({ prepared, value: latestStatus });
      setQueuedStart(null);
      if (latestStatus.supported && latestStatus.state === "missing-model") {
        return loadSetupCatalog(
          prepared,
          latestStatus.modelId,
          latestStatus.benchmarkTier,
          request,
        );
      }
      if (!latestStatus.supported) {
        toastManager.add({
          type: "error",
          title: m(msg("Voice input is not available")),
          description: latestStatus.reason,
        });
        return;
      }
      setRetainedLevel(0);
      await expectedController.start();
      return;
    }

    if (!sharedSession || !prepared || busyElsewhere) return;
    if (cloudProvider) {
      await sharedSession.start(createTarget());
      return;
    }
    const stillCurrent = () =>
      request === startRequestRef.current &&
      latestRef.current.session === sharedSession &&
      latestRef.current.input.ownerKey === owner &&
      !latestRef.current.input.disabled;
    setSetup(INITIAL_SETUP);
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
        title: m(msg("Could not start voice input")),
        description: error instanceof Error ? error.message : String(error),
      });
      setQueuedStart(null);
      return;
    }
    if (!stillCurrent()) return;
    setStatus({ prepared, value: latestStatus });
    setQueuedStart(null);
    if (latestStatus.supported && latestStatus.state === "missing-model") {
      return loadSetupCatalog(prepared, latestStatus.modelId, latestStatus.benchmarkTier, request);
    }
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: m(msg("Voice input is not available")),
        description: latestStatus.reason,
      });
      return;
    }
    await sharedSession.start(createTarget());
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || !setupModelId || setup.downloading) return;
    const modelId = setupModelId;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      const downloaded = await runEnvironmentSpeech(
        downloadEnvironmentSpeechModel(prepared, modelId),
      );
      if (request !== startRequestRef.current) return;
      const outcome = getSpeechModelDownloadOutcome(downloaded, modelId);
      if (outcome === "needs-selection") {
        try {
          await runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, modelId));
        } catch {
          if (request !== startRequestRef.current) return;
          setSetup((current) => ({
            ...current,
            downloading: false,
            error: m(
              msg("The model downloaded, but this environment could not select it. Try again."),
            ),
          }));
          return;
        }
      }
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      const ready =
        outcome !== "incomplete" &&
        next.supported &&
        next.modelId === modelId &&
        next.state !== "missing-model";
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: ready ? 1 : current.step,
        error: ready ? null : m(msg("The model is not ready. Try downloading it again.")),
      }));
    } catch {
      if (request !== startRequestRef.current) return;
      setSetup((current) => ({
        ...current,
        downloading: false,
        error: m(
          msg("Could not download the model. Check this environment's connection and try again."),
        ),
      }));
    }
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !setupModelId) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, setupModelId));
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  const destinationReady =
    grantId === null
      ? Boolean(destination.offerFirstRunSetup) && input.offerSetup !== false
      : prepared !== null &&
        (cloudProvider !== undefined ||
          (status?.prepared === prepared && status.value?.supported !== false));

  return {
    available:
      (destinationReady || (retainedKey !== null && state.phase !== "idle")) &&
      !busyElsewhere &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    canStart: prepared !== null,
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      retryCatalog:
        setup.open && setup.catalogFailed && prepared && currentStatus?.supported
          ? () =>
              loadSetupCatalog(
                prepared,
                currentStatus.modelId,
                currentStatus.benchmarkTier,
                ++startRequestRef.current,
              )
          : null,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      allowAudio: () => {
        setSetup(INITIAL_SETUP);
      },
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        await start();
      },
    },
    state,
    recoveringClosedQuestion: closedQuestionOwner !== null,
    progress: null,
    preview:
      state.phase === "recording" || state.phase === "transcribing"
        ? useRetained
          ? retainedPreview
          : activity.preview
        : null,
    level: useRetained ? retainedLevel : activity.level,
    recordingStartedAt: useRetained
      ? retainedControllerState.recordingStartedAt
      : owns
        ? snapshot.recordingStartedAt
        : null,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    submitAfterDictation,
    stop: useStableCallback(() =>
      useRetained
        ? (retainedSessionRef.current?.controller.stop() ?? Promise.resolve())
        : owns && sharedSession
          ? sharedSession.stop()
          : Promise.resolve(),
    ),
    cancel: useStableCallback(() => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      setSetup(INITIAL_SETUP);
      if (useRetained) retainedSessionRef.current?.controller.cancel();
      else if (owns) sharedSession?.cancel();
    }),
    skipPostProcessing: useStableCallback(() => {
      if (useRetained) retainedSessionRef.current?.controller.skipPostProcessing();
      else if (owns) sharedSession?.skipPostProcessing();
    }),
  };
}
