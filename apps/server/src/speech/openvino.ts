// @effect-diagnostics globalFetch:off - the configured speech server is local to this environment.
import * as Schema from "effect/Schema";

const OpenVinoTranscript = Schema.Struct({ text: Schema.String });
const isOpenVinoTranscript = Schema.is(OpenVinoTranscript);

export function openVinoSpeechUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "T3_SPEECH_OPENVINO_URL must be a loopback HTTP origin, such as http://127.0.0.1:8001.",
    );
  }
  return url;
}

export async function isOpenVinoSpeechReady(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

function encodeWav(pcm: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.charCodeAt(index);
  };
  label(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767),
      true,
    );
  }
  return bytes;
}

export async function loadOpenVinoSpeechModel(url: URL, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!(await isOpenVinoSpeechReady(url)))
    throw new Error(`OpenVINO speech server is unavailable at ${url.origin}.`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return {
    backend: "openvino-gpu",
    supportsStreaming: false,
    supportsInitialPrompt: false,
    begin: async (_language?: string) => {
      throw new Error("The OpenVINO speech server does not stream transcripts.");
    },
    feed: async (_pcm: Float32Array) => {
      throw new Error("The OpenVINO speech server does not stream transcripts.");
    },
    finish: async () => {
      throw new Error("The OpenVINO speech server does not stream transcripts.");
    },
    reset: async () => undefined,
    transcribe: async (
      pcm: Float32Array,
      options: {
        readonly timestamps: "none";
        readonly language?: string;
        readonly family?: { readonly kind: "whisper"; readonly initialPrompt: string };
      },
    ) => {
      controller.signal.throwIfAborted();
      const form = new FormData();
      form.append("model", "base");
      form.append("language", options.language ?? "auto");
      form.append("audio", new Blob([encodeWav(pcm)], { type: "audio/wav" }), "recording.wav");
      const response = await fetch(new URL("transcribe", url), {
        method: "POST",
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      });
      if (!response.ok) throw new Error(`OpenVINO transcription failed (HTTP ${response.status}).`);
      const payload: unknown = await response.json();
      if (!isOpenVinoTranscript(payload))
        throw new Error("OpenVINO transcription returned an invalid response.");
      return { text: payload.text };
    },
    dispose: async () => {
      signal.removeEventListener("abort", stop);
      controller.abort();
    },
  };
}
