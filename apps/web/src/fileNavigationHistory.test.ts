import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { installFileNavigationHistory } from "./fileNavigationHistory";
import { selectActiveRightPanelSurface, useRightPanelStore } from "./rightPanelStore";

const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const other = scopeThreadRef(EnvironmentId.make("other-env"), ThreadId.make("thread"));

function setup() {
  useRightPanelStore.setState({ byThreadKey: {} });
  const history = createMemoryHistory({ initialEntries: ["/env/thread"] });
  const stop = installFileNavigationHistory(history, (path) =>
    path === "/env/thread" ? ref : path === "/other-env/thread" ? other : null,
  );
  return { history, store: useRightPanelStore.getState(), [Symbol.dispose]: stop };
}

function active(threadRef = ref) {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef)?.id;
}

it("goes back and forward between file opens and tab selections", () => {
  using test = setup();
  test.store.openFile(ref, "a.ts");
  test.store.openFile(ref, "b.ts");
  test.store.activateSurface(ref, "file:a.ts");
  test.history.back();
  expect(active()).toBe("file:b.ts");
  test.history.back();
  expect(active()).toBe("file:a.ts");
  test.history.forward();
  expect(active()).toBe("file:b.ts");
});

it("interleaves file visits with routes and scopes matching thread ids to their environments", () => {
  using test = setup();
  test.store.openFile(ref, "a.ts");
  test.history.push("/other-env/thread");
  test.store.openFile(other, "remote.ts");
  test.history.push("/settings");
  test.history.back();
  expect(active(other)).toBe("file:remote.ts");
  test.history.back();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, other),
  ).toBeNull();
  test.history.back();
  expect(test.history.location.pathname).toBe("/env/thread");
  expect(active()).toBe("file:a.ts");
});

it("reopens a closed file on Back and discards Forward after a new visit", () => {
  using test = setup();
  test.store.openFile(ref, "a.ts");
  test.store.openFile(ref, "b.ts");
  test.store.closeSurface(ref, "file:a.ts");
  test.history.back();
  expect(active()).toBe("file:a.ts");
  test.store.openFile(ref, "c.ts");
  test.history.forward();
  expect(active()).toBe("file:c.ts");
});

it("does not add entries for edits, repeat activation or background thread panels", () => {
  using test = setup();
  test.store.openFile(ref, "a.ts");
  const length = test.history.length;
  test.store.openFile(ref, "a.ts");
  test.store.activateSurface(ref, "file:a.ts");
  test.store.openFile(other, "remote.ts");
  expect(test.history.length).toBe(length);
});
