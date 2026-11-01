import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { render } from "../../test/render";
import { composerSubmissionIntentForKey } from "../composer-logic";
import { useDictationSubmissionShortcut } from "./useDictationSubmissionShortcut";

vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));

function Probe(props: { preparing?: boolean; onSubmit(intent: string): void }) {
  const formRef = useRef<HTMLFormElement>(null);
  useDictationSubmissionShortcut({
    enabled: !props.preparing,
    formRef,
    onKeyDown: (event) => {
      const intent = composerSubmissionIntentForKey({
        event,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        isSoftwareKeyboardOpen: false,
        isDraftThread: true,
        sendShortcut: "enter",
        prompt: "",
      });
      if (!intent) return;
      event.preventDefault();
      event.stopPropagation();
      props.onSubmit(intent);
    },
  });
  return (
    <form ref={formRef}>
      <div data-testid="composer-editor" contentEditable={false} tabIndex={0}>
        <textarea aria-label="Citation comment" />
      </div>
      <button type="button">Send</button>
    </form>
  );
}

function enter(target: Element, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

it("handles Enter when the frozen composer loses focus to the page", async () => {
  const onSubmit = vi.fn();
  await using screen = await render(<Probe onSubmit={onSubmit} />, { router: false });
  const editor = screen.container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  editor.focus();
  editor.blur();
  expect(document.activeElement).toBe(document.body);
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("foreground");
});

it("handles a focused read-only composer once and leaves Shift+Enter alone", async () => {
  const onSubmit = vi.fn();
  await using screen = await render(<Probe onSubmit={onSubmit} />, { router: false });
  const editor = screen.container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  expect(enter(editor, true).defaultPrevented).toBe(false);
  expect(enter(editor).defaultPrevented).toBe(true);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("foreground");
});

it("does not intercept citation fields, buttons, or other editors", async () => {
  const onSubmit = vi.fn();
  await using screen = await render(<Probe onSubmit={onSubmit} />, { router: false });
  const other = document.createElement("textarea");
  document.body.append(other);
  try {
    expect(enter(other).defaultPrevented).toBe(false);
    expect(enter(screen.container.querySelector("textarea")!).defaultPrevented).toBe(false);
    expect(enter(screen.container.querySelector("button")!).defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  } finally {
    other.remove();
  }
});

it("blocks the shortcut during preparation and enables it afterward", async () => {
  const onSubmit = vi.fn();
  await using screen = await render(<Probe preparing onSubmit={onSubmit} />, { router: false });
  expect(enter(document.body).defaultPrevented).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
  await screen.rerender(<Probe onSubmit={onSubmit} />);
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("foreground");
});
