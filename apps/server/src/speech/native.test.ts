// @effect-diagnostics nodeBuiltinImport:off - verifies isolated native worker processes and their exit events.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import { listNativeSpeechGpuDevices, loadNativeSpeechModel } from "./native.ts";

vi.mock("node:sea", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeSea>();
  return { ...actual, isSea: vi.fn(actual.isSea) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it("ignores unrelated device probe messages and returns GPU devices", async () => {
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    process.send?.({ type: "unrelated-control-message" });
    export const getAvailableBackends = () => [
      { kind: "vulkan", deviceType: "gpu", deviceId: "gpu-1", name: "GPU", description: "Test GPU" },
      { kind: "cpu", deviceType: "cpu", deviceId: null, name: "CPU", description: "CPU" },
    ];
  `)}`;
  await expect(listNativeSpeechGpuDevices(moduleUrl)).resolves.toEqual([
    { id: '["vulkan","gpu-1"]', name: "Test GPU" },
  ]);
});

const fixture = (transcribe: string, maxAudioMs = 0, supportsVocabulary = false) =>
  `data:text/javascript,${encodeURIComponent(`export const TranscribeModel = { load: async () => ({ capabilities: { supportsStreaming: false, maxAudioMs: ${maxAudioMs} }, supports: (feature) => feature === "vocabulary" && ${supportsVocabulary}, transcribe: ${transcribe} }) };`)}`;

it("transcribes a five-minute clip in bounded pieces without dropping samples", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture(
      `async (pcm) => {
      if (pcm.length > 388000) throw new Error("oversized call");
      return { text: String(pcm.reduce((sum, sample) => sum + sample, 0)) };
    }`,
      48500,
    ),
  );
  try {
    const pcm = new Float32Array(16000 * 300).fill(1);
    const result = await model.transcribe(pcm, { timestamps: "none" }, false);
    expect(
      result.text
        .split(" ")
        .map(Number)
        .reduce((sum, value) => sum + value, 0),
    ).toBe(pcm.length);
    expect(result.text.split(" ").length).toBeGreaterThan(1);
  } finally {
    await model.dispose();
  }
});

it.each(["OutputTruncated", "InputTooLong"])(
  "retries %s pieces instead of returning partial text",
  async (name) => {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      fixture(`async (pcm) => {
      if (pcm.length > 4000) {
        const error = new (class ${name} extends Error {})();
        error.partialResult = { text: "incomplete" };
        throw error;
      }
      return { text: String(pcm.length) };
    }`),
    );
    try {
      expect(
        await model.transcribe(new Float32Array(16000), { timestamps: "none" }, false),
      ).toEqual({
        text: "4000 4000 4000 4000",
      });
    } finally {
      await model.dispose();
    }
  },
);

it("uses the binding's Vulkan-safe Koffi stack in the speech worker", async () => {
  const koffiPath = NodeModule.createRequire(import.meta.resolve("transcribe-cpp")).resolve(
    "koffi",
  );
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    await import(${JSON.stringify(import.meta.resolve("transcribe-cpp"))});
    import { createRequire } from "node:module";
    const koffi = createRequire(${JSON.stringify(koffiPath)})(${JSON.stringify(koffiPath)});
    export const TranscribeModel = { load: async () => ({
      backend: String(koffi.config().async_stack_size),
      capabilities: { supportsStreaming: false },
      supports: () => false,
    }) };
  `)}`;
  const model = await loadNativeSpeechModel("unused.gguf", new AbortController().signal, moduleUrl);
  try {
    expect(Number(model.backend)).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  } finally {
    await model.dispose();
  }
});

const fixtureWithUnrelatedIpcMessage = () =>
  `data:text/javascript,${encodeURIComponent(`
    process.send?.({ type: "unrelated-control-message" });
    export const TranscribeModel = {
      load: async () => ({ capabilities: { supportsStreaming: false }, supports: () => false, transcribe: async () => ({ text: "hello" }) }),
    };
  `)}`;

