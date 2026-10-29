import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import type { PreparedVoiceTranscription, VoiceTranscriber } from "./transcription.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

export const MICROPHONE_PERMISSION_ERROR =
  "Microphone access is required for voice input. Allow access in your browser or system settings and try again.";

export function isMicrophonePermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

export type VoiceInputPhase<WithPostProcessing extends boolean = false> =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "error"
  | (WithPostProcessing extends true ? "post-processing" : never);

export type VoiceInputState<WithPostProcessing extends boolean = false> = {
  readonly phase: VoiceInputPhase<WithPostProcessing>;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
  readonly hasRecording?: boolean;
};

export function voiceInputBlocksSubmission<State extends Pick<VoiceInputState<true>, "phase">>(
  state: State,
): boolean {
  return (
    state.phase === "preparing" ||
    state.phase === "recording" ||
    state.phase === "transcribing" ||
    state.phase === "post-processing"
  );
}

export function voiceInputFreezesEditor<State extends Pick<VoiceInputState<true>, "phase">>(
  state: State,
): boolean {
  return (
    state.phase === "preparing" ||
    state.phase === "transcribing" ||
    state.phase === "post-processing"
  );
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options?: { readonly forDuration?: number }): void;
  stop(): Promise<void>;
}

export type VoiceInputControllerDependencies<WithPostProcessing extends boolean = false> = {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly postProcess?: WithPostProcessing extends true
    ?
        | ((
            transcript: string,
            options: { readonly signal: AbortSignal; readonly draft: VoiceDraftSnapshot },
          ) => Promise<string>)
        | undefined
    : never;
  readonly onPostProcessingError?: (error: unknown) => void;
  readonly onTranscriptReady?: (text: string, draft: VoiceDraftSnapshot) => Promise<void>;
  readonly onStreamingTranscript?: (
    text: string,
    draft: VoiceDraftSnapshot,
    locale: string,
  ) => VoiceDraftSnapshot | null;
  readonly onStreamingCancel?: () => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState<WithPostProcessing>) => void;
};

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

export type VoiceLiveTranscript = {
  readonly base: VoiceDraftSnapshot;
  readonly expectedText: string;
  readonly start: number;
  readonly end: number;
};

function resolveLiveTranscriptRange(
  currentText: string,
  live: VoiceLiveTranscript,
): { readonly start: number; readonly end: number } | null {
  let start = live.start;
  let end = live.end;
  const oldText = live.expectedText;
  if (currentText === oldText) return { start, end };

  let prefix = 0;
  while (
    prefix < oldText.length &&
    prefix < currentText.length &&
    oldText[prefix] === currentText[prefix]
  )
    prefix += 1;
  let suffixLength = 0;
  while (
    suffixLength < oldText.length - prefix &&
    suffixLength < currentText.length - prefix &&
    oldText[oldText.length - 1 - suffixLength] ===
      currentText[currentText.length - 1 - suffixLength]
  )
    suffixLength += 1;
  const oldChangeEnd = oldText.length - suffixLength;
  const newChangeEnd = currentText.length - suffixLength;
  if (oldChangeEnd <= live.start) {
    const delta = newChangeEnd - oldChangeEnd;
    start += delta;
    end += delta;
  } else if (prefix < live.end && oldChangeEnd > live.start) {
    return null;
  }
  return { start, end };
}

export function resolveLiveTranscriptCancel(
  current: VoiceDraftSnapshot,
  live: VoiceLiveTranscript,
): VoiceDraftSnapshot | null {
  if (current.ownerKey !== live.base.ownerKey) return null;
  const range = resolveLiveTranscriptRange(current.text, live);
  if (!range) return null;
  const restored = live.base.text.slice(live.base.selection.start, live.base.selection.end);
  const text = current.text.slice(0, range.start) + restored + current.text.slice(range.end);
  const delta = restored.length - (range.end - range.start);
  const mapSelection = (position: number) =>
    position <= range.start
      ? position
      : position >= range.end
        ? position + delta
        : range.start + restored.length;
  return {
    ...current,
    text,
    selection: {
      start: mapSelection(current.selection.start),
      end: mapSelection(current.selection.end),
    },
    revision: current.revision + 1,
  };
}

