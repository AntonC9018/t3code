import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  assistantItem,
  emitThreadEvent,
  installFakeEnvironment,
  isShellSubscribed,
  isThreadSubscribed,
  publishThread,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("shows responses after an unsent draft becomes a server thread without refreshing", async () => {
  using _environment = installFakeEnvironment([], { serveThreadSnapshots: true });
  await page.viewport(1400, 900);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-new-response");
  const thread = threadWithHistory("new-response", 1);
  useComposerDraftStore.getState().setProjectDraftThreadId(
    {
      environmentId: ENVIRONMENT_ID,
      projectId: ProjectId.make("project-render"),
    },
    draftId,
    { threadId: thread.id },
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _screen = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByRole("textbox").first()).toBeVisible();
  await expect.poll(isShellSubscribed).toBe(true);
  await act(() => publishThread(thread));
  await expect.poll(() => isThreadSubscribed(thread.id)).toBe(true);
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  const run = thread.runs[0]!;
  await act(() =>
    emitThreadEvent(thread.id, {
      type: "turn-item.updated",
      payload: assistantItem(
        thread.id,
        run.id,
        "live-after-create",
        2,
        "The response arrived without refreshing.",
      ),
    }),
  );
  await expect.element(page.getByText("The response arrived without refreshing.")).toBeVisible();
});
