import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { ModelSelection } from "@t3tools/contracts";
import {
  deriveSendPromptCacheStatus,
  promptCacheNeedsAcknowledgement,
} from "@t3tools/shared/promptCache";
import { toastManager } from "../ui/toast";

/** Reads the clock at send time; call it from handlers so render stays pure. */
export function sendNeedsPromptCacheAcknowledgement(
  projection: ThreadStructure | null | undefined,
  modelSelection: ModelSelection,
): boolean {
  if (!projection) return false;
  return promptCacheNeedsAcknowledgement(
    deriveSendPromptCacheStatus({
      thread: projection.thread,
      providerThreads: projection.providerThreads,
      providerTurns: projection.providerTurns,
      attempts: projection.attempts,
      runs: projection.runs,
      modelSelection,
      nowMs: Date.now(),
    }),
  );
}

export function showColdPromptCacheToast(sendAnyway: () => void) {
  toastManager.add({
    type: "warning",
    title: "Message not sent: Claude cache may be cold",
    description:
      "Compact with another model from the context menu, or explicitly send with an uncached read.",
    actionProps: { children: "Send anyway once", onClick: sendAnyway },
  });
}
