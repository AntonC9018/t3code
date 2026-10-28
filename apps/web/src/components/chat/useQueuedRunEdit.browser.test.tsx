import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useImperativeHandle, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

const { editQueuedRun } = vi.hoisted(() => ({ editQueuedRun: vi.fn() }));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => editQueuedRun) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({
  useAssetUrls: () => [],
}));

import { act, render } from "../../../test/render";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import type { ChatComposerHandle } from "./ChatComposer";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

const environmentId = EnvironmentId.make("queued-edit-environment");
const threadA = { environmentId, threadId: ThreadId.make("thread-a") };
const threadB = { environmentId, threadId: ThreadId.make("thread-b") };
const requestA: EditQueuedRunRequest = {
  runId: RunId.make("run-a"),
  messageId: MessageId.make("message-a"),
  text: "Queued A",
  attachments: [],
};
const requestB: EditQueuedRunRequest = {
  runId: RunId.make("run-b"),
  messageId: MessageId.make("message-b"),
  text: "Queued B",
  attachments: [],
};

function queuedProjection(threadId: ThreadId) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runs: [requestA, requestB].map((request, index) => ({
      id: request.runId,
      threadId,
      ordinal: index + 1,
      providerInstanceId: projection.thread.providerInstanceId,
      modelSelection: projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: request.messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued" as const,
      requestedAt: projection.updatedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    })),
  };
}

type EditState = ReturnType<typeof useQueuedRunEdit>;
interface Probe {
  current: { edit: EditState; promptRef: { current: string } } | null;
}

function ComposerHarness({
  thread,
  probe,
  resetCursorState,
}: {
  thread: typeof threadA;
  probe: Probe;
  resetCursorState: () => void;
}) {
  // ChatView and ChatComposer keep these refs across thread navigation.
  const promptRef = useRef("");
  const composerRef = useRef({
    resetCursorState,
    focusAtEnd: () => {},
  } as ChatComposerHandle);
  const edit = useQueuedRunEdit({
    environmentId: thread.environmentId,
    routeThreadRef: thread,
    threadDraftTarget: thread,
    activeThreadId: thread.threadId,
    serverProjection: queuedProjection(thread.threadId),
    promptRef,
    composerRef,
  });
  const prompt = useComposerDraftStore(
    (store) => store.getComposerDraft(edit.draftTarget)?.prompt ?? "",
  );
  // Match ChatComposer: a save-state rerender alone must not resync the ref.
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);
  useImperativeHandle(probe, () => ({ edit, promptRef }));
  return <textarea aria-label="Composer" readOnly value={prompt} />;
}

