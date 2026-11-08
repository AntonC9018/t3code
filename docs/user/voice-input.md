# Voice input

Dictate into the composer instead of typing. The transcript lands in your draft
for review, and only sending the message sends anything to an agent. Dictation
also works in citation comments, diff and file annotations, pull request
comments, replies, and review summaries, and in the desktop app's browser
annotation editor.

On iPhone and Android, voice input transcribes on the device by default. To opt in
to a named environment on that phone, open **Settings → Voice → Transcribe on**. See
[Voice input on mobile](./composer.md#voice-input-on-mobile).

## Choose where audio goes

On web and desktop, transcription runs on one of your T3 Code environments.
Nothing is sent until you choose one: open **Settings → Voice** and turn on
**Send microphone audio**. The audio goes to the environment shown under
**Transcription environment**, which defaults to the primary environment.
Microphone audio recorded on this device is sent to that environment over your
authenticated connection, transcribed there, and discarded. The choice is saved
on this device only, so every computer and browser you use asks for it once.
Turn it off at any time; a recording in progress is discarded.

Changing the transcription environment while sending is on moves the choice to the
new environment. If the chosen environment goes offline, voice input waits for it.
T3 Code never substitutes another environment.

## Set up a model

The first time you dictate, T3 Code offers to download the recommended English
model to the chosen environment. In **Settings → Voice → Transcription**, select
the languages you dictate in to compare models that support all of them.
Accuracy shows how often the model got words or characters wrong in each
language; speed is the time to transcribe 30 seconds on a reference GPU. Choose
**All languages** to browse the full catalog. Filtering does not switch your model.
Voice settings also lets you switch between downloaded models or remove them.

**Transcription acceleration** defaults to **Auto**, which uses a GPU when
available. Choose CPU to avoid GPU use, or select a specific GPU. With **Auto**, a
recording that fails on the GPU is retried once on that same environment's CPU; a
GPU you picked yourself reports the error instead. Nothing is ever retried on
another environment. **Model unload** defaults to 15 minutes of inactivity. Choose
**Never** to keep the model ready until the environment stops, or **Immediately** to
release its memory after each transcription.

Models marked **Live preview** show text while you speak. Handy refreshes its
preview about every couple of seconds. Other models insert their transcript after
recording stops.

## Dictate

Press the microphone in the composer, or `mod+shift+d` (`mod` is Command on
macOS and Ctrl elsewhere). Press again, or the check mark, to finish; `Esc`
discards the recording and leaves your draft unchanged. Recording continues until
you finish or cancel it. Text is inserted at the cursor or replaces the selection
you had when recording started. You can keep editing while recording. A live
preview is tentative and may change as the model hears more; the full recording
supplies the completed transcript.

Pressing Send while dictating finishes the recording and sends the draft once
the transcript, and any cleanup, has been inserted. You can also press Send while
those steps are finishing. Cancelling also cancels that queued send and keeps your
draft. In the other editors, Save, Comment, Reply, Submit review, or Attach works the
same way, and the shortcut targets the editor that has focus, or the composer
when none does. In the desktop browser's annotation editor, the microphone and
the shortcut work while the page has focus; the page you are annotating never
sees the recording, which runs in T3 Code itself.

In the chat composer, dictation stays with the chat where you started it.
You can switch chats while recording or transcribing; the completed text goes into
the original chat's draft. Switching chats cancels a queued Send, so the transcript
remains available for review.

**Dictation shortcut** in Voice settings picks how the keybinding behaves:
**Auto** tap-toggles or records while held, **Hold** records only while the keys
are down, and **Toggle** always needs a second press. Change the chord itself in
[Keybindings settings](./keybindings.md).

### Saved recordings

Unfinished chat recordings are saved on this device as you speak. If transcription
fails, reconnect the transcription environment and choose **Retry transcription**
to resend the saved audio without recording again. After a reload or app restart,
open the original chat to retry its saved recording. Saved audio is removed after
the text is added to the draft or you explicitly discard it. Keep the browser's
site data to retain unfinished recordings; they do not sync between devices.
Changing the transcription environment or turning off sending microphone audio
also deletes saved recordings, including after a reload; turning sending back on
does not restore them.

If a question closes before its dictation finishes, the recording stays in the
original chat. Choose **Recover to draft** to insert it into the chat draft, or
explicitly discard it. Closing a question does not delete its recording.

## Improve recognition

- **Language** picks what you speak. **Auto** lets a multilingual model detect
  it. Models that translate offer **Translate to English**.
- **Dictionary** holds names and terms the model should get right. Add an alias
  under a term when transcription keeps producing a particular misspelling.
  Only preferred terms are sent as recognition hints; aliases correct matching
  words and phrases in the transcript. Your dictionary is saved on this device.
  The name of the project you dictate in is sent along as a hint.
- **Project dictionary** is vocabulary saved with a project on its environment,
  so everyone who dictates in that project gets the same spellings. Pick the
  project at the top of Settings to edit it; with an environment selected, the
  entries apply to every project there. Project spellings win when they overlap
  your personal dictionary. Each recording carries up to 100 entries from the
  two combined.
- **Silence filtering** is on by default. Your chosen environment skips non-speech
  audio before transcription. Turn it off to keep those sections. Filtering happens
  after upload: it does not grant permission to send audio or reduce how much is sent.
- **Remove filler words** drops hesitation sounds from finished transcripts.

Language and these preferences travel with each recording to the chosen
environment; nothing else about the project is sent.

## Clean up transcripts with a provider

**Voice post-processing** is a separate choice and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside, and
after your selection are sent to the text generation provider configured on the
draft's environment, which fixes punctuation, numbers, and spoken corrections such
as "make it 42, sorry, 24". Depending on the provider, that can involve an external
service. Audio is never sent to it. The choice is saved on this device only. Use
the built-in instructions or write your own, press **Skip** while cleanup runs to
insert the raw transcript, and if cleanup fails the raw transcript is inserted.

Cleanup uses the environment's text generation model unless you pick a
**Cleanup model** for that environment, for example a cheaper or faster one.

If cleanup misses the way you correct yourself, set a **Correction cue**: the
word or phrase you say to flag a correction, such as "scratch that". Cleanup
applies the correction only where the context shows one and drops the cue, and
the model hears the cue as a dictionary hint.

## Test and troubleshoot

In **Settings → Voice**, **Test microphone** beside the microphone selector
records up to ten seconds and plays it back in your browser;
the audio stays on this device and is never transcribed, so silent playback
points at the microphone. **Test model** on the selected model shows a transcript using the
same environment, language, and dictionary as the composer, but skips transcript
cleanup even when it is on, so you see what the model heard. Browser recording
needs HTTPS or localhost and microphone permission; for a remote server over
plain HTTP, use the desktop app. If the selected microphone is missing, choose
another or the system default. Make sure the transcription environment is
connected and its model is downloaded.
