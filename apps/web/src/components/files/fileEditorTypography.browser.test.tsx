import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import type { CSSProperties } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "keeps an existing editor's caret aligned after typography changes (canvas mismatch: %s)",
  async (canvasMismatch) => {
    if (canvasMismatch) {
      const measureText = CanvasRenderingContext2D.prototype.measureText;
      vi.spyOn(CanvasRenderingContext2D.prototype, "measureText").mockImplementation(function (
        this: CanvasRenderingContext2D,
        text: string,
      ) {
        const metrics = measureText.call(this, text);
        return new Proxy(metrics, {
          get(target, key) {
            return key === "width" ? target.width * 1.05 : Reflect.get(target, key, target);
          },
        });
      });
    }
    const contents = "replace the need to test a real NixOS boot.";
    let editor: Editor<"file", undefined, undefined> | undefined;
    const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
      new Editor(type, options, key);
    await using screen = await render(
      <div style={{ width: 800, "--diffs-font-size": "13px" } as CSSProperties}>
        <EditProvider createEditor={createEditor}>
          <File
            file={{ name: "typography.txt", contents }}
            edit
            editorOptions={{
              onAttach: (attached) => {
                editor = attached;
              },
            }}
            options={{ disableFileHeader: true, overflow: "scroll" }}
          />
        </EditProvider>
      </div>,
      { router: false },
    );

    await vi.waitFor(() => expect(editor).toBeDefined());
    editor!.setSelections([
      {
        start: { line: 0, character: contents.length },
        end: { line: 0, character: contents.length },
        direction: "none",
      },
    ]);
    editor!.focus();

    const caretError = () => {
      const shadow = screen.container.querySelector("diffs-container")!.shadowRoot!;
      const line = shadow.querySelector('[data-line="1"]')!;
      const range = document.createRange();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let text: Text | null = null;
      while (walker.nextNode()) text = walker.currentNode as Text;
      range.setStart(text!, text!.length);
      range.collapse(true);
      const caret = shadow.querySelector("[data-caret]")!;
      return Math.abs(caret.getBoundingClientRect().x - range.getBoundingClientRect().x);
    };
    await vi.waitFor(() => expect(caretError()).toBeLessThanOrEqual(2));

    const wrapper = screen.container.firstElementChild as HTMLElement;
    wrapper.style.setProperty("--diffs-font-size", "16px");
    await vi.waitFor(() => expect(caretError()).toBeLessThanOrEqual(2));

    wrapper.style.setProperty("--diffs-font-size", "11px");
    await vi.waitFor(() => expect(caretError()).toBeLessThanOrEqual(2));
  },
);
