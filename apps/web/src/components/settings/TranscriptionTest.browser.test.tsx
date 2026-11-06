import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { createBrowserVoiceInputPlatform } from "../../speech/browserVoiceInput";
import { TranscriptionTest } from "./TranscriptionTest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  record: vi.fn(),
  stop: vi.fn(async () => {}),
  release: vi.fn(),
  remove: vi.fn(),
  transcribe: vi.fn(),
  platform: vi.fn(),
}));
vi.mock(import("../../speech/browserVoiceInput"), () => ({
  createBrowserVoiceInputPlatform: (
    input: Parameters<typeof createBrowserVoiceInputPlatform>[0],
  ) => {
    mocks.platform(input);
    return {
      recorder: {
        uri: "blob:pcm",
        prepareToRecordAsync: async () => {},
        record: mocks.record,
        stop: mocks.stop,
      },
      transcriber: { prepare: mocks.prepare },
      cancelRecording: mocks.release,
      deleteRecording: mocks.remove,
    } as never;
  },
}));
vi.mock(import("../chat/ComposerSpeechButton"), () => ({
  ComposerSpeechRecordingPill: ({
    state,
    onStart,
    onStop,
    onCancel,
  }: {
    state: { phase: string; error: string | null };
    onStart(): void;
    onStop(): void;
    onCancel(): void;
  }) => (
    <div>
      {state.phase === "error" ? <span role="status">{state.error}</span> : null}
      <button onClick={state.phase === "error" ? onStart : onStop}>
        {state.phase === "error" ? "Retry" : "Stop"}
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

const prepared = {} as PreparedConnection;

// Module-level mocks outlive each test, so every test starts from the same state.
function resetFakes() {
  vi.resetAllMocks();
}

function mount() {
  mocks.prepare.mockResolvedValue({ locale: "en", transcribe: mocks.transcribe });
  return render(
    <TranscriptionTest
      prepared={prepared}
      hasAudioConsent={() => true}
      options={DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS}
      microphoneId="mic"
      modelName="Test model"
      disabled={false}
    />,
    { router: false },
  );
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

const result = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-label="Test transcription"]');

it("transcribes a ten-second test through the voice controller and clears the result on Done", async () => {
  resetFakes();
  mocks.transcribe.mockResolvedValue("A model test.");
  await using screen = await mount();
  const { container } = screen;
  await click(container, "Test model");
  expect(mocks.record).toHaveBeenCalledWith({ forDuration: 10 });
  await click(container, "Stop");
  expect(mocks.transcribe).toHaveBeenCalledWith("blob:pcm", { signal: expect.any(AbortSignal) });
  expect(result(container)!.textContent).toBe("A model test.");
  expect(mocks.remove).toHaveBeenCalledWith("blob:pcm");
  await click(container, "Done");
  expect(result(container)).toBeNull();
});

it("cancels recording without transcribing", async () => {
  resetFakes();
  await using screen = await mount();
  const { container } = screen;
  await click(container, "Test model");
  await click(container, "Cancel");
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalled();
  expect(result(container)).toBeNull();
});

it("shows transcription errors and allows another test", async () => {
  resetFakes();
  mocks.transcribe.mockRejectedValueOnce(new Error("Model failed"));
  await using screen = await mount();
  const { container } = screen;
  await click(container, "Test model");
  await click(container, "Stop");
  expect(container.querySelector('[role="status"]')!.textContent).toBe(
    "Could not transcribe this recording.",
  );
  mocks.transcribe.mockResolvedValue("Try again.");
  await click(container, "Retry");
  expect(result(container)!.textContent).toBe("Try again.");
});

it("shows live streaming text and finishes through the streaming session", async () => {
  resetFakes();
  await using screen = await mount();
  const { container } = screen;
  const finish = vi.fn(async () => "Finished streaming text.");
  mocks.prepare.mockResolvedValue({
    locale: "en",
    transcribe: mocks.transcribe,
    streaming: { finish },
  });
  await click(container, "Test model");
  const input = mocks.platform.mock.calls[0]?.[0] as Parameters<
    typeof createBrowserVoiceInputPlatform
  >[0];
  await act(async () => input.onText({ committed: "Live ", tentative: "text" }));
  expect(
    [...result(container)!.querySelectorAll("span")].map((span) => span.textContent).join(""),
  ).toBe("Live text");
  await click(container, "Stop");
  expect(finish).toHaveBeenCalled();
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(result(container)!.textContent).toBe("Finished streaming text.");
});
