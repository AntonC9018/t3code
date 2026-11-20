import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  requireCloudSpeechKey,
  transcribeCloudPcm,
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  type VoiceInputErrorCode,
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceTranscriptionOptions,
  type VoiceDraftSnapshot,
  type PreparedVoiceTranscription,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  EnvironmentSpeechStatus,
  SpeechPostProcessingOptions,
  SpeechTranscriptionOptions,
  SpeechStreamText,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { randomUUID } from "../lib/utils";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import {
  acquireVoiceRecordingLock,
  recordingStorage,
  type SavedVoiceRecording,
} from "./recordingStorage";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  /** The exact OpenRouter model the grant names; required with that provider. */
  readonly cloudModel?: CloudSpeechModelId | undefined;
  readonly hasAudioConsent: () => boolean;
  readonly retainedDraft?: {
    readonly ownerKey: string;
    readonly grantId: string;
    readonly read: () => VoiceDraftSnapshot;
  };
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getPostProcessingOptions?: () => SpeechPostProcessingOptions | undefined;
  readonly getStreamingEnabled?: () => boolean;
  readonly getMicrophoneId: () => string | Promise<string>;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit?: () => void;
  readonly onText: (text: SpeechStreamText, locale?: string) => void;
  readonly onError: (message: string, code?: VoiceInputErrorCode) => void;
  readonly onStorageWarning?: (message: string) => void;
  readonly onRecordingRemoved?: (recordingId: string) => void;
}) {
  let recordingOptions: SpeechTranscriptionOptions;
  let locale = "auto";
  let savedRecording: SavedVoiceRecording | null = null;
  let restoredUri: string | null = null;
  let sequence = 0;
  let saving = Promise.resolve();
  let storageError: unknown;
  let transcriptStorageWarningShown = false;
  let signal: AbortSignal | undefined;
  let unlockRecording: (() => Promise<void>) | null = null;
  const claimRecording = async () => {
    if (!input.retainedDraft || unlockRecording) return;
    unlockRecording = await acquireVoiceRecordingLock(input.retainedDraft.ownerKey);
    if (!unlockRecording)
      throw new Error(m(msg("This chat has an unfinished recording in another tab.")));
  };
  const releaseRecordingLock = async () => {
    const release = unlockRecording;
    unlockRecording = null;
    await release?.();
  };
  const discardSavedRecording = async () => {
    const recording = savedRecording;
    savedRecording = null;
    const removal = saving.then(async () => {
      try {
        if (recording) {
          await recordingStorage.remove(recording.id);
          input.onRecordingRemoved?.(recording.id);
        }
      } finally {
        await releaseRecordingLock();
      }
    });
    saving = removal.catch(() => undefined);
    await removal;
  };
  const saveChunk = (pcm: Float32Array<ArrayBuffer>) => {
    if (!savedRecording) return;
    const id = savedRecording.id;
    const index = sequence++;
    saving = saving
      .then(() => recordingStorage.append(id, index, pcm))
      .catch((error: unknown) => {
        if (!storageError)
          input.onError(
            m(
              msg(
                "Could not save microphone audio. The recording is kept in this tab; retry before closing it.",
              ),
            ),
          );
        storageError = error;
      });
  };
  const saveTranscript = async (
    text: string,
    transcriptIsFinal = false,
    draft = savedRecording?.draft,
  ) => {
    if (!text.trim()) return text;
    if (savedRecording) {
      const recording = {
        ...savedRecording,
        transcript: text,
        transcriptIsFinal,
        ...(draft ? { draft } : {}),
      };
      savedRecording = recording;
      try {
        await saving;
        await recordingStorage.saveTranscript(recording.id, text, transcriptIsFinal, draft);
        transcriptStorageWarningShown = false;
      } catch {
        if (!transcriptStorageWarningShown) {
          transcriptStorageWarningShown = true;
          input.onStorageWarning?.(
            m(msg("Could not save the transcript backup. Your dictation is kept in this tab.")),
          );
        }
      }
    }
    return text;
  };

  const resolveLocale = (
    status: Extract<EnvironmentSpeechStatus, { supported: true }>,
    nativeStreaming: boolean,
  ) => {
    const language = status.languages
      ? effectiveSpeechLanguage(
          {
            languages: status.languages,
            supportsLanguageDetection: status.supportsLanguageDetection ?? false,
          },
          recordingOptions.speechLanguage,
        )
      : "auto";
    return !nativeStreaming &&
      status.supportsTranslation &&
      recordingOptions.speechTranslateToEnglish
      ? "en"
      : language;
  };

  const transcribeRecording = async (
    uri: string,
    { signal: transcriptionSignal }: VoiceTranscriptionOptions,
  ) => {
    try {
      if (savedRecording?.transcript?.trim()) return savedRecording.transcript;
      const response = await fetch(uri, { signal: transcriptionSignal });
      const pcm = new Uint8Array(await response.arrayBuffer());
      const result = await runEnvironmentSpeech(
        input.cloudProvider
          ? transcribeCloudPcm(
              input.prepared,
              input.cloudProvider,
              pcm,
              recordingOptions,
              input.hasAudioConsent,
              input.cloudModel,
            )
          : transcribeEnvironmentPcm(input.prepared, pcm, recordingOptions, input.hasAudioConsent),
        { signal: transcriptionSignal },
      );
      throwIfVoiceTranscriptionAborted(transcriptionSignal);
      return await saveTranscript(result.text);
    } catch (cause) {
      throwIfVoiceTranscriptionAborted(transcriptionSignal);
      if (isVoiceTranscriptionError(cause)) throw cause;
      throw new VoiceTranscriptionError({
        code: "transcription-failed",
        message: m(msg("Voice transcription failed. Check the destination in Settings → Voice.")),
        cause,
      });
    }
  };

  const capture = createBrowserPcmCapture(
    {
      getMicrophoneId: input.getMicrophoneId,
      onLevel: input.onLevel,
      ...(input.onDurationLimit ? { onDurationLimit: input.onDurationLimit } : {}),
      onError: input.onError,
      retainAudio: true,
      onChunk: saveChunk,
      onStopped: () => saving,
    },
    async (options) => {
      signal = options.signal;
      recordingOptions = input.getTranscriptionOptions();
      const streamingEnabled = input.getStreamingEnabled?.() ?? true;
      if (input.cloudProvider) {
        if (input.cloudProvider === "openrouter" && !input.cloudModel)
          throw new VoiceTranscriptionError({
            code: "unavailable",
            message: m(msg("Choose an OpenRouter model in Settings → Voice.")),
          });
        await runEnvironmentSpeech(
          requireCloudSpeechKey(input.prepared, input.cloudProvider),
          options,
        );
        throwIfVoiceTranscriptionAborted(options.signal);
        locale = effectiveSpeechLanguage(cloudSpeechLanguages, recordingOptions.speechLanguage);
        return {
          locale,
          transcribe: transcribeRecording,
        };
      }
      const status = await runEnvironmentSpeech(
        getEnvironmentSpeechStatus(input.prepared),
        options,
      );
      throwIfVoiceTranscriptionAborted(options.signal);
      if (!status.supported)
        throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
      const nativeStreaming = Boolean(status.supportsStreaming) && streamingEnabled;
      locale = resolveLocale(status, nativeStreaming);
      if (status.supportsStreaming ? !nativeStreaming : !status.supportsBufferedStreaming) {
        return { locale, transcribe: transcribeRecording };
      }
      const url = await runEnvironmentSpeech(
        getEnvironmentSpeechStreamUrl(input.prepared),
        options,
      );
      const stream = openSpeechStream({
        url,
        canSend: input.hasAudioConsent,
        options: recordingOptions,
        signal: options.signal,
        onText: (text) => input.onText(text, locale),
        onError: (error) => input.onError(error.message),
      });
      return {
        locale,
        transcribe: transcribeRecording,
        streaming: {
          feed: stream.feed,
          finish: async () => saveTranscript(await stream.finish()),
        },
      };
    },
  );

  const recorder: VoiceRecorder = {
    get uri() {
      return capture.recorder.uri;
    },
    prepareToRecordAsync: async (captureSignal) => {
      sequence = 0;
      storageError = undefined;
      transcriptStorageWarningShown = false;
      if (input.retainedDraft) {
        await saving;
        await claimRecording();
        const postProcessingOptions = input.getPostProcessingOptions?.();
        const recording: SavedVoiceRecording = {
          id: randomUUID(),
          ownerKey: input.retainedDraft.ownerKey,
          grantId: input.retainedDraft.grantId,
          draft: input.retainedDraft.read(),
          options: recordingOptions,
          locale,
          ...(postProcessingOptions ? { postProcessingOptions } : {}),
        };
        try {
          await recordingStorage.create(recording);
        } catch (error) {
          await releaseRecordingLock();
          throw error;
        }
        savedRecording = recording;
        // Ask the browser to protect unfinished dictation from storage eviction.
        void navigator.storage?.persist?.().catch(() => undefined);
      }
      try {
        await capture.recorder.prepareToRecordAsync(captureSignal);
      } catch (error) {
        if (savedRecording) await discardSavedRecording();
        throw error;
      }
    },
    record: capture.recorder.record,
    stop: capture.recorder.stop,
  };

  return {
    get recordingId() {
      return savedRecording?.id ?? null;
    },
    get postProcessingOptions() {
      return savedRecording?.postProcessingOptions;
    },
    findRecording: async () => {
      if (!input.retainedDraft) return null;
      // A second tab may inspect the chat, but cannot recover an owned recording.
      try {
        await claimRecording();
      } catch {
        return null;
      }
      try {
        savedRecording = await recordingStorage.find(input.retainedDraft.ownerKey);
        if (!savedRecording) await releaseRecordingLock();
        return savedRecording;
      } catch (error) {
        await releaseRecordingLock();
        throw error;
      }
    },
    discardSavedRecording,
    saveTranscript: (text: string, draft: VoiceDraftSnapshot) => saveTranscript(text, true, draft),
    get transcriptIsFinal() {
      return savedRecording?.transcriptIsFinal === true;
    },
    restoreRecording: async (
      recording: SavedVoiceRecording,
    ): Promise<{ uri: string; transcription: PreparedVoiceTranscription }> => {
      await claimRecording();
      savedRecording = recording;
      recordingOptions = recording.options;
      locale = recording.locale;
      restoredUri = URL.createObjectURL(await recordingStorage.audio(recording.id));
      return { uri: restoredUri, transcription: { locale, transcribe: transcribeRecording } };
    },
    recorder,
    cancelRecording: () => {
      capture.cancelRecording();
      if (savedRecording && !capture.recorder.uri && signal?.aborted) {
        void discardSavedRecording().catch(() => undefined);
      }
    },
    deleteRecording: (uri: string) => {
      const owned = uri === capture.recorder.uri || uri === restoredUri;
      capture.deleteRecording(uri);
      if (uri === restoredUri) restoredUri = null;
      if (owned && savedRecording) void discardSavedRecording().catch(() => undefined);
    },
    transcriber: capture.transcriber,
  };
}
