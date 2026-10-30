import type { ScopedThreadRef, UserInputQuestion } from "@t3tools/contracts";
import { setPendingUserInputCustomAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import {
  DraftId,
  flushComposerDraftPersistence,
  forgetComposerVoiceRecordingDelivery,
  useComposerDraftStore,
} from "./composerDraftStore";
import { questionAttachmentDraftPrefix } from "./questionAttachments";
import { notifyVoiceRecordingRecoveryChange } from "./speech/recordingRecoveryEvents";

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
  notifyVoiceRecordingRecoveryChange();
}

export function makeClosedQuestionRecordingRecovery(threadRef: ScopedThreadRef) {
  return {
    ownerKeyPrefix: questionAttachmentDraftPrefix(threadRef.environmentId, threadRef.threadId),
    isDestinationAvailable: (ownerKey: string) =>
      useComposerDraftStore.getState().getComposerDraft(DraftId.make(ownerKey))?.questionAnswer !==
      undefined,
  };
}

export function setQuestionCustomAnswer(
  target: DraftId,
  question: QuestionAnswerTarget,
  value: string,
  voiceRecordingId?: string,
): boolean {
  const store = useComposerDraftStore.getState();
  const answer = store.getComposerDraft(target)?.questionAnswer;
  // Resolution clears the sidecar. Late recordings and editor handlers must not recreate it.
  if (answer === undefined || question.allowCustomAnswer === false) return false;
  store.setQuestionAnswer(
    target,
    setPendingUserInputCustomAnswer(question, answer, value),
    voiceRecordingId,
  );
  return true;
}

/** The sidecar ID binds the recording to its environment, thread, request and question. */
export function makeRetainedQuestionAnswerDraft(target: DraftId, question: QuestionAnswerTarget) {
  return {
    forgetDelivered: (recordingId: string) =>
      forgetComposerVoiceRecordingDelivery(target, recordingId),
    hasDelivered: (recordingId: string) =>
      useComposerDraftStore
        .getState()
        .getComposerDraft(target)
        ?.deliveredVoiceRecordingIds?.includes(recordingId) ?? false,
    read: () => {
      const answer = useComposerDraftStore.getState().getComposerDraft(target)?.questionAnswer;
      if (answer === undefined || question.allowCustomAnswer === false) return null;
      const text = answer.customAnswer ?? "";
      return { text, selection: { start: text.length, end: text.length } };
    },
    commit: (text: string, recordingId?: string) => {
      if (!setQuestionCustomAnswer(target, question, text, recordingId)) {
        throw new Error("This question is no longer available.");
      }
      flushComposerDraftPersistence();
      return (
        useComposerDraftStore.getState().getComposerDraft(target)?.questionAnswer?.customAnswer ??
        ""
      );
    },
  };
}
