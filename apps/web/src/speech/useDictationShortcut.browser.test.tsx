import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef, useRef, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useDictationShortcut, type DictationKeyHandlers } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    selector?: (value: { voiceShortcutMode: "toggle" | "hold" | "auto" }) => unknown,
  ) => (selector ? selector({ voiceShortcutMode: settings.mode }) : settings.mode),
}));
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

type ShortcutInput = Parameters<typeof useDictationShortcut>[0];

function Probe({
  speech,
  targetRef,
  subscribeKeys,
}: {
  speech: ShortcutInput["speech"];
  targetRef?: RefObject<HTMLElement | null>;
  subscribeKeys?: ShortcutInput["subscribeKeys"];
}) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    ...(targetRef ? { targetRef } : {}),
    ...(subscribeKeys ? { subscribeKeys, ownsFocus: () => true } : {}),
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

function actions(available: boolean, mode: typeof settings.mode = "hold") {
  settings.mode = mode;
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

it.each([
  { mode: "hold", heldMs: 0, stops: 1 },
  { mode: "auto", heldMs: 300, stops: 1 },
  { mode: "auto", heldMs: 299, stops: 0 },
] as const)(
  "ends a $mode press held $heldMs ms when a chord modifier is released without the letter keyup",
  async ({ mode, heldMs, stops }) => {
    const speech = actions(true, mode);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using _screen = await render(<Probe speech={speech} />);
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    press();
    clock.mockReturnValue(heldMs);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltLeft" }));
    await speech.start.mock.results[0]?.value;
    expect(speech.stop).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft" }));
    await speech.start.mock.results[0]?.value;
    expect(speech.stop).toHaveBeenCalledTimes(stops);
  },
);

const escape = () =>
  new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });

const recording = () => ({
  ...actions(true),
  state: { phase: "recording" as const, error: null, errorAction: null },
});

it("lets Escape in another dictation editor reach that editor instead of canceling the recording", async () => {
  const speech = recording();
  const commentRef = createRef<HTMLTextAreaElement>();
  const editorEscape = vi.fn();
  await using screen = await render(
    <>
      <Probe speech={speech} />
      <Probe speech={actions(true)} targetRef={commentRef} />
      <div
        role="dialog"
        aria-label="Edit citation comment"
        onKeyDown={(event) => {
          if (event.key === "Escape") editorEscape();
        }}
      >
        <textarea aria-label="Comment" ref={commentRef} />
        <button type="button">Cancel</button>
      </div>
    </>,
  );
  for (const control of [
    screen.getByRole("textbox", { name: "Comment" }).element(),
    screen.getByRole("button", { name: "Cancel" }).element(),
  ]) {
    if (!(control instanceof HTMLElement)) throw new Error("expected a comment editor control");
    control.focus();
    control.dispatchEvent(escape());
  }
  expect(speech.cancel).not.toHaveBeenCalled();
  expect(editorEscape).toHaveBeenCalledTimes(2);
});

it("lets Escape in another editor of the recording editor's dialog reach that editor", async () => {
  const speech = recording();
  const replyRef = createRef<HTMLTextAreaElement>();
  const otherReplyRef = createRef<HTMLTextAreaElement>();
  await using screen = await render(
    <>
      <Probe speech={speech} targetRef={replyRef} />
      <Probe speech={actions(true)} targetRef={otherReplyRef} />
      <div role="dialog" aria-label="Pull request">
        <textarea aria-label="Reply A" ref={replyRef} />
        <textarea aria-label="Reply B" ref={otherReplyRef} />
      </div>
    </>,
  );
  const other = screen.getByRole("textbox", { name: "Reply B" }).element();
  if (!(other instanceof HTMLElement)) throw new Error("expected a reply editor");
  other.focus();
  other.dispatchEvent(escape());
  expect(speech.cancel).not.toHaveBeenCalled();
});

it("cancels the recording on Escape outside other shown dictation editors", async () => {
  const speech = recording();
  const reviewRef = createRef<HTMLTextAreaElement>();
  const commentRef = createRef<HTMLTextAreaElement>();
  await using screen = await render(
    <>
      <Probe speech={speech} targetRef={reviewRef} />
      <Probe speech={actions(true)} targetRef={commentRef} />
      <input aria-label="Search" />
      <div role="dialog" aria-label="Pull request">
        <textarea aria-label="Review" ref={reviewRef} />
        <div hidden>
          <textarea aria-label="Comment" ref={commentRef} />
        </div>
        <button type="button">Submit</button>
      </div>
    </>,
  );
  for (const control of [
    screen.getByRole("textbox", { name: "Search" }).element(),
    screen.getByRole("button", { name: "Submit" }).element(),
  ]) {
    if (!(control instanceof HTMLElement)) throw new Error("expected a focusable control");
    control.focus();
    control.dispatchEvent(escape());
  }
  expect(speech.cancel).toHaveBeenCalledTimes(2);
});

it.each([
  ["another editor is recording", false],
  ["the preview itself is recording", true],
])(
  "routes Escape relayed from the preview guest to the preview when %s",
  async (_name, previewRecords) => {
    const composer = previewRecords ? actions(true) : recording();
    const preview = previewRecords ? recording() : actions(true);
    let relayed: DictationKeyHandlers | undefined;
    await using _screen = await render(
      <>
        <Probe speech={composer} />
        <Probe
          speech={preview}
          subscribeKeys={(handlers) => {
            relayed = handlers;
            return () => {};
          }}
        />
      </>,
    );
    relayed?.keydown(escape());
    expect(composer.cancel).not.toHaveBeenCalled();
    expect(preview.cancel).toHaveBeenCalledTimes(previewRecords ? 1 : 0);
  },
);
