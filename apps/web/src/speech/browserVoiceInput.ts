import { randomUUID } from "../lib/utils";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  prepareEnvironmentSpeechModel,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceTranscriptionOptions,
  type VoiceTranscriber,
  type VoiceDraftSnapshot,
  type PreparedVoiceTranscription,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  SpeechPostProcessingOptions,
  SpeechTranscriptionOptions,
  SpeechStreamText,
} from "@t3tools/contracts";

import { runtime } from "../lib/runtime";
import {
  acquireVoiceRecordingLock,
  recordingStorage,
  type SavedVoiceRecording,
} from "./recordingStorage";
import workletUrl from "./pcmWorklet.ts?worker&url";

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly getPrepared?: () => PreparedConnection | null;
  readonly retainedDraft?: { readonly ownerKey: string; readonly read: () => VoiceDraftSnapshot };
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getPostProcessingOptions?: () => SpeechPostProcessingOptions | undefined;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText, locale?: string) => void;
  readonly onError: (message: string) => void;
  readonly onStorageWarning?: (message: string) => void;
  readonly onRecordingRemoved?: (recordingId: string) => void;
}): {
  readonly saveTranscript: (text: string, draft: VoiceDraftSnapshot) => Promise<string>;
  readonly recordingId: string | null;
  readonly postProcessingOptions: SpeechPostProcessingOptions | undefined;
  readonly findRecording: () => Promise<SavedVoiceRecording | null>;
  readonly discardSavedRecording: () => Promise<void>;
  readonly transcriptIsFinal: boolean;
  readonly restoreRecording: (
    recording: SavedVoiceRecording,
  ) => Promise<{ uri: string; transcription: PreparedVoiceTranscription }>;
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber;
  readonly cancelRecording: () => void;
  readonly deleteRecording: (uri: string) => void;
} {
  let stream: MediaStream | undefined;
  let recordingUri: string | null = null;
  let chunks: Float32Array<ArrayBuffer>[] = [];
  let bufferedForStream: Float32Array<ArrayBuffer>[] = [];
  let audioContext: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
  let recordingOptions: SpeechTranscriptionOptions;
  let locale = "auto";
  let savedRecording: SavedVoiceRecording | null = null;
  let sequence = 0;
  let saving = Promise.resolve();
  let storageError: unknown;
  let transcriptStorageWarningShown = false;
  let streamError: Error | undefined;
  let unlockRecording: (() => Promise<void>) | null = null;
  const claimRecording = async () => {
    if (!input.retainedDraft || unlockRecording) return;
    unlockRecording = await acquireVoiceRecordingLock(input.retainedDraft.ownerKey);
    if (!unlockRecording) throw new Error("This chat has an unfinished recording in another tab.");
  };
  const releaseRecordingLock = async () => {
    const release = unlockRecording;
    unlockRecording = null;
    await release?.();
  };
  const discardSavedRecording = async () => {
    const recording = savedRecording;
    savedRecording = null;
    chunks = [];
    bufferedForStream = [];
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
  const preparedConnection = () => {
    const connection = input.getPrepared ? input.getPrepared() : input.prepared;
    if (!connection) throw new Error("The transcription environment is disconnected.");
    return connection;
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
            "Could not save microphone audio. The recording is kept in this tab; retry before closing it.",
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
            "Could not save the transcript backup. Your dictation is kept in this tab.",
          );
        }
      }
    }
    return text;
  };
  let live: Awaited<ReturnType<typeof openSpeechStream>> | undefined;
  let stopped:
    | { readonly resolve: () => void; readonly reject: (error: Error) => void }
    | undefined;

  const cleanupCapture = () => {
    if (durationTimer) clearTimeout(durationTimer);
    durationTimer = undefined;
    worklet?.disconnect();
    worklet?.port.close();
    worklet = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void audioContext?.close();
    audioContext = undefined;
    stopped?.resolve();
    stopped = undefined;
    input.onLevel(0);
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      const captureSignal = signal;
      if (!captureSignal) throw new Error("Voice transcription is not prepared.");
      captureSignal.throwIfAborted();
      if (recordingUri) URL.revokeObjectURL(recordingUri);
      recordingUri = null;
      chunks = [];
      bufferedForStream = [];
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
        captureSignal.throwIfAborted();
        const microphoneId = input.getMicrophoneId();
        const captured = await navigator.mediaDevices.getUserMedia({
          audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
        });
        stream = captured;
        captureSignal.throwIfAborted();
        const context = new AudioContext();
        audioContext = context;
        await context.audioWorklet.addModule(workletUrl);
        captureSignal.throwIfAborted();
        const node = new AudioWorkletNode(context, "t3-pcm-capture", { channelCount: 1 });
        worklet = node;
        node.port.onmessage = ({
          data,
        }: MessageEvent<Float32Array<ArrayBuffer> | number | "stopped" | "limit">) => {
          if (captureSignal.aborted) return;
          if (data === "stopped") {
            stopped?.resolve();
            return;
          }
          if (data === "limit") {
            input.onDurationLimit();
            return;
          }
          if (typeof data === "number") {
            input.onLevel(data);
            return;
          }
          chunks.push(data);
          saveChunk(data);
          if (!live) bufferedForStream.push(data);
          if (live && !streamError) {
            try {
              live.feed(data);
            } catch (error) {
              streamError = error instanceof Error ? error : new Error(String(error));
            }
          }
        };
        node.onprocessorerror = () => {
          stopped?.reject(new Error("Microphone processing failed."));
          input.onError("Microphone processing failed.");
        };
        for (const track of captured.getTracks())
          track.addEventListener("ended", () => input.onError("The microphone disconnected."), {
            once: true,
          });
        context.createMediaStreamSource(captured).connect(node);
        // The processor emits silence, keeping the graph active without microphone playback.
        node.connect(context.destination);
        await context.resume();
        captureSignal.throwIfAborted();
      } catch (error) {
        cleanupCapture();
        if (savedRecording) {
          await discardSavedRecording();
        }
        throw error;
      }
    },
    record: (options) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePort.postMessage sends to its connected port and has no targetOrigin parameter.
      worklet?.port.postMessage("start");
      if (options?.forDuration !== undefined)
        durationTimer = setTimeout(input.onDurationLimit, options.forDuration * 1_000);
    },
    stop: async () => {
      if (!worklet) return;
      if (signal?.aborted) {
        cleanupCapture();
        return;
      }
      const pending = new Promise<void>((resolve, reject) => {
        stopped = { resolve, reject };
      });
      const timeout = setTimeout(
        () => stopped?.reject(new Error("Microphone capture did not stop.")),
        5_000,
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePort.postMessage sends to its connected port and has no targetOrigin parameter.
      worklet.port.postMessage("stop");
      try {
        await pending;
      } finally {
        if (chunks.length) {
          const blob = new Blob(chunks, { type: "application/octet-stream" });
          recordingUri = URL.createObjectURL(blob);
          await saving;
          chunks = [];
        }
        clearTimeout(timeout);
        cleanupCapture();
      }
    },
  };

  const transcribeRecording = async (
    uri: string,
    { signal: transcriptionSignal }: VoiceTranscriptionOptions,
  ) => {
    try {
      if (savedRecording?.transcript?.trim()) return savedRecording.transcript;
      const response = await fetch(uri, { signal: transcriptionSignal });
      const pcm = new Uint8Array(await response.arrayBuffer());
      const result = await runtime.runPromise(
        transcribeEnvironmentPcm(preparedConnection(), pcm, recordingOptions),
        {
          signal: transcriptionSignal,
        },
      );
      throwIfVoiceTranscriptionAborted(transcriptionSignal);
      return await saveTranscript(result.text);
    } catch (cause) {
      throwIfVoiceTranscriptionAborted(transcriptionSignal);
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Voice transcription on this environment failed.",
        { cause },
      );
    }
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
    saveTranscript: (text, draft) => saveTranscript(text, true, draft),
    get transcriptIsFinal() {
      return savedRecording?.transcriptIsFinal === true;
    },
    restoreRecording: async (recording) => {
      await claimRecording();
      savedRecording = recording;
      recordingOptions = recording.options;
      locale = recording.locale;
      recordingUri = URL.createObjectURL(await recordingStorage.audio(recording.id));
      return { uri: recordingUri, transcription: { locale, transcribe: transcribeRecording } };
    },
    recorder,
    cancelRecording: () => {
      cleanupCapture();
      if (savedRecording && !recordingUri && signal?.aborted) {
        void discardSavedRecording().catch(() => undefined);
      }
    },
    deleteRecording: (uri) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) {
        recordingUri = null;
        chunks = [];
        bufferedForStream = [];
        if (savedRecording) {
          void discardSavedRecording().catch(() => undefined);
        }
      }
    },
    transcriber: {
      prepare: async (options) => {
        signal = options.signal;
        recordingOptions = input.getTranscriptionOptions();
        live = undefined;
        streamError = undefined;
        const status = await runtime.runPromise(
          getEnvironmentSpeechStatus(preparedConnection()),
          options,
        );
        throwIfVoiceTranscriptionAborted(options.signal);
        if (!status.supported) throw new VoiceTranscriptionError("unavailable", status.reason);
        const language = status.languages
          ? effectiveSpeechLanguage(
              {
                languages: status.languages,
                supportsLanguageDetection: status.supportsLanguageDetection ?? false,
              },
              recordingOptions.speechLanguage,
            )
          : "auto";
        locale =
          !status.supportsStreaming &&
          status.supportsTranslation &&
          recordingOptions.speechTranslateToEnglish
            ? "en"
            : language;
        if (status.supportsStreaming) {
          const url = await runtime.runPromise(
            getEnvironmentSpeechStreamUrl(preparedConnection()),
            options,
          );
          const session = openSpeechStream({
            url,
            options: recordingOptions,
            signal: options.signal,
            onText: (text) => input.onText(text, locale),
            onError: (error) => {
              streamError = error;
            },
          }).then((prepared) => {
            live = prepared;
            for (const chunk of bufferedForStream) prepared.feed(chunk);
            bufferedForStream = [];
            return prepared;
          });
          void session.catch((error: unknown) => {
            streamError =
              error instanceof Error ? error : new Error("Could not prepare voice input.");
          });
          return {
            locale,
            transcribe: transcribeRecording,
            streaming: {
              finish: async () => {
                if (streamError) throw streamError;
                const text = await (await session).finish();
                return saveTranscript(text);
              },
            },
          };
        }
        const preparedModel = runtime.runPromise(
          prepareEnvironmentSpeechModel(preparedConnection()),
          options,
        );
        // A failed warmup should still allow the normal transcription path to retry.
        void preparedModel.catch(() => undefined);
        return {
          locale,
          transcribe: async (uri, transcriptionOptions) => {
            await preparedModel.catch(() => undefined);
            return transcribeRecording(uri, transcriptionOptions);
          },
        };
      },
    },
  };
}