function setup() {
  editQueuedRun.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  type CommandResult = ReturnType<typeof AsyncResult.success<void>>;
  let resolve!: (value: CommandResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<CommandResult>((resolveCommand, rejectCommand) => {
    resolve = resolveCommand;
    reject = rejectCommand;
  });
  const command = { promise, resolve, reject };
  editQueuedRun.mockReturnValue(command.promise);
  const probe: Probe = { current: null };
  const resetCursorState = vi.fn();
  const setThreadError = vi.fn();
  const ui = (thread = threadA) => (
    <ComposerHarness thread={thread} probe={probe} resetCursorState={resetCursorState} />
  );
  const current = () => {
    if (probe.current === null) throw new Error("Composer harness has not mounted");
    return probe.current;
  };
  const setPrompt = (target: ComposerThreadTarget, text: string) =>
    act(() => useComposerDraftStore.getState().setPrompt(target, text));
  const startSave = async () => {
    let saving: Promise<void> = Promise.resolve();
    await act(() => {
      saving = current().edit.saveEdit(
        {
          prompt: current().promptRef.current,
          images: [],
          files: [],
          terminalContexts: [],
          reviewComments: [],
          previewAnnotations: [],
          threadContexts: [],
        },
        setThreadError,
      );
    });
    await vi.waitFor(() => expect(editQueuedRun).toHaveBeenCalledOnce());
    return { saving };
  };
  return { command, current, resetCursorState, setThreadError, ui, setPrompt, startSave };
}

it.each(["success", "failure"] as const)(
  "keeps B's visible draft and submission ref when A's pending save finishes with %s",
  async (outcome) => {
    const test = setup();
    await test.setPrompt(threadB, "Unsent B draft");
    await using screen = await render(test.ui());
    await act(() => test.current().edit.beginEdit(requestA));
    const savedTarget = test.current().edit.draftTarget;
    await test.setPrompt(savedTarget, "Edited A");
    const { saving } = await test.startSave();
    const sharedPromptRef = test.current().promptRef;
    expect(test.current().edit.isSaving).toBe(true);
    expect(editQueuedRun.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      input: { threadId: threadA.threadId, runId: requestA.runId, text: "Edited A" },
    });

    // Rerender the same component, without a key or an unmount.
    await screen.rerender(test.ui(threadB));
    expect(test.current().promptRef).toBe(sharedPromptRef);
    expect(test.current().promptRef.current).toBe("Unsent B draft");
    await act(async () => {
      if (outcome === "success") test.command.resolve(AsyncResult.success(undefined));
      else test.command.reject(new Error("Save A failed"));
      await saving;
    });

    await expect
      .element(screen.getByRole("textbox", { name: "Composer" }))
      .toHaveValue("Unsent B draft");
    expect.soft(test.current().promptRef.current).toBe("Unsent B draft");
    expect.soft(test.resetCursorState).not.toHaveBeenCalled();
    expect(test.current().edit.isSaving).toBe(false);
    expect(test.setThreadError).toHaveBeenCalledExactlyOnceWith(
      threadA.threadId,
      outcome === "success" ? null : "Save A failed",
    );
    const store = useComposerDraftStore.getState();
    expect(store.getComposerDraft(threadB)?.prompt).toBe("Unsent B draft");
    expect(store.getComposerDraft(savedTarget)?.prompt ?? "").toBe(
      outcome === "success" ? "" : "Edited A",
    );
  },
);

it.each([requestB, requestA])(
  "keeps a newer edit of $runId after cancelling A while its save is pending",
  async (nextRequest) => {
    const test = setup();
    await using screen = await render(test.ui());
    await act(() => test.current().edit.beginEdit(requestA));
    const savedTarget = test.current().edit.draftTarget;
    await test.setPrompt(savedTarget, "Edited A");
    const { saving } = await test.startSave();
    await act(() => test.current().edit.cancelEdit());
    await act(() => test.current().edit.beginEdit(nextRequest));
    const nextTarget = test.current().edit.draftTarget;
    await test.setPrompt(nextTarget, "Newer edit");

    await act(async () => {
      test.command.resolve(AsyncResult.success(undefined));
      await saving;
    });

    expect(test.current().edit.editingRunId).toBe(nextRequest.runId);
    expect.soft(test.current().promptRef.current).toBe("Newer edit");
    expect.soft(test.resetCursorState).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("textbox", { name: "Composer" }))
      .toHaveValue("Newer edit");
    expect(useComposerDraftStore.getState().getComposerDraft(nextTarget)?.prompt).toBe(
      "Newer edit",
    );
  },
);

it("cleans the saved edit and restores the separate thread draft on normal success", async () => {
  const test = setup();
  await test.setPrompt(threadA, "Separate A draft");
  await using screen = await render(test.ui());
  await act(() => test.current().edit.beginEdit(requestA));
  const savedTarget = test.current().edit.draftTarget;
  await test.setPrompt(savedTarget, "Edited A");
  const { saving } = await test.startSave();
  await act(async () => {
    test.command.resolve(AsyncResult.success(undefined));
    await saving;
  });

  expect(test.current().edit.editingRunId).toBeNull();
  expect(test.current().edit.isSaving).toBe(false);
  expect(test.resetCursorState).toHaveBeenCalledOnce();
  expect(test.setThreadError).toHaveBeenCalledExactlyOnceWith(threadA.threadId, null);
  expect(useComposerDraftStore.getState().getComposerDraft(savedTarget)?.prompt ?? "").toBe("");
  expect(test.current().edit.draftTarget).toEqual(threadA);
  expect(test.current().promptRef.current).toBe("Separate A draft");
  await expect
    .element(screen.getByRole("textbox", { name: "Composer" }))
    .toHaveValue("Separate A draft");
});
