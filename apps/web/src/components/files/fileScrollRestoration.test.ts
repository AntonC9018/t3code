import { expect, it, vi } from "vite-plus/test";

import { fileScrollVisit, installFileScrollRestoration } from "./fileScrollRestoration";

const observers = vi.hoisted(() => ({ resize: () => {} }));
vi.mock("~/lib/observeResize", () => ({
  observeResize: (_elements: Element[], callback: () => void) => {
    observers.resize = callback;
    return () => {};
  },
}));

function setup() {
  let mutate = () => {};
  let frame = () => {};
  const savedGlobals = ["MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = () => {};
  });
  let top = 0;
  let height = 2000;
  const viewport = {
    isConnected: true,
    children: [],
    scrollLeft: 0,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.min(value, height);
    },
  };
  class Root extends EventTarget {
    override removeEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: EventListenerOptions | boolean,
    ) {
      super.removeEventListener(
        type,
        callback,
        typeof options === "boolean" ? { capture: options } : options,
      );
    }
  }
  const root = new Root();
  const element = Object.assign(root, { querySelector: () => viewport }) as unknown as HTMLElement;
  return {
    viewport,
    element,
    resize: (nextHeight: number) => {
      height = nextHeight;
      observers.resize();
      frame();
    },
    mutate: () => mutate(),
    scroll: (value: number) => {
      root.dispatchEvent(new Event("wheel"));
      viewport.scrollTop = value;
      const event = new Event("scroll");
      Object.defineProperty(event, "target", { value: viewport });
      root.dispatchEvent(event);
    },
    [Symbol.dispose]: () => {
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

it("restores independent file positions after switching A to B to A", () => {
  using dom = setup();
  const stopA = installFileScrollRestoration(dom.element, fileScrollVisit("switch-a", "1", null));
  dom.scroll(700);
  dom.viewport.scrollLeft = 80;
  stopA();
  dom.viewport.scrollTop = 0;
  const stopB = installFileScrollRestoration(dom.element, fileScrollVisit("switch-b", "1", null));
  dom.scroll(200);
  stopB();
  const stopRestored = installFileScrollRestoration(
    dom.element,
    fileScrollVisit("switch-a", "1", null),
  );
  expect(dom.viewport.scrollTop).toBe(700);
  expect(dom.viewport.scrollLeft).toBe(80);
  stopRestored();
});

it("restores again as delayed content grows, without overwriting the saved position", () => {
  using dom = setup();
  const stop = installFileScrollRestoration(dom.element, fileScrollVisit("delayed", "1", null));
  dom.scroll(900);
  stop();
  dom.resize(0);
  const restore = installFileScrollRestoration(dom.element, fileScrollVisit("delayed", "1", null));
  expect(dom.viewport.scrollTop).toBe(0);
  dom.resize(2000);
  expect(dom.viewport.scrollTop).toBe(900);
  dom.scroll(300);
  dom.mutate();
  expect(dom.viewport.scrollTop).toBe(300);
  restore();
  expect(fileScrollVisit("delayed", "1", null).saved?.top).toBe(300);
});

it("lets a new line reveal override saved scroll but does not repeat an already visited reveal", () => {
  using dom = setup();
  const first = fileScrollVisit("reveal", "1", 30);
  expect(first.revealLine).toBe(30);
  const stop = installFileScrollRestoration(dom.element, first);
  dom.scroll(600);
  stop();
  expect(fileScrollVisit("reveal", "1", 30).revealLine).toBeNull();
  const next = fileScrollVisit("reveal", "2", 50);
  expect(next.revealLine).toBe(50);
  expect(next.saved).toBeUndefined();
});

it("does not overwrite a saved position when React removes the old viewport before cleanup", () => {
  using dom = setup();
  const stop = installFileScrollRestoration(dom.element, fileScrollVisit("detached", "1", null));
  dom.scroll(750);
  dom.viewport.isConnected = false;
  dom.viewport.scrollTop = 0;
  stop();
  expect(fileScrollVisit("detached", "1", null).saved?.top).toBe(750);
});
