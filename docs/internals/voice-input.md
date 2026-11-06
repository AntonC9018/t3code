# Voice input

Transcription edits a draft in the composer or a supported text editor. It does
not submit an agent turn. Audio is temporary client input, and only normal message
submission sends the resulting text; web and desktop can queue an explicit Send,
submit, or save request until the completed transcript is inserted. Mobile defaults
to on-device transcription; any client that sends audio off the device needs a grant
for one environment.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, revision, and selection are captured before recording and checked before
insertion, so a late transcript cannot overwrite a draft that was edited or
replaced. A transcriber may expose a streaming session, in which case audio leaves
during capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

Only an explicit audio grant authorizes off-device transcription. On mobile the
grant is stored in device-bound secure storage, outside preference backups. The
[web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences
snapshot so another window saving unrelated settings cannot resurrect a revoked
grant. Each new choice gets a distinct grant, even if the destination was
previously selected. Every sender checks the grant again before dispatch, including
a retry of a retained recording.

The [web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds a
recording controller to the prepared connection of the granted environment and to
nothing else. The transcription host can differ from the thread's environment, even
when the desktop app has a bundled server. When the destination changes,
disconnects, or stops advertising the `voiceTranscription` capability, the
controller is disposed: a recording in progress is discarded, a failed recording
kept for retry is deleted, and nothing falls back to another environment. Every
sender in the web app, including the settings page's transcription test, goes
through that hook. The microphone loopback test captures separately for local
playback and sends nothing. The transport refuses redirects so credentials and
audio cannot follow one to another host.

Microphone selection and personal dictation preferences are client-local. Each
recording snapshots those preferences and the originating project's vocabulary.
Project vocabulary uses project overrides on the originating environment; the
transcription host never stores foreign project IDs. The resolved dictionary and
correction cue travel with both transcription and cleanup requests.

Transcript cleanup requires its own grant, off by default. It sends the transcript
and draft context, never audio, to the text generation provider of the draft's own
environment, because that is where the provider credentials live. A later backend
adds its own destination kind, disclosure, and transcriber; capture and the
controller stay as they are.

## Retained recordings

Web and desktop chat composers append captured audio to a
[recording store](../../apps/web/src/speech/recordingStorage.ts) while recording,
so a failed transcription can be retried and an unfinished recording recovered
after a reload. A recording belongs to one draft owner and one tab at a time. The
session outlives the editor that started it, so switching chats does not cancel
dictation; the transcript is committed to the original draft. A saved recording is
removed once its text is inserted or the user discards it. Disposing the session
on a destination change deletes only the recording that session owns.

Model storage and lifecycle belong to the transcription environment. Transcription
options travel in request bodies or the stream's initial command, rather than URLs
or headers; the [wire encoding](../../packages/shared/src/speech.ts) and
[stream contracts](../../packages/contracts/src/speech.ts) define those formats.

## Server side

The [speech service](../../apps/server/src/speech/SpeechService.ts) runs
transcribe-cpp in a child process so a hung native call can be killed without
taking the server down; see [native.ts](../../apps/server/src/speech/native.ts)
for the packaging constraints (Node SEA, Electron ASAR). One native request runs
at a time. Batch uploads carry their options in the body framing defined in
[shared/speech.ts](../../packages/shared/src/speech.ts); streaming sends them in
the socket's first command. Model files and the selected model, hardware
placement, and unload timeout are environment state in server settings.

The Silero silence detector is optional. If its download fails, recordings use
raw audio during the retry cooldown so a detector outage cannot block dictation.
Explicitly installing a speech model also retries the detector without waiting.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results. On the server,
interrupting a batch request kills the worker process instead; the next request
reloads the model.

Web and desktop cancellation aborts the client request, prevents late transcript
insertion, and clears any queued submission. Editors remain writable during recording;
streaming updates replace the dictated span, preserving unrelated edits. Draft revision
checks still protect against external changes. Submission controls are disabled during
preparation. Once recording starts, a submission request finishes recording and waits
for transcription and optional cleanup before submitting the completed draft. The
request can also be queued while transcription or cleanup is already running; see the
[client integration](../../apps/web/src/speech/useEnvironmentSpeechInput.ts).
