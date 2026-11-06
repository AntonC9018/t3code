import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

import { act, render } from "../../test/render";
import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

const main = {
  available: true,
  state: { phase: "idle", error: null, errorAction: null } as VoiceInputState,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};
const comment = {
  ...main,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};
function Editors({ showComment = true }: { showComment?: boolean }) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: main,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return (
    <>
      <textarea aria-label="Main" />
      {showComment ? <Comment /> : null}
    </>
  );
}
function Comment() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: comment,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: ref,
  });
  return <textarea ref={ref} aria-label="Comment" />;
}
const key = (type: "keydown" | "keyup", value = "d") =>
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key: value,
      code: value === "d" ? "KeyD" : "Escape",
      ctrlKey: value === "d",
      shiftKey: value === "d",
      bubbles: true,
      cancelable: true,
    }),
  );

function resetFakes() {
  settings.mode = "toggle";
  vi.clearAllMocks();
  main.state = { phase: "idle", error: null, errorAction: null };
  comment.state = { phase: "idle", error: null, errorAction: null };
}

it("dictates into the focused comment instead of the main composer", async () => {
  resetFakes();
  await using screen = await render(<Editors />, { router: false });
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(main.start).not.toHaveBeenCalled();
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(main.start).toHaveBeenCalledOnce();
});

it("stops and cancels the recording owner even after focus moves", async () => {
  resetFakes();
  comment.state = { phase: "recording", error: null, errorAction: null };
  await using screen = await render(<Editors />, { router: false });
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
    key("keydown", "Escape");
  });
  expect(comment.stop).toHaveBeenCalledOnce();
  expect(comment.cancel).toHaveBeenCalledOnce();
  expect(main.start).not.toHaveBeenCalled();
});

it("finishes hold dictation on release", async () => {
  resetFakes();
  settings.mode = "hold";
  await using screen = await render(<Editors key={settings.mode} />, { router: false });
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(comment.stop).toHaveBeenCalledOnce();
});

it("does not stop a later session when the editor closes during preparation", async () => {
  resetFakes();
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await using screen = await render(<Editors key={settings.mode} />, { router: false });
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  await screen.rerender(<Editors showComment={false} />);
  await act(async () => resolve());
  expect(comment.stop).not.toHaveBeenCalled();
});

it("does not finish a new recording when a cancelled hold start resolves", async () => {
  resetFakes();
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await using screen = await render(<Editors key={settings.mode} />, { router: false });
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  comment.state = { phase: "preparing", error: null, errorAction: null };
  await act(() => key("keydown", "Escape"));
  comment.state = { phase: "idle", error: null, errorAction: null };
  await act(() => key("keydown"));
  await act(async () => resolve());
  expect(comment.start).toHaveBeenCalledTimes(2);
  expect(comment.cancel).toHaveBeenCalledOnce();
  expect(comment.stop).not.toHaveBeenCalled();
});

function Probe({ speech }: { speech: typeof main }) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return null;
}

const press = (repeat = false) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "D",
      code: "KeyD",
      ctrlKey: !/Mac/i.test(navigator.platform),
      metaKey: /Mac/i.test(navigator.platform),
      shiftKey: true,
      cancelable: true,
      repeat,
    }),
  );

function actions(available: boolean) {
  return {
    available,
    state: { phase: "idle", error: null, errorAction: null } as VoiceInputState,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}

it("leaves the browser shortcut alone when dictation is off", async () => {
  resetFakes();
  settings.mode = "hold";
  const speech = actions(false);
  await using _screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(true);
  expect(speech.start).not.toHaveBeenCalled();
});

it("stops on a new press when the OS omitted keyup, but ignores autorepeat", async () => {
  resetFakes();
  settings.mode = "hold";
  const speech = actions(true);
  await using screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(false);
  expect(speech.start).toHaveBeenCalledOnce();
  await screen.rerender(
    <Probe speech={{ ...speech, state: { ...speech.state, phase: "recording" } }} />,
  );
  press(true);
  expect(speech.stop).not.toHaveBeenCalled();
  press();
  expect(speech.stop).toHaveBeenCalledOnce();
});

it("finishes a released hold after startup even if the chord was pressed again while preparing", async () => {
  resetFakes();
  settings.mode = "hold";
  const speech = actions(true);
  let finishStart!: () => void;
  const startup = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  speech.start.mockReturnValue(startup);
  await using screen = await render(<Probe speech={speech} />);
  press();
  await screen.rerender(
    <Probe speech={{ ...speech, state: { ...speech.state, phase: "preparing" } }} />,
  );
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  press();
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  finishStart();
  await startup;
  expect(speech.start).toHaveBeenCalledOnce();
  expect(speech.stop).toHaveBeenCalledOnce();
});
