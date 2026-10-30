import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  resolvePendingUserInputAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  makeRetainedComposerDraft,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  makeRetainedQuestionAnswerDraft,
  seedQuestionAnswerDraft,
  setQuestionCustomAnswer,
} from "./questionAnswerDrafts";
import { clearQuestionAttachmentDraft, questionAttachmentDraftId } from "./questionAttachments";

vi.mock("./lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));

const environmentId = EnvironmentId.make("question-voice-env");
const threadId = ThreadId.make("question-voice-thread");
const requestId = RuntimeRequestId.make("question-voice-request");
const question = {
  id: "answer",
  header: "Answer",
  question: "Which answer?",
  options: [{ label: "Choice", value: " choice\t", description: "Choose this" }],
};
const target = questionAttachmentDraftId(environmentId, threadId, requestId, question.id);
const threadRef = { environmentId, threadId };

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});

it("delivers retained dictation to the original question after navigation without changing chat prompts", () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(threadRef, "Unsent normal prompt");
  seedQuestionAnswerDraft(target, question);
  setQuestionCustomAnswer(target, question, "Typed answer");
  const retained = makeRetainedQuestionAnswerDraft(target, question);

  const otherQuestion = questionAttachmentDraftId(environmentId, threadId, requestId, "other");
  seedQuestionAnswerDraft(otherQuestion, question);
  setQuestionCustomAnswer(otherQuestion, question, "Other question answer");
  const otherThread = { environmentId, threadId: ThreadId.make("elsewhere") };
  store.setPrompt(otherThread, "Other chat prompt");

  expect(retained.read()).toEqual({
    text: "Typed answer",
    selection: { start: 12, end: 12 },
  });
  retained.commit("Typed answer with dictation");

  expect(store.getComposerDraft(target)?.questionAnswer?.customAnswer).toBe(
    "Typed answer with dictation",
  );
  expect(store.getComposerDraft(otherQuestion)?.questionAnswer?.customAnswer).toBe(
    "Other question answer",
  );
  expect(store.getComposerDraft(threadRef)?.prompt).toBe("Unsent normal prompt");
  expect(store.getComposerDraft(otherThread)?.prompt).toBe("Other chat prompt");
});

