import type { RouterHistory } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  useRightPanelStore,
} from "./rightPanelStore";

type FileVisit = {
  surfaceId: string | null;
  file?: Extract<RightPanelSurface, { kind: "file" | "files" }>;
};

declare module "@tanstack/react-router" {
  interface HistoryState {
    fileVisit?: FileVisit;
  }
}

export function installFileNavigationHistory(
  history: RouterHistory,
  resolveThread: (pathname: string) => ScopedThreadRef | null,
): () => void {
  let restoring = false;
  const currentSurface = () =>
    selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      resolveThread(history.location.pathname),
    );
  const snapshot = (): FileVisit => {
    const surface = currentSurface();
    return {
      surfaceId: surface?.id ?? null,
      ...(surface?.kind === "file" || surface?.kind === "files" ? { file: surface } : {}),
    };
  };
  const write = (push: boolean) => {
    restoring = true;
    try {
      const state = { ...history.location.state, fileVisit: snapshot() };
      if (push) history.push(history.location.href, state);
      else history.replace(history.location.href, state);
    } finally {
      restoring = false;
    }
  };
  // Preserve the starting panel as well, including a closed panel before the first file.
  if (!history.location.state.fileVisit) write(false);
  const stopHistory = history.subscribe(({ location, action }) => {
    if (restoring) return;
    const ref = resolveThread(location.pathname);
    if (!ref) return;
    if (action.type === "PUSH" || action.type === "REPLACE") {
      write(false);
      return;
    }
    const visit = location.state.fileVisit;
    if (!visit) return;
    restoring = true;
    try {
      const store = useRightPanelStore.getState();
      if (visit.file?.kind === "file") {
        if (visit.file.attachment) store.openAttachment(ref, visit.file.attachment);
        else store.openFile(ref, visit.file.relativePath);
      } else if (visit.file?.kind === "files") {
        store.open(ref, "files");
      } else if (visit.surfaceId !== null) {
        store.activateSurface(ref, visit.surfaceId);
      } else {
        store.close(ref);
      }
    } finally {
      restoring = false;
    }
  });
  const stopPanel = useRightPanelStore.subscribe((state, previous) => {
    if (restoring) return;
    const ref = resolveThread(history.location.pathname);
    if (!ref) return;
    const before = selectActiveRightPanelSurface(previous.byThreadKey, ref);
    const after = selectActiveRightPanelSurface(state.byThreadKey, ref);
    if (before?.id === after?.id) return;
    if (before?.kind !== "file" && after?.kind !== "file") return;
    // Revisions from background panels and file edits do not create navigation entries.
    write(true);
  });
  return () => {
    stopPanel();
    stopHistory();
  };
}
