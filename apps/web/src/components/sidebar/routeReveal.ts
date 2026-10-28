import { observeResize } from "../../lib/observeResize";

// Owned by AppSidebarLayout because Settings can unmount the thread sidebar
// without changing the route. The mobile drawer retains it while closed.
// Callers must wait until the sidebar is visible before completing a reveal.
// Only a route change requests a reveal that may widen the project scope,
// so a scope chosen while one thread
// stays open survives a remount. Scroll position does not survive one.
//
// A null key is not an observation: leaving Settings commits the router's
// location before its matches, so the sidebar's first render can read no
// thread params. Recording that would make the same thread look new.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
}

export function pendingSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
  }
  return reveal.pendingKey;
}

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

// The dialog can still hide its retained portal when React's open state changes.
export function runSidebarRevealWhenReady(reveal: () => boolean): (() => void) | undefined {
  if (reveal()) return;
  const content = document.querySelector('[data-sidebar="content"]');
  if (!content) return;
  const stop = observeResize(content, () => {
    if (reveal()) stop();
  });
  return stop;
}