const streamingFixture = (feed: string, supportsVocabulary = false) =>
  `data:text/javascript,${encodeURIComponent(`
  export const TranscribeModel = { load: async () => ({
    capabilities: { supportsStreaming: true },
    supports: (feature) => feature === "vocabulary" && ${supportsVocabulary},
    createSession: () => ({
      dispose() {},
      stream: async (opts) => ({
        feed: ${feed},
        finalize: async () => {},
        text: { full: opts.vocabulary?.join(" / ") ?? opts.language ?? "hello world", committed: "hello ", tentative: "world" },
        reset() {},
      }),
    }),
  }) };
`)}`;

it("returns transcription from an isolated process and disposes it", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixture("async (pcm) => ({ text: String(pcm[0]) })"),
  );
  try {
    expect(
      await model.transcribe(
        new Float32Array([0.25]),
        { timestamps: "none", language: "en" },
        false,
      ),
    ).toEqual({ text: "0.25" });
  } finally {
    await model.dispose();
  }
});

it("probes generic vocabulary support and delivers ordered terms to offline inference", async () => {
  for (const supported of [false, true]) {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      fixture("async (_pcm, options) => ({ text: JSON.stringify(options) })", 0, supported),
    );
    try {
      expect(model.supportsVocabulary).toBe(supported);
      const options = {
        timestamps: "none" as const,
        language: "en",
        ...(supported ? { vocabulary: ["T3 Code", "GitHub"] } : {}),
      };
      const result = await model.transcribe(new Float32Array([0.25]), options, false);
      expect(JSON.parse(result.text)).toEqual(options);
    } finally {
      await model.dispose();
    }
  }
});

it("ignores IPC messages that do not belong to the speech protocol", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    fixtureWithUnrelatedIpcMessage(),
  );
  try {
    await expect(
      model.transcribe(new Float32Array([0.25]), { timestamps: "none", language: "en" }, false),
    ).resolves.toEqual({ text: "hello" });
  } finally {
    await model.dispose();
  }
});

it("terminates hung native inference when the service shuts down", async () => {
  const controller = new AbortController();
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    controller.signal,
    fixture("async () => { while (true) {} }"),
  );
  const pending = model.transcribe(
    new Float32Array([0.25]),
    {
      timestamps: "none",
      language: "en",
    },
    false,
  );
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await model.dispose();
  await rejected;
});

it("returns streaming previews and final text from an isolated process", async () => {
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(
      "async () => ({ revision: 1, committedChanged: true, tentativeChanged: true })",
      true,
    ),
  );
  try {
    expect(model.supportsStreaming).toBe(true);
    await model.begin({ timestamps: "none" }, false);
    expect(await model.feed(new Float32Array(512).fill(0.25))).toEqual({
      revision: 1,
      text: { committed: "hello ", tentative: "world" },
    });
    expect(await model.finish()).toBe("hello world");
    await model.begin({ timestamps: "none", language: "fr" }, false);
    await model.reset();
    await model.begin({ timestamps: "none", language: "fr" }, false);
    await model.feed(new Float32Array(512));
    expect(await model.finish()).toBe("fr");
    await model.begin(
      { timestamps: "none", language: "fr", vocabulary: ["T3 Code", "GitHub"] },
      false,
    );
    await model.feed(new Float32Array(512).fill(0.25));
    expect(await model.finish()).toBe("T3 Code / GitHub");
  } finally {
    await model.dispose();
  }
});

it("kills a hung streaming feed without waiting for native cleanup", async () => {
  const controller = new AbortController();
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    controller.signal,
    streamingFixture("async () => { while (true) {} }"),
  );
  await model.begin({ timestamps: "none" }, false);
  const rejected = expect(model.feed(new Float32Array(512).fill(0.25))).rejects.toThrow();
  controller.abort();
  await model.dispose();
  await rejected;
});

it("terminates a GPU probe after returning its devices", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  let exited: Promise<void> | undefined;
  const probe = vi.spyOn(NodeChildProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    exited = new Promise((resolve) => child.once("exit", () => resolve()));
    return child;
  });
  try {
    const moduleUrl = `data:text/javascript,${encodeURIComponent("export const getAvailableBackends = () => [];")}`;
    await expect(listNativeSpeechGpuDevices(moduleUrl)).resolves.toEqual([]);
    await exited;
  } finally {
    probe.mockRestore();
  }
});

