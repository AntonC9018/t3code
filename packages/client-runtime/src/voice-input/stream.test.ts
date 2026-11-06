import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { SPEECH_STREAM_MAX_QUEUED_BYTES, type SpeechStreamEvent } from "@t3tools/contracts";
import { openSpeechStream } from "./stream.ts";

class TestSocket extends EventTarget {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  receive(event: SpeechStreamEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

function connect(bufferedAudio?: Float32Array, canSend = () => true) {
  const socket = new TestSocket();
  const abort = new AbortController();
  const onText = vi.fn();
  const onError = vi.fn();
  const stream = openSpeechStream({
    url: "wss://environment.test/ws/voice",
    options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    signal: abort.signal,
    canSend,
    onText,
    onError,
    createSocket: () => socket as unknown as WebSocket,
  });
  socket.dispatchEvent(new Event("open"));
  expect(JSON.parse(socket.sent.shift() as string)).toEqual({
    type: "start",
    options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  });
  if (bufferedAudio) {
    stream.feed(bufferedAudio);
    expect(socket.sent).toHaveLength(0);
  }
  socket.receive({ type: "ready" });
  return { socket, abort, onText, onError, stream };
}

it("drains ordered PCM before finishing and replaces tentative hypotheses", async () => {
  const { socket, stream, onText } = connect(new Float32Array([0.1]));
  stream.feed(new Float32Array([0.2]));
  const final = stream.finish();
  expect(socket.sent).toHaveLength(2);
  socket.receive({ type: "update", revision: 1, text: { committed: "hello ", tentative: "were" } });
  expect(socket.sent).toHaveLength(2);
  expect(new Float32Array((socket.sent[1] as Uint8Array).slice().buffer)[0]).toBeCloseTo(0.2);
  socket.receive({
    type: "update",
    revision: 2,
    text: { committed: "hello ", tentative: "world" },
  });
  expect(socket.sent[2]).toBe('{"type":"finish"}');
  expect(onText.mock.calls.map(([text]) => text)).toEqual([
    { committed: "hello ", tentative: "were" },
    { committed: "hello ", tentative: "world" },
  ]);
  socket.receive({ type: "finished", text: "hello world" });
  await expect(final).resolves.toBe("hello world");
  expect(socket.closed).toBe(true);
});

it("drains more than five minutes of audio across acknowledgements", async () => {
  const { socket, stream } = connect();
  const seconds = 301;
  let acknowledgedBytes = 0;
  let firstSample = 0;
  let lastSample = 0;
  for (let second = 0; second < seconds; second++) {
    const value = (second + 1) / seconds;
    stream.feed(new Float32Array(16_000).fill(value));
    const frame = socket.sent.at(-1);
    expect(frame).toBeInstanceOf(Uint8Array);
    const bytes = frame as Uint8Array;
    acknowledgedBytes += bytes.byteLength;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (second === 0) firstSample = view.getFloat32(0, true);
    lastSample = view.getFloat32(bytes.byteLength - 4, true);
    socket.receive({ type: "update", revision: second + 1, text: null });
  }
  expect(acknowledgedBytes).toBe(seconds * 16_000 * 4);
  expect(firstSample).toBeCloseTo(1 / seconds);
  expect(lastSample).toBeCloseTo(1);
  const final = stream.finish();
  expect(socket.sent.at(-1)).toBe('{"type":"finish"}');
  socket.receive({ type: "finished", text: "dictated" });
  await expect(final).resolves.toBe("dictated");
});

it("coalesces queued audio into fewer inference frames", async () => {
  const { socket, stream, abort } = connect();
  stream.feed(new Float32Array([0.1]));
  stream.feed(new Float32Array([0.2]));
  stream.feed(new Float32Array([0.3]));
  stream.feed(new Float32Array([0.4]));
  expect(socket.sent).toHaveLength(2);
  socket.receive({ type: "update", revision: 1, text: null });

  expect(socket.sent).toHaveLength(3);
  const queued = new Float32Array((socket.sent[2] as Uint8Array).slice().buffer);
  expect(queued).toHaveLength(2);
  expect(queued[0]).toBeCloseTo(0.3);
  expect(queued[1]).toBeCloseTo(0.4);
  abort.abort();
});

it("caps buffered audio when inference falls behind without imposing a recording duration limit", async () => {
  const { socket, stream, onError } = connect();
  stream.feed(new Float32Array(SPEECH_STREAM_MAX_QUEUED_BYTES / 4 + 1));
  await expect(stream.finish()).rejects.toThrow("cannot keep up with buffered microphone audio");
  expect(onError).toHaveBeenCalledOnce();
  expect(socket.sent).toHaveLength(0);
  expect(socket.closed).toBe(true);
});

it.each(["cancel", "revoke"])("does not send queued frames after %s", async (action) => {
  let allowed = true;
  const { socket, stream, abort, onText } = connect(undefined, () => allowed);
  stream.feed(new Float32Array([0.1]));
  stream.feed(new Float32Array([0.2]));
  stream.feed(new Float32Array([0.3]));
  if (action === "cancel") abort.abort();
  else allowed = false;
  socket.receive({ type: "update", revision: 1, text: { committed: "late", tentative: "" } });
  expect(socket.sent).toHaveLength(2);
  expect(onText).not.toHaveBeenCalled();
  await expect(stream.finish()).rejects.toThrow(action === "cancel" ? "cancelled" : "revoked");
});

it("fails on disconnect and times out stalled inference", async () => {
  vi.useFakeTimers();
  try {
    const first = connect();
    first.socket.close();
    await expect(first.stream.finish()).rejects.toThrow("connection closed");
    const second = connect();
    second.stream.feed(new Float32Array([0.1]));
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(second.stream.finish()).rejects.toThrow("stopped responding");
    expect(second.socket.closed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("times out when the last pipelined chunk never receives an acknowledgement", async () => {
  vi.useFakeTimers();
  try {
    const { socket, stream } = connect();
    stream.feed(new Float32Array([0.1]));
    stream.feed(new Float32Array([0.2]));
    socket.receive({ type: "update", revision: 1, text: null });
    const final = stream.finish();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(final).rejects.toThrow("stopped responding");
  } finally {
    vi.useRealTimers();
  }
});
