import { observeResize } from "~/lib/observeResize";

type Position = { top: number; left: number; revealToken: string };
const positions = new Map<string, Position>();
const MAX_SAVED_FILES = 200;
const VIEWPORT_SELECTOR =
  ".file-preview-virtualizer, [data-file-scroll-viewport], [data-slot='scroll-area-viewport']";

export function fileScrollVisit(identity: string, revealToken: string, revealLine: number | null) {
  const saved = positions.get(identity);
  const newReveal = revealLine !== null && saved?.revealToken !== revealToken;
  return {
    identity,
    revealToken,
    requestedLine: revealLine,
    saved: newReveal ? undefined : saved,
    revealLine: newReveal ? revealLine : null,
  };
}

export function installFileScrollRestoration(
  root: HTMLElement,
  initial: ReturnType<typeof fileScrollVisit>,
) {
  const { identity, revealToken } = initial;
  let viewport: HTMLElement | null = null;
  let restoring = initial.saved !== undefined;
  let frame: number | null = null;
  const save = () => {
    if (!viewport || !viewport.isConnected || restoring) return;
    positions.delete(identity);
    positions.set(identity, { top: viewport.scrollTop, left: viewport.scrollLeft, revealToken });
    if (positions.size > MAX_SAVED_FILES) positions.delete(positions.keys().next().value!);
  };
  const restore = () => {
    if (!viewport || !restoring || !initial.saved) return;
    viewport.scrollTop = initial.saved.top;
    viewport.scrollLeft = initial.saved.left;
  };
  const scheduleRestore = () => {
    if (!restoring || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      restore();
    });
  };
  let stopResize = () => {};
  let observedChildren: Element[] = [];
  const discover = () => {
    const next = root.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    const children = next ? Array.from(next.children) : [];
    if (
      next !== viewport ||
      children.length !== observedChildren.length ||
      children.some((child, index) => child !== observedChildren[index])
    ) {
      stopResize();
      viewport = next;
      observedChildren = children;
      stopResize = viewport ? observeResize([viewport, ...children], scheduleRestore) : () => {};
    }
    restore();
  };
  // Content and virtualizer height arrive after the file query and worker highlight.
  const mutations = new MutationObserver(discover);
  mutations.observe(root, { childList: true, subtree: true });
  const onScroll = (event: Event) => {
    if (event.target !== viewport) return;
    if (restoring) scheduleRestore();
    else save();
  };
  const onInteraction = () => {
    restoring = false;
  };
  root.addEventListener("scroll", onScroll, true);
  root.addEventListener("wheel", onInteraction, { passive: true });
  root.addEventListener("touchstart", onInteraction, { passive: true });
  root.addEventListener("pointerdown", onInteraction, true);
  root.addEventListener("keydown", onInteraction, true);
  discover();
  return () => {
    // Scroll events are asynchronous, so preserve the last position before unmount too.
    save();
    if (frame !== null) cancelAnimationFrame(frame);
    mutations.disconnect();
    stopResize();
    root.removeEventListener("scroll", onScroll, true);
    root.removeEventListener("wheel", onInteraction);
    root.removeEventListener("touchstart", onInteraction);
    root.removeEventListener("pointerdown", onInteraction, true);
    root.removeEventListener("keydown", onInteraction, true);
  };
}
