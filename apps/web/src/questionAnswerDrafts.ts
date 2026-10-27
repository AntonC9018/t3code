import type { UserInputQuestion } from "@t3tools/contracts";
import {
  type DraftId,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "./composerDraftStore";
import { setPendingUserInputCustomAnswer } from "./pendingUserInput";

type QuestionAnswerTarget = Pick<UserInputQuestion, "id" | "initialAnswer" | "allowCustomAnswer">;

export function seedQuestionAnswerDraft(target: DraftId, question: QuestionAnswerTarget): void {
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(target)?.questionAnswer !== undefined) return;
  store.setQuestionAnswer(
    target,
    question.initialAnswer !== undefined && question.allowCustomAnswer !== false
      ? { customAnswer: question.initialAnswer }
      : {},
  );
}

export function setQuestionCustomAnswer(
  target: DraftId,
  question: QuestionAnswerTarget,
  value: string,
): boolean {
  const store = useComposerDraftStore.getState();
  const answer = store.getComposerDraft(target)?.questionAnswer;
  // Resolution clears the sidecar. Late recordings and editor handlers must not recreate it.
  if (answer === undefined || question.allowCustomAnswer === false) return false;
  store.setQuestionAnswer(target, setPendingUserInputCustomAnswer(answer, value, question));
  return true;
}

/** The sidecar ID binds the recording to its environment, thread, request and question. */
export function makeRetainedQuestionAnswerDraft(target: DraftId, question: QuestionAnswerTarget) {
  return {
    read: () => {
      const answer = useComposerDraftStore.getState().getComposerDraft(target)?.questionAnswer;
      if (answer === undefined || question.allowCustomAnswer === false) return null;
      const text = answer.customAnswer ?? "";
      return { text, selection: { start: text.length, end: text.length } };
    },
    commit: (text: string) => {
      if (!setQuestionCustomAnswer(target, question, text)) {
        throw new Error("This question is no longer available.");
      }
      flushComposerDraftPersistence();
    },
  };
}