export function resolveLiveTranscriptUpdate(
  current: VoiceDraftSnapshot,
  live: VoiceLiveTranscript | null,
  transcript: string,
  locale: string,
): { readonly draft: VoiceDraftSnapshot; readonly live: VoiceLiveTranscript } | null {
  const base = live?.base ?? current;
  if (base.ownerKey !== current.ownerKey) return null;
  const resolved = resolveTranscriptCommit(base, base, transcript, locale);
  if (resolved.kind !== "commit") return null;

  const insertionStart = base.selection.start;
  const suffixLength = base.text.length - base.selection.end;
  const insertionEnd = resolved.text.length - suffixLength;
  const insertion = resolved.text.slice(insertionStart, insertionEnd);
  let start = insertionStart;
  let end = live ? live.end : base.selection.end;
  if (live) {
    const range = resolveLiveTranscriptRange(current.text, live);
    if (!range) return null;
    start = range.start;
    end = range.end;
  }

  const text = `${current.text.slice(0, start)}${insertion}${current.text.slice(end)}`;
  const cursor = start + insertion.length;
  const delta = insertion.length - (end - start);
  const mapSelection = (position: number) =>
    position <= start ? position : position >= end ? position + delta : cursor;
  const selectionStart = live ? mapSelection(current.selection.start) : cursor;
  const selectionEnd = live ? mapSelection(current.selection.end) : cursor;
  const draft = {
    ...current,
    text,
    selection: { start: selectionStart, end: selectionEnd },
    revision: current.revision + 1,
  };
  return {
    draft,
    live: { base, expectedText: text, start, end: cursor },
  };
}

