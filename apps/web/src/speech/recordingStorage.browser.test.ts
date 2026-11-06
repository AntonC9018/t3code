import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  isVoiceRecordingLocked,
  recordingStorage,
  type SavedVoiceRecording,
} from "./recordingStorage";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

const recording = (id: string, ownerKey: string): SavedVoiceRecording => ({
  id,
  ownerKey,
  draft: { ownerKey, text: "Existing", selection: { start: 8, end: 8 }, revision: 2 },
  options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  locale: "en",
});

it("restores audio and transcription across database connections, isolated by chat", async () => {
  const first = recording("storage-test-first", "chat-first");
  const second = recording("storage-test-second", "chat-second");
  try {
    await recordingStorage.create(first);
    await recordingStorage.create(second);
    expect(await recordingStorage.listByOwnerPrefix("chat-first")).toEqual([first]);
    await recordingStorage.append(first.id, 1, new Float32Array([0.5]));
    await recordingStorage.append(first.id, 0, new Float32Array([0.25]));
    await recordingStorage.append(second.id, 0, new Float32Array([-0.5]));
    await expect(
      recordingStorage.create({ ...first, id: "second-tab-recording" }),
    ).rejects.toBeDefined();
    await recordingStorage.saveTranscript(first.id, "Recovered words");

    expect(await recordingStorage.find(first.ownerKey)).toEqual({
      ...first,
      transcript: "Recovered words",
      transcriptIsFinal: false,
    });
    expect(await recordingStorage.find(second.ownerKey)).toEqual(second);
    const audio = await recordingStorage.audio(first.id);
    expect(Array.from(new Float32Array(await audio.arrayBuffer()))).toEqual([0.25, 0.5]);

    await recordingStorage.remove(first.id);
    expect(await recordingStorage.find(first.ownerKey)).toBeNull();
    expect((await recordingStorage.audio(first.id)).size).toBe(0);
    expect((await recordingStorage.audio(second.id)).size).toBe(4);
  } finally {
    await recordingStorage.remove(first.id);
    await recordingStorage.remove(second.id);
  }
});

it("reports a failed chunk write while preserving previously saved audio", async () => {
  const saved = recording("storage-test-failure", "chat-failure");
  try {
    await recordingStorage.create(saved);
    await recordingStorage.append(saved.id, 0, new Float32Array([0.25]));
    await expect(
      recordingStorage.append(saved.id, 0, new Float32Array([0.75])),
    ).rejects.toBeDefined();
    const audio = await recordingStorage.audio(saved.id);
    expect(Array.from(new Float32Array(await audio.arrayBuffer()))).toEqual([0.25]);
    expect(await recordingStorage.find(saved.ownerKey)).toEqual(saved);
  } finally {
    await recordingStorage.remove(saved.id);
  }
});

it("recovers the insertion target chosen by a retry after the draft was edited", async () => {
  const saved = recording("storage-test-retry", "chat-retry");
  const draft = { ...saved.draft, text: "Changed", selection: { start: 7, end: 7 }, revision: 3 };
  try {
    await recordingStorage.create(saved);
    await recordingStorage.saveTranscript(saved.id, "Recovered", true, draft);
    expect(await recordingStorage.find(saved.ownerKey)).toEqual({
      ...saved,
      draft,
      transcript: "Recovered",
      transcriptIsFinal: true,
    });
  } finally {
    await recordingStorage.remove(saved.id);
  }
});

it("prevents another tab's session from recovering or discarding an owned recording", async () => {
  const saved = recording("storage-test-owned", "chat-owned");
  const makePlatform = () =>
    createBrowserVoiceInputPlatform({
      prepared: {} as PreparedConnection,
      retainedDraft: {
        ownerKey: saved.ownerKey,
        grantId: "consent-grant",
        read: () => saved.draft,
      },
      getTranscriptionOptions: () => saved.options,
      getMicrophoneId: () => "",
      onLevel() {},
      hasAudioConsent: () => true,
      onText() {},
      onError() {},
    });
  const first = makePlatform();
  const second = makePlatform();
  try {
    await recordingStorage.create(saved);
    await recordingStorage.append(saved.id, 0, new Float32Array([0.25]));
    expect(await first.findRecording()).toEqual(saved);
    expect(await isVoiceRecordingLocked(saved.ownerKey)).toBe(true);
    expect(await second.findRecording()).toBeNull();
    await expect(second.restoreRecording(saved)).rejects.toThrow("another tab");
    await second.discardSavedRecording();
    expect(await recordingStorage.find(saved.ownerKey)).toEqual(saved);
    await first.discardSavedRecording();
    expect(
      await Promise.all([
        isVoiceRecordingLocked(saved.ownerKey),
        isVoiceRecordingLocked(saved.ownerKey),
      ]),
    ).toEqual([false, false]);
    expect(await second.findRecording()).toBeNull();
  } finally {
    await first.discardSavedRecording();
    await second.discardSavedRecording();
    await recordingStorage.remove(saved.id);
  }
});

it("rejects orphaned chunks after a recording is removed", async () => {
  await expect(
    recordingStorage.append("missing-recording", 0, new Float32Array([0.25])),
  ).rejects.toBeDefined();
  expect((await recordingStorage.audio("missing-recording")).size).toBe(0);
});