it("persists dictation before returning and restores later edits, choices and cleared initial answers", async () => {
  const store = useComposerDraftStore.getState();
  const literalQuestion = { ...question, initialAnswer: "Original answer" };
  seedQuestionAnswerDraft(target, literalQuestion);
  setQuestionCustomAnswer(target, literalQuestion, "Edited before dictation");
  makeRetainedQuestionAnswerDraft(target, literalQuestion).commit("Edited and dictated");
  const storage = useComposerDraftStore.persist.getOptions().storage!;
  expect(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toMatchObject({
    state: {
      draftsByThreadKey: { [target]: { questionAnswer: { customAnswer: "Edited and dictated" } } },
    },
  });

  setQuestionCustomAnswer(target, literalQuestion, "");
  const choiceTarget = questionAttachmentDraftId(environmentId, threadId, requestId, "choice");
  seedQuestionAnswerDraft(choiceTarget, question);
  store.setQuestionAnswer(
    choiceTarget,
    togglePendingUserInputOptionSelection(question, undefined, " choice\t"),
  );
  // A retained commit flushes all pending answer edits, just as beforeunload does.
  makeRetainedQuestionAnswerDraft(target, literalQuestion).commit("");
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.rehydrate();
  seedQuestionAnswerDraft(target, literalQuestion);

  expect(store.getComposerDraft(target)?.questionAnswer).toEqual({ customAnswer: "" });
  expect(
    resolvePendingUserInputAnswer(literalQuestion, store.getComposerDraft(target)?.questionAnswer),
  ).toBe("");
  expect(store.getComposerDraft(choiceTarget)?.questionAnswer).toEqual({
    customAnswer: "",
    selectedOptionValues: [" choice\t"],
  });
  const restored = makeRetainedQuestionAnswerDraft(target, literalQuestion);
  restored.commit("Recovered recording after reload");
  expect(restored.read()?.text).toBe("Recovered recording after reload");
});

it("separates recordings for identical question IDs in different requests, threads and environments", () => {
  const keys = [
    target,
    questionAttachmentDraftId(
      environmentId,
      threadId,
      RuntimeRequestId.make("second-request"),
      question.id,
    ),
    questionAttachmentDraftId(
      environmentId,
      ThreadId.make("second-thread"),
      requestId,
      question.id,
    ),
    questionAttachmentDraftId(EnvironmentId.make("second-env"), threadId, requestId, question.id),
  ];
  for (const [index, key] of keys.entries()) {
    seedQuestionAnswerDraft(key, question);
    makeRetainedQuestionAnswerDraft(key, question).commit(`Answer ${index}`);
  }
  expect(keys.map((key) => makeRetainedQuestionAnswerDraft(key, question).read()?.text)).toEqual([
    "Answer 0",
    "Answer 1",
    "Answer 2",
    "Answer 3",
  ]);
});

it("cannot resurrect a resolved question with a late transcription or stale editor callback", () => {
  seedQuestionAnswerDraft(target, question);
  const retained = makeRetainedQuestionAnswerDraft(target, question);
  clearQuestionAttachmentDraft(target);

  expect(retained.read()).toBeNull();
  expect(() => retained.commit("Late dictation")).toThrow("This question is no longer available.");
  expect(setQuestionCustomAnswer(target, question, "Late editor update")).toBe(false);
  expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
});

it("propagates persistence failures so the caller can retain the recording", () => {
  seedQuestionAnswerDraft(target, question);
  const retained = makeRetainedQuestionAnswerDraft(target, question);
  const storage = useComposerDraftStore.persist.getOptions().storage!;
  using _write = vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("Storage is full");
  });
  expect(() => retained.commit("Keep this recording")).toThrow("Storage is full");
});

it("rejects custom dictation for a question that requires an option", () => {
  const choiceOnly = { ...question, allowCustomAnswer: false };
  seedQuestionAnswerDraft(target, choiceOnly);
  expect(() =>
    makeRetainedQuestionAnswerDraft(target, choiceOnly).commit("Not an allowed answer"),
  ).toThrow("This question is no longer available.");
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.questionAnswer).toEqual({});
});

it("keeps normal retained prompt delivery bound to its original chat", () => {
  const retained = makeRetainedComposerDraft(threadRef);
  useComposerDraftStore.getState().setPrompt(threadRef, "Original prompt");
  expect(retained.read().text).toBe("Original prompt");
  retained.commit("Original prompt with dictation");
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "Original prompt with dictation",
  );
});

it("records delivery durably and keeps a repeated recovery from inserting its text twice", async () => {
  const retained = makeRetainedComposerDraft(threadRef);
  retained.commit("Recovered dictation", "recording-receipt");
  retained.commit("Recovered dictation Second recording", "second-receipt");
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.rehydrate();
  const restored = makeRetainedComposerDraft(threadRef);
  expect(restored.hasDelivered("recording-receipt")).toBe(true);
  expect(restored.commit("Recovered dictation Recovered dictation", "recording-receipt")).toBe(
    "Recovered dictation Second recording",
  );
  expect(restored.read().text).toBe("Recovered dictation Second recording");
  restored.forgetDelivered("recording-receipt");
  expect(restored.hasDelivered("recording-receipt")).toBe(false);
  expect(restored.hasDelivered("second-receipt")).toBe(true);
  useComposerDraftStore.getState().clearComposerContent(threadRef);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.rehydrate();
  expect(restored.hasDelivered("second-receipt")).toBe(true);
  restored.forgetDelivered("second-receipt");
  expect(restored.hasDelivered("second-receipt")).toBe(false);
});
