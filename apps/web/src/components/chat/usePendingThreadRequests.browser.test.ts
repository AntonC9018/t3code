import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { createElement, useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { makeRetainedQuestionAnswerDraft } from "../../questionAnswerDrafts";
import { questionAttachmentDraftId } from "../../questionAttachments";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: {}, respondToUserInput: {}, dismissUserInput: {} },
}));
vi.mock("../../lib/attachmentUploadQueue", async () => {
  const { create } = await import("zustand");
  return {
    useAttachmentUploadStore: create(() => ({ uploadsByImageId: {} })),
    getUploadedAttachments: () => [],
    releaseDraftAttachments: vi.fn(),
  };
});

const environmentId = EnvironmentId.make("pending-questions-unit");
const question = {
  id: "same-question-id",
  header: "Answer",
  question: "What should we do?",
  options: [],
  initialAnswer: "Original answer",
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const fixture = makeThreadProjectionFixture();
  return {
    ...fixture,
    thread: { ...fixture.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: fixture.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: fixture.updatedAt,
      completedAt: fixture.updatedAt,
      updatedAt: fixture.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: [question],
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

async function pendingRequestsHarness(projection: OrchestrationV2ThreadProjection) {
  let current!: ReturnType<typeof usePendingThreadRequests>;
  function Probe({
    projection,
    loading = false,
  }: {
    projection: OrchestrationV2ThreadProjection;
    loading?: boolean;
  }) {
    const promptRef = useRef("");
    const composerRef = useRef(null);
    const setComposerDraftPrompt = useComposerDraftStore((state) => state.setPrompt);
    const state = usePendingThreadRequests({
      environmentId,
      activeThreadId: projection.thread.id,
      serverProjection: loading ? null : projection,
      supportsQuestionAttachments: false,
      composerDraftTarget: { environmentId, threadId: projection.thread.id },
      setComposerDraftPrompt,
      promptRef,
      composerRef,
      setThreadError: () => {},
    });
    useLayoutEffect(() => {
      current = state;
    });
    return null;
  }
  const screen = await render(createElement(Probe, { projection }));
  return {
    get current() {
      return current;
    },
    async show(projection: OrchestrationV2ThreadProjection | null, loading = false) {
      await screen.rerender(projection ? createElement(Probe, { projection, loading }) : null);
    },
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
    },
  };
}

it("restores dictated question answers through navigation and reload and rejects late delivery after resolution", async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const threadId = ThreadId.make("original-question-thread");
  const threadRef = { environmentId, threadId };
  const projection = questionProjection(threadId);
  useComposerDraftStore.getState().setPrompt(threadRef, "Unsent chat prompt");
  await using screen = await pendingRequestsHarness(projection);
  const staleEditorChange = screen.current.onChangeActivePendingUserInputCustomAnswer;
  await act(async () => staleEditorChange(question.id, "Edited answer"));
  expect(screen.current.activePendingProgress?.customAnswer).toBe("Edited answer");
  const firstTarget = questionAttachmentDraftId(environmentId, threadId, "first", question.id);
  const retained = makeRetainedQuestionAnswerDraft(firstTarget, question);

  await screen.show(questionProjection(ThreadId.make("other-question-thread")));
  await act(async () => retained.commit("Edited answer and dictation"));
  expect(screen.current.activePendingProgress?.customAnswer).toBe("Original answer");
  await screen.show(projection, true);
  expect(screen.current.activePendingUserInput).toBeNull();
  await screen.show(projection);
  expect(screen.current.activePendingProgress?.customAnswer).toBe("Edited answer and dictation");

  await screen.show(null);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.rehydrate();
  await screen.show(projection);
  expect(screen.current.activePendingProgress?.customAnswer).toBe("Edited answer and dictation");
  expect(screen.current.activePendingResolvedAnswers).toEqual({
    [question.id]: "Edited answer and dictation",
  });
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "Unsent chat prompt",
  );

  await screen.show(questionProjection(threadId, ["second"]));
  await act(async () => {
    expect(() => retained.commit("Late transcription")).toThrow(
      "This question is no longer available.",
    );
    staleEditorChange(question.id, "Late editor update");
  });
  expect(useComposerDraftStore.getState().getComposerDraft(firstTarget)).toBeNull();
  expect(screen.current.activePendingUserInput?.requestId).toBe("second");
  expect(screen.current.activePendingProgress?.customAnswer).toBe("Original answer");
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "Unsent chat prompt",
  );
});
