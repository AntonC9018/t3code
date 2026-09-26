import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { loadOpenVinoSpeechModel, openVinoSpeechUrl } from "./openvino.ts";

afterEach(() => vi.unstubAllGlobals());

describe("OpenVINO speech server", () => {
  it("accepts only loopback HTTP origins", () => {
    expect(openVinoSpeechUrl("http://127.0.0.1:8001/")?.origin).toBe("http://127.0.0.1:8001");
    expect(openVinoSpeechUrl(undefined)).toBeNull();
    expect(() => openVinoSpeechUrl("http://192.168.1.10:8001/")).toThrow();
    expect(() => openVinoSpeechUrl("http://127.0.0.1:8001/other")).toThrow();
  });

  it("uploads 16 kHz mono WAV and returns the server transcript", async () => {
    let upload: FormData | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options?: RequestInit) => {
        if (options?.method !== "POST") return new Response("ready");
        upload = options.body as FormData;
        return Response.json({ text: "Spoken text.", language: "en" });
      }),
    );
    const model = await loadOpenVinoSpeechModel(
      new URL("http://127.0.0.1:8001/"),
      new AbortController().signal,
    );
    const result = await model.transcribe(new Float32Array([0, 1, -1, 2, -2]), {
      timestamps: "none",
      language: "en",
    });
    expect(result.text).toBe("Spoken text.");
    expect([...upload!.keys()]).toEqual(["model", "language", "audio"]);
    expect(upload!.get("model")).toBe("base");
    expect(upload!.get("language")).toBe("en");
    const audio = upload!.get("audio");
    expect(audio).toBeInstanceOf(Blob);
    const bytes = await (audio as Blob).arrayBuffer();
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(-32_768);
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(view.getInt16(52, true)).toBe(-32_768);
    await model.dispose();
  });

  it("stops an in-flight upload when the model is disposed", async () => {
    const uploadStarted = Promise.withResolvers<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options?: RequestInit) => {
        if (options?.method !== "POST") return new Response("ready");
        uploadStarted.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      }),
    );
    const model = await loadOpenVinoSpeechModel(
      new URL("http://127.0.0.1:8001/"),
      new AbortController().signal,
    );
    const pending = model.transcribe(new Float32Array([0.25]), { timestamps: "none" });
    await uploadStarted.promise;
    await model.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
