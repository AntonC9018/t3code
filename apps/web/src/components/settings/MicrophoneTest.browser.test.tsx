import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { MicrophoneTest } from "./MicrophoneTest";

const stopTrack = vi.fn();
const closeContext = vi.fn(async () => {});
const getUserMedia = vi.fn();
const stream = {
  getTracks: () => [{ stop: stopTrack }],
  getAudioTracks: () => [{ addEventListener: vi.fn() }],
};
let recorder: TestRecorder;

class TestRecorder extends EventTarget {
  state = "inactive";
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable");
    Object.assign(event, { data: new Blob(["audio"], { type: this.mimeType }) });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}

// Replaces the recording globals for one test. Each stub restores its own global on dispose.
function stubRecordingGlobals(): Disposable {
  const stubs: Disposable[] = [
    stubGlobal("navigator", { mediaDevices: { getUserMedia } }),
    stubGlobal("MediaRecorder", function () {
      recorder = new TestRecorder();
      return recorder;
    }),
    stubGlobal(
      "AudioContext",
      class {
        createAnalyser() {
          return {
            fftSize: 256,
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1),
          };
        }
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
        resume() {
          return Promise.resolve();
        }
        close = closeContext;
      },
    ),
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"),
    vi.spyOn(URL, "revokeObjectURL"),
  ];
  return {
    [Symbol.dispose]: () => {
      for (const stub of stubs.reverse()) stub[Symbol.dispose]();
    },
  };
}

// Module-level mocks outlive each test, so every test starts from the same state.
function resetFakes() {
  vi.clearAllMocks();
  getUserMedia.mockReset().mockResolvedValue(stream);
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it("records the selected mic, stops after ten seconds, and discards playback on retry", async () => {
  resetFakes();
  using _globals = stubRecordingGlobals();
  using _timers = fakeTimers();
  await using screen = await render(<MicrophoneTest microphoneId="selected" />, {
    router: false,
  });
  const { container } = screen;
  await click(container, "Test mic");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "selected" } } });
  await act(async () => {
    vi.advanceTimersByTime(4_000);
  });
  expect(container.querySelector("meter")!.value).toBeGreaterThan(0);
  expect(container.querySelector('[aria-label="Recording time"]')!.textContent).toBe("0:04 / 0:10");
  await act(async () => {
    vi.advanceTimersByTime(6_000);
  });
  expect(container.querySelector("audio")!.getAttribute("src")).toBe("blob:test");
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  await click(container, "Try again");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelectorAll("audio")).toHaveLength(0);
  expect(recorder.state).toBe("recording");
  await screen.unmount();
  expect(recorder.state).toBe("inactive");
  expect(stopTrack).toHaveBeenCalledTimes(2);
});

it("releases a microphone granted after leaving the page", async () => {
  resetFakes();
  using _globals = stubRecordingGlobals();
  let grant!: (value: typeof stream) => void;
  getUserMedia.mockReturnValue(
    new Promise<typeof stream>((resolve) => {
      grant = resolve;
    }),
  );
  await using screen = await render(<MicrophoneTest microphoneId="" />, { router: false });
  await click(screen.container, "Test mic");
  await screen.unmount();
  await act(async () => grant(stream));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).not.toHaveBeenCalled();
});

it("shows permission failures and lets the user try again", async () => {
  resetFakes();
  using _globals = stubRecordingGlobals();
  getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
  await using screen = await render(<MicrophoneTest microphoneId="" />, { router: false });
  const { container } = screen;
  await click(container, "Test mic");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Microphone access is required for voice input. Allow access in your browser or system settings and try again.",
  );
  await click(container, "Record again");
  expect(recorder.state).toBe("recording");
  await click(container, "Stop recording");
  await click(container, "Done");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelectorAll("audio")).toHaveLength(0);
});