it("times out and terminates a GPU probe that never replies", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  let exited: Promise<void> | undefined;
  const probe = vi.spyOn(NodeChildProcess, "spawn").mockImplementation((...args) => {
    const child = spawn(...args);
    exited = new Promise((resolve) => child.once("exit", () => resolve()));
    return child;
  });
  vi.useFakeTimers();
  try {
    const moduleUrl = `data:text/javascript,${encodeURIComponent("await new Promise(() => {}); export const getAvailableBackends = () => [];")}`;
    const rejected = expect(listNativeSpeechGpuDevices(moduleUrl)).rejects.toThrow(
      "Speech device discovery timed out.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await exited;
  } finally {
    vi.useRealTimers();
    probe.mockRestore();
  }
});

it.each(["t three code", "t 3 code"])(
  "matches %s across committed increments and resets dictionaries",
  async (phrase) => {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      streamingFixture(`async function (pcm) {
      this.text.committed = pcm[0] === 1 ? "open t " : "open ${phrase}";
      this.text.tentative = "";
      this.text.full = this.text.committed;
      return { revision: pcm[0], committedChanged: true };
    }`),
    );
    try {
      await model.begin({ timestamps: "none" }, false, undefined, {
        customWords: ["T3 Code"],
        dictionary: [{ term: "T3 Code", aliases: ["t three code"] }],
      });
      await model.feed(new Float32Array(512).fill(1));
      expect((await model.feed(new Float32Array(512).fill(0.5))).text?.committed).toBe(
        "open T3 Code",
      );
      expect(await model.finish()).toBe("open T3 Code");
      await model.begin({ timestamps: "none" }, false);
      expect((await model.feed(new Float32Array(512).fill(0.5))).text?.committed).toBe(
        `open ${phrase}`,
      );
      await model.reset();
    } finally {
      await model.dispose();
    }
  },
);

it("honors exact aliases and phrase boundaries while correcting streamed text", async () => {
  const spoken =
    'a test with a i and ay eye. Robert, Roberts. "the publisher" and the publisher. (git hub), git (hub). ' +
    "git hub's API, git hub’s API, git’s hub, mac donald's menu, king's cross.";
  const dictionary = [
    { term: "AI", aliases: ["ay eye"] },
    { term: "Bob", aliases: ["Robert"] },
    { term: "Roberts", aliases: [] },
    { term: "O'Reilly", aliases: ['"the publisher"'] },
    { term: "GitHub", aliases: [] },
    { term: "McDonald’s", aliases: [] },
    { term: "King’s Cross", aliases: [] },
  ];
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture("async () => ({ revision: 1, committedChanged: true })"),
  );
  try {
    await model.begin({ timestamps: "none", language: spoken }, false, undefined, {
      customWords: dictionary.map(({ term }) => term),
      dictionary,
    });
    await model.feed(new Float32Array(512).fill(0.25));
    expect(await model.finish()).toBe(
      "a test with AI and AI. Bob, Roberts. O'Reilly and the publisher. (GitHub), git (hub). " +
        "GitHub's API, GitHub’s API, git’s hub, McDonald’s menu, King’s Cross.",
    );
  } finally {
    await model.dispose();
  }
});

