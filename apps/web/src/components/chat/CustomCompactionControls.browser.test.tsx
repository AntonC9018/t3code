import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { it, expect, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ run: vi.fn(), update: vi.fn() }));
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6-luna" };
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: "2026-11-01T12:00:00Z",
  supportsTextGeneration: true,
  models: [
    { slug: "gpt-6-luna", name: "Luna", isDefault: true, isCustom: false, capabilities: null },
    { slug: "gpt-6.1-sol", name: "Sol", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  supportedRuntimeModes: ["full-access"],
};
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    customCompactionModelSelection: modelSelection,
  })) as never,
  useUpdateEnvironmentSettings: () => state.update,
  useEnvironmentModelPreferences: (() => ({ favorites: [] })) as never,
  useToggleEnvironmentModelFavorite: () => state.update,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  EMPTY_SERVER_PROVIDERS: [],
  primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS),
  serverEnvironment: { providersValueAtom: () => Atom.make([provider]) } as never,
}));
vi.mock(import("~/state/orchestration"), () => ({
  orchestrationEnvironment: { compactContext: { permissionAtom: () => Atom.make(true) } } as never,
}));
vi.mock(import("~/state/use-orchestration-command"), () => ({
  useOrchestrationCommand: () => state.run,
}));

import { CustomCompactionControls } from "./CustomCompactionControls";
import { ContextWindowMeter } from "./ContextWindowMeter";

it("keeps custom compaction available beside disabled native compaction and recovers after generation failure", async () => {
  state.run.mockReset();
  state.update.mockReset();
  let fail: (value: unknown) => void = () => {};
  state.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        fail = resolve;
      }),
  );
  const native = vi.fn();
  await using screen = await render(
    <RegistryProvider>
      <ContextWindowMeter
        usage={null}
        onCompact={native}
        compactDisabled
        customCompaction={
          <CustomCompactionControls
            environmentId={EnvironmentId.make("env")}
            threadId={ThreadId.make("thread")}
            projectId={null}
            disabled={false}
          />
        }
      />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Compact context", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Compact with native provider" }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Compaction model", exact: true }).click();
  await page.getByRole("option", { name: "Sol", exact: false }).click();
  await page.getByRole("button", { name: "Compact with selected model" }).click();
  await expect.element(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  expect(native).not.toHaveBeenCalled();
  expect(state.run).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        threadId: "thread",
        modelSelection: { instanceId, model: "gpt-6.1-sol" },
      }),
    }),
  );
  await act(() => fail(AsyncResult.fail(new Error("Summary generation failed"))));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Summary generation failed");
  await expect
    .element(page.getByRole("button", { name: "Compact with selected model" }))
    .toBeEnabled();
});
