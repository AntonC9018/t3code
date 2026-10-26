import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { recordingStorage, type SavedVoiceRecording } from "./recordingStorage";

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