it("serves HTTP requests while the child corrects a large streaming transcript", async () => {
  const server = NodeHttp.createServer((_request, response) => response.end("responsive"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const model = await loadNativeSpeechModel(
    "unused.gguf",
    new AbortController().signal,
    streamingFixture(`async function () {
      this.text.committed = "dictionary ".repeat(1200);
      process.send({ type: "correction-starting" });
      return { revision: 1, committedChanged: true };
    }`),
  );
  try {
    const child = vi.mocked(NodeChildProcess.spawn).mock.results.at(-1)?.value;
    if (!child) throw new Error("Missing inference child");
    const started = new Promise<void>((resolve) =>
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "correction-starting"
        )
          resolve();
      }),
    );
    await model.begin({ timestamps: "none" }, false, undefined, {
      customWords: Array.from({ length: 100 }, (_, index) => `dictionary${index}`),
      dictionary: [],
    });
    let finished = false;
    const feeding = model.feed(new Float32Array(512)).then((result) => {
      finished = true;
      return result;
    });
    await started;
    const response = await new Promise<string>((resolve, reject) => {
      NodeHttp.get(`http://127.0.0.1:${address.port}`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      }).on("error", reject);
    });
    expect(response).toBe("responsive");
    expect(finished).toBe(false);
    expect((await feeding).text?.committed).toContain("dictionary");
  } finally {
    await model.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("discovers devices through the executable worker subcommand", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  const sea = vi.mocked(NodeSea.isSea).mockReturnValue(true);
  const worker = vi
    .spyOn(NodeChildProcess, "spawn")
    .mockImplementation((command, args, options) => {
      expect(args?.slice(0, 2)).toEqual(["__speech-worker", "discover"]);
      return spawn(
        command,
        [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), ...args!],
        options,
      );
    });
  try {
    const moduleUrl = `data:text/javascript,${encodeURIComponent('export const getAvailableBackends = () => [{ kind: "vulkan", deviceType: "gpu", deviceId: "gpu", name: "Test GPU" }];')}`;
    await expect(listNativeSpeechGpuDevices(moduleUrl)).resolves.toEqual([
      { id: '["vulkan","gpu"]', name: "Test GPU" },
    ]);
  } finally {
    worker.mockRestore();
    sea.mockReturnValue(false);
  }
});

it("transcribes through the executable worker subcommand", async () => {
  const { spawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  const sea = vi.mocked(NodeSea.isSea).mockReturnValue(true);
  const worker = vi
    .spyOn(NodeChildProcess, "spawn")
    .mockImplementation((command, args, options) => {
      expect(args).toEqual(["__speech-worker", "model"]);
      return spawn(
        command,
        [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), ...args!],
        options,
      );
    });
  try {
    const model = await loadNativeSpeechModel(
      "unused.gguf",
      new AbortController().signal,
      fixture("async (pcm) => ({ text: String(pcm[0]) })"),
    );
    try {
      await expect(
        model.transcribe(new Float32Array([0.25]), { timestamps: "none" }, false),
      ).resolves.toEqual({ text: "0.25" });
    } finally {
      await model.dispose();
    }
  } finally {
    worker.mockRestore();
    sea.mockReturnValue(false);
  }
});

it("loads the installed native package for device discovery without an ESM resolver", async () => {
  const devices = await listNativeSpeechGpuDevices();
  expect(Array.isArray(devices)).toBe(true);
});
const vadFixture = ({
  streaming = false,
  failVad = false,
  failVadLoad = false,
  failAsr = false,
  maxAudioMs = 4000,
} = {}) =>
  `data:text/javascript,${encodeURIComponent(`
    const summarize = pcm => String(pcm.length) + ":" + pcm[0].toFixed(2) + ":" + pcm[pcm.length - 1].toFixed(2);
    export const TranscribeModel = { load: async (path, options) => {
      if (path === "vad.gguf") {
        if (${failVadLoad}) throw new Error("VAD unavailable");
        if (options.backend !== "cpu") throw new Error("VAD must use CPU");
        return { vadInfo: { sampleRate: 16000, frameSamples: 512 }, dispose() {},
          createVadSession: ({ nThreads }) => {
            if (nThreads !== 1) throw new Error("VAD thread count");
            let pending = []; let at = 0;
            const score = final => {
              const firstFrame = at;
              const probs = [];
              while (pending.length >= 512 || final && pending.length) {
                probs.push(pending[0] > 0.5 ? 0.9 : 0);
                pending.splice(0, 512); at++;
              }
              return { firstFrame, probs };
            };
            return { dispose() {}, streamReset: async () => { pending = []; at = 0; },
              streamFeed: async pcm => {
                if (${failVad} && pcm[0] < 0) throw new Error("VAD fixture failed");
                pending.push(...pcm); return score(false);
              },
              streamFlush: async () => score(true),
            };
          },
        };
      }
      return { backend: "CPU", supports: () => false,
        capabilities: { supportsStreaming: ${streaming}, maxAudioMs: ${maxAudioMs} },
        transcribe: async pcm => { if (${failAsr}) throw new Error("ASR fixture failed"); return { text: summarize(pcm) }; },
        createSession: () => {
          let all = [];
          return { dispose() {}, stream: async () => ({
            feed: async pcm => { all.push(...pcm); return { committedChanged: true }; },
            finalize: async () => {}, reset() { all = []; },
            get text() { const full = summarize(all); return { committed: full, tentative: "", full }; },
          }) };
        },
      };
    }};
  `)}`;

