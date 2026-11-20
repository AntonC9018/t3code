import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { ModelSelection } from "@t3tools/contracts";
import {
  deriveSendPromptCacheStatus,
  promptCacheNeedsAcknowledgement,
} from "@t3tools/shared/promptCache";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
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
    title: m(msg("Message not sent: Claude cache may be cold")),
    description: m(
      msg(
        "Compact with another model from the context menu, or explicitly send with an uncached read.",
      ),
    ),
    actionProps: { children: m(msg("Send anyway once")), onClick: sendAnyway },
  });
}
