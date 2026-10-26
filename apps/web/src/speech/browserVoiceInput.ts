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
import type { SpeechTranscriptionOptions, SpeechStreamText } from "@t3tools/contracts";

import { runtime } from "../lib/runtime";
import { recordingStorage, type SavedVoiceRecording } from "./recordingStorage";
import workletUrl from "./pcmWorklet.ts?worker&url";

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly getPrepared?: () => PreparedConnection | null;
  readonly retainedDraft?: { readonly ownerKey: string; readonly read: () => VoiceDraftSnapshot };
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string) => void;
}): {
  readonly saveTranscript: (text: string) => Promise<string>;
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
  let streamError: Error | undefined;
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
  const saveTranscript = async (text: string, transcriptIsFinal = false) => {
    if (savedRecording) {
      await saving;
      await recordingStorage.saveTranscript(savedRecording.id, text, transcriptIsFinal);
      savedRecording = { ...savedRecording, transcript: text, transcriptIsFinal };
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
      if (input.retainedDraft) {
        savedRecording = {
          id: randomUUID(),
          ownerKey: input.retainedDraft.ownerKey,
          draft: input.retainedDraft.read(),
          options: recordingOptions,
          locale,
        };
        await recordingStorage.create(savedRecording);
        // Ask the browser to protect unfinished dictation from storage eviction.
        void navigator.storage?.persist?.().catch(() => undefined);
      }
      const microphoneId = input.getMicrophoneId();
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      if (captureSignal.aborted) {
        captured.getTracks().forEach((track) => track.stop());
        captureSignal.throwIfAborted();
      }
      stream = captured;
      try {
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
        throw error;
      }
    },
    record: (options) => {
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
      if (savedRecording?.transcript !== undefined) return savedRecording.transcript;
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
    saveTranscript: (text) => saveTranscript(text, true),
    get transcriptIsFinal() {
      return savedRecording?.transcriptIsFinal === true;
    },
    restoreRecording: async (recording) => {
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
        const id = savedRecording.id;
        savedRecording = null;
        chunks = [];
        bufferedForStream = [];
        void saving.then(() => recordingStorage.remove(id)).catch(() => undefined);
      }
    },
    deleteRecording: (uri) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) {
        recordingUri = null;
        chunks = [];
        bufferedForStream = [];
        if (savedRecording) {
          const id = savedRecording.id;
          savedRecording = null;
          void saving.then(() => recordingStorage.remove(id)).catch(() => undefined);
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
            onText: input.onText,
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