it("filters silence and preserves partial speech through the production worker and resets between recordings", async () => {
  for (const streaming of [false, true]) {
    const model = await loadNativeSpeechModel(
      "asr.gguf",
      new AbortController().signal,
      vadFixture({ streaming }),
      "cpu",
    );
    try {
      expect(
        await model.transcribe(new Float32Array(2000), { timestamps: "none" }, true, "vad.gguf"),
      ).toEqual({ text: "" });
      expect(
        await model.transcribe(
          new Float32Array([0.8, 0.6]),
          { timestamps: "none" },
          true,
          "vad.gguf",
        ),
      ).toEqual({ text: "2:0.80:0.60" });
      expect(
        await model.transcribe(new Float32Array(2000), { timestamps: "none" }, false, "vad.gguf"),
      ).toEqual({ text: "2000:0.00:0.00" });
      for (const cancel of [true, false]) {
        await model.begin({ timestamps: "none" }, true, "vad.gguf");
        await model.feed(new Float32Array(600));
        expect(await model.finish()).toBe("");
        await model.begin({ timestamps: "none" }, true, "vad.gguf");
        await model.feed(new Float32Array(511).fill(0.8));
        if (cancel) await model.reset();
        else expect(await model.finish()).toBe("511:0.80:0.80");
      }
    } finally {
      await model.dispose();
    }
  }
});

it("decodes complete stable chunks before Stop and returns the ordered final tail", async () => {
  const model = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture(),
    "cpu",
  );
  try {
    await model.begin({ timestamps: "none" }, false, "vad.gguf");
    await model.feed(new Float32Array(16000).fill(0.1));
    await model.feed(new Float32Array(16000).fill(0.2));
    const update = await model.feed(new Float32Array(16000).fill(0.3));
    expect(update.text).toEqual({ committed: "32000:0.10:0.20", tentative: "" });
    await model.feed(new Float32Array([0.4, 0.5]));
    expect(await model.finish()).toBe("32000:0.10:0.20 16002:0.30:0.50");
  } finally {
    await model.dispose();
  }
});

it("preserves withheld audio on VAD failure while keeping ASR failures distinct", async () => {
  for (const streaming of [false, true]) {
    const model = await loadNativeSpeechModel(
      "asr.gguf",
      new AbortController().signal,
      vadFixture({ streaming, failVad: true }),
      "cpu",
    );
    try {
      await model.begin({ timestamps: "none" }, true, "vad.gguf");
      await model.feed(new Float32Array(512).fill(0.1));
      await model.feed(new Float32Array(512).fill(-0.2));
      expect(await model.finish()).toBe("1024:0.10:-0.20");
      await model.begin({ timestamps: "none" }, true, "vad.gguf");
      await model.feed(new Float32Array(512));
      expect(await model.finish()).toBe("");
    } finally {
      await model.dispose();
    }
  }
  const unavailable = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture({ failVadLoad: true }),
    "cpu",
  );
  try {
    expect(
      await unavailable.transcribe(
        new Float32Array(2000).fill(0.1),
        { timestamps: "none" },
        true,
        "vad.gguf",
      ),
    ).toEqual({ text: "2000:0.10:0.10" });
  } finally {
    await unavailable.dispose();
  }
  const model = await loadNativeSpeechModel(
    "asr.gguf",
    new AbortController().signal,
    vadFixture({ failAsr: true }),
    "cpu",
  );
  try {
    await expect(
      model.transcribe(new Float32Array(512).fill(0.8), { timestamps: "none" }, true, "vad.gguf"),
    ).rejects.toThrow("ASR fixture failed");
  } finally {
    await model.dispose();
  }
});