// Auto-detected transcription has no resolved locale; these scripts join without spaces.
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  const isEmptySelection = captured.selection.start === captured.selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesSpaces = !/^(zh|ja|th|lo|km|my)(-|$)/.test(normalizedLocale);
  let insertion = replacement;
  if (isEmptySelection && usesSpaces) {
    const left = captured.text.slice(
      Math.max(0, captured.selection.start - 2),
      captured.selection.start,
    );
    const right = captured.text.slice(captured.selection.start, captured.selection.start + 2);
    const leftCharacter = left.match(/.$/u)?.[0];
    const rightCharacter = right.match(/^./u)?.[0];
    const autoLocale = normalizedLocale === "auto";
    const leftNeedsBoundary =
      /[\p{L}\p{M}\p{N}.!?,:;)\]}'"]$/u.test(left) &&
      (right.length === 0 || /^\s/u.test(right)) &&
      !(
        autoLocale &&
        (UNSPACED_SCRIPT.test(leftCharacter ?? "") ||
          UNSPACED_SCRIPT.test(replacement.match(/^./u)?.[0] ?? ""))
      );
    const rightNeedsBoundary =
      /^[\p{L}\p{M}\p{N}([{'"]/u.test(right) &&
      (left.length === 0 || /\s$/u.test(left)) &&
      !(
        autoLocale &&
        (UNSPACED_SCRIPT.test(rightCharacter ?? "") ||
          UNSPACED_SCRIPT.test(replacement.match(/.$/u)?.[0] ?? ""))
      );
    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const result = replaceTextRange(
    captured.text,
    captured.selection.start,
    captured.selection.end,
    insertion,
  );
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
  };
}

type VoiceInputSession = {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
};

let activeSession: VoiceInputSession | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const token = { abandoned: false, released, release };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceInputSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
}

async function runTranscriptionOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTranscriptionOperation) {
    throw new Error("voice-operation-busy");
  }

  const promise = operation();
  activeTranscriptionOperation = promise;
  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  if (errorCode(error) === "unsupported-locale") {
    return "Voice transcription is not available for this language.";
  }
  if (
    error instanceof VoiceTranscriptionError &&
    (error.code === "preparation-failed" || error.code === "unavailable") &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState<true> = { phase: "idle", error: null, errorAction: null };

export class VoiceInputController<WithPostProcessing extends boolean = false> {
  private readonly dependencies: VoiceInputControllerDependencies<WithPostProcessing>;
  private state: VoiceInputState<true> = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private postProcessingAbortController: AbortController | null = null;
  private skipPostProcessingRequested = false;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private finishing = false;
  private retryRecording: {
    uri: string;
    draft: VoiceDraftSnapshot;
    transcription: PreparedVoiceTranscription;
    commit?: { text: string; selection: { readonly start: number; readonly end: number } };
  } | null = null;

  constructor(dependencies: VoiceInputControllerDependencies<WithPostProcessing>) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState<WithPostProcessing> {
    return this.state as VoiceInputState<WithPostProcessing>;
  }

  updateStreamingTranscript(text: string, locale: string): VoiceDraftSnapshot | null {
    if (
      (this.state.phase !== "recording" &&
        this.state.phase !== "transcribing" &&
        this.state.phase !== "post-processing") ||
      !this.capturedDraft
    )
      return null;
    const nextDraft = this.dependencies.onStreamingTranscript?.(text, this.capturedDraft, locale);
    if (nextDraft) this.capturedDraft = nextDraft;
    return nextDraft ?? null;
  }

  restoreRecording(
    uri: string,
    draft: VoiceDraftSnapshot,
    transcription: PreparedVoiceTranscription,
  ): void {
    if (this.state.phase !== "idle") return;
    this.retryRecording = { uri, draft, transcription };
    this.rememberRecordingUri(uri);
    this.setError("Could not transcribe this recording.", "retry");
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiatingDraft = this.dependencies.readDraft();
    if (!initiatingDraft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "retry");
        return;
      }
      this.sessionToken = sessionToken;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;

      if (this.retryRecording) {
        const pendingCommit = this.retryRecording.commit;
        if (
          pendingCommit &&
          initiatingDraft.text === pendingCommit.text &&
          initiatingDraft.ownerKey === this.retryRecording.draft.ownerKey
        ) {
          try {
            this.dependencies.commitDraft(pendingCommit.text, pendingCommit.selection);
            this.retryRecording = null;
            this.setState(IDLE_STATE);
          } catch {
            this.setError("Could not save the transcribed draft.", "retry");
          } finally {
            await this.releaseResources();
          }
          return;
        }
        this.recordingUri = this.retryRecording.uri;
        this.capturedDraft =
          initiatingDraft.text === this.retryRecording.draft.text
            ? { ...this.retryRecording.draft, revision: initiatingDraft.revision }
            : initiatingDraft;
        this.transcription = this.retryRecording.transcription;
        this.retryRecording = null;
        await this.finishRecording(true, this.recordingUri);
        return;
      }
      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.dependencies.requestPermission();
      if (!this.isCurrent(operationToken)) return;
      if (!permission.granted) {
        this.setError(
          "Microphone access is required for voice input.",
          permission.canAskAgain ? "retry" : "settings",
        );
        return;
      }

      try {
        this.transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal: abortController.signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) this.setError(preparationErrorMessage(error), "retry");
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.dependencies.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.dependencies.recorder.record();
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch (error) {
      if (this.isCurrent(operationToken))
        this.setError(
          isMicrophonePermissionError(error)
            ? MICROPHONE_PERMISSION_ERROR
            : "Could not start voice recording.",
          "retry",
        );
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishing) {
          await this.releaseResources();
        }
      }
    }
  }

  retryIntoCurrentDraft(): Promise<void> {
    if (this.state.phase !== "error" || !this.retryRecording) return Promise.resolve();
    const draft = this.dependencies.readDraft();
    if (!draft) return this.start();
    this.retryRecording = {
      uri: this.retryRecording.uri,
      transcription: this.retryRecording.transcription,
      draft,
    };
    return this.start();
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null);
  }

  cancel(): void {
    this.dependencies.onStreamingCancel?.();
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.retryRecording = null;
        this.deleteOwnedRecordings();
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        this.discardRecording(null);
        return;
      case "transcribing":
      case "post-processing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  skipPostProcessing(): void {
    if (this.state.phase !== "post-processing") return;
    this.skipPostProcessingRequested = true;
    this.postProcessingAbortController?.abort();
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (
      this.state.phase === "preparing" ||
      this.state.phase === "transcribing" ||
      this.state.phase === "post-processing"
    ) {
      this.invalidateOperation();
      this.setError(message, "retry");
      return;
    }
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
      return;
    }
    return this.interruptRecording();
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Voice recording was interrupted.",
        status.url,
      );
    }
    if (status.isFinished) {
      if (!status.url) {
        return this.interruptRecording();
      }
      return this.finishRecording(true, status.url);
    }
  }

  ownerChanged(): void {
    if (this.state.phase === "idle") return;
    this.cancel();
  }

  dispose(): void {
    if (this.state.phase === "error") {
      this.cancel();
      return;
    }
    if (this.state.phase === "recording") {
      this.discardRecording(null);
      return;
    }
    if (
      this.state.phase === "preparing" ||
      this.state.phase === "transcribing" ||
      this.state.phase === "post-processing"
    ) {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
  ): Promise<void> {
    if (this.finishing || (this.state.phase !== "recording" && this.state.phase !== "preparing"))
      return;
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.isCurrent(operationToken)) return;
      if (
        !this.transcription ||
        (!this.transcription.streaming && !this.recordingUri) ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const recordingUri = this.recordingUri;
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      let capturedDraft = this.capturedDraft;
      if (recordingUri) {
        this.retryRecording = {
          uri: recordingUri,
          draft: capturedDraft,
          transcription: { locale: transcription.locale, transcribe: transcription.transcribe },
        };
      }
      let transcript: string;
      try {
        transcript = await runTranscriptionOperation(() =>
          transcription.streaming
            ? transcription.streaming.finish({ signal })
            : transcription.transcribe(recordingUri!, { signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error), "retry");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;
      capturedDraft = this.capturedDraft ?? capturedDraft;
      const processingDraft = capturedDraft;

      // The final result can differ from partial updates. Apply it before cleanup so the live
      // span is replaced rather than appended twice. This also handles retries that use batch
      // transcription after a streaming failure.
      let streamingDraft = this.updateStreamingTranscript(transcript, transcription.locale);
      if (streamingDraft) capturedDraft = streamingDraft;

      if (this.dependencies.postProcess && transcript.trim().length > 0) {
        this.setState({ phase: "post-processing", error: null, errorAction: null });
        const postProcessingAbortController = new AbortController();
        this.postProcessingAbortController = postProcessingAbortController;
        this.skipPostProcessingRequested = false;
        const rawTranscript = transcript;
        try {
          transcript = await Promise.race([
            this.dependencies.postProcess(transcript, {
              signal: postProcessingAbortController.signal,
              draft: processingDraft,
            }),
            new Promise<string>((resolve) =>
              postProcessingAbortController.signal.addEventListener(
                "abort",
                () => resolve(rawTranscript),
                { once: true },
              ),
            ),
          ]);
        } catch (error) {
          if (!this.skipPostProcessingRequested) {
            this.dependencies.onPostProcessingError?.(error);
          }
        }
        if (!this.isCurrent(operationToken)) return;
      }

      if (this.dependencies.postProcess && streamingDraft) {
        streamingDraft = this.updateStreamingTranscript(transcript, transcription.locale);
        if (streamingDraft) capturedDraft = streamingDraft;
      }

      await this.dependencies.onTranscriptReady?.(transcript, capturedDraft);
      if (!this.isCurrent(operationToken)) return;
      if (streamingDraft) {
        this.retryRecording = null;
        this.setState(IDLE_STATE);
        return;
      }
      const result = resolveTranscriptCommit(
        capturedDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
      );
      if (result.kind === "stale") {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      if (result.kind === "empty") {
        this.setError("No speech was detected.", "retry");
        return;
      }

      if (this.retryRecording) this.retryRecording.commit = result;
      this.dependencies.commitDraft(result.text, result.selection);
      this.retryRecording = null;
      this.setState(IDLE_STATE);
    } catch {
      if (this.isCurrent(operationToken)) {
        const uri = this.dependencies.recorder.uri ?? this.recordingUri;
        if (!this.retryRecording && uri && this.capturedDraft && this.transcription) {
          this.retryRecording = {
            uri,
            draft: this.capturedDraft,
            transcription: {
              locale: this.transcription.locale,
              transcribe: this.transcription.transcribe,
            },
          };
          this.rememberRecordingUri(uri);
        }
        this.setError("Could not finish voice recording.", "retry");
      }
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  private async discardRecording(error: string | null): Promise<void> {
    this.invalidateOperation();
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry" }
        : { phase: "idle", error: null, errorAction: null },
    );
    try {
      await this.dependencies.recorder.stop();
    } catch {
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    this.transcriptionAbortController?.abort();
    this.postProcessingAbortController?.abort();
    this.rememberRecordingUri(this.recordingUri);
    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {}
    this.recordingUri = null;
    this.deleteOwnedRecordings();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
    this.postProcessingAbortController = null;
    this.skipPostProcessingRequested = false;
  }

  private deleteOwnedRecordings(): void {
    for (const uri of this.ownedRecordingUris) {
      if (uri === this.retryRecording?.uri) continue;
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
    }
    this.ownedRecordingUris.clear();
    if (this.retryRecording) this.ownedRecordingUris.add(this.retryRecording.uri);
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {}
  }

  private invalidateOperation(): void {
    this.retryRecording = null;
    this.operationToken += 1;
    if (this.sessionToken) this.sessionToken.abandoned = true;
    this.transcriptionAbortController?.abort();
    this.postProcessingAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({
      phase: "error",
      error,
      errorAction,
      ...(this.retryRecording ? { hasRecording: true } : {}),
    });
  }

  private setState(state: VoiceInputState<true>): void {
    this.state = state;
    // The post-processing phase is only entered when a postProcess dependency exists.
    this.dependencies.onStateChange(state as VoiceInputState<WithPostProcessing>);
  }
}

export function resetVoiceInputGlobalsForTests(): void {
  activeSession = null;
  activeTranscriptionOperation = null;
}
