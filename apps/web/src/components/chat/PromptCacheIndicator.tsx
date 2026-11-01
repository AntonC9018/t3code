import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { OrchestrationV2ProviderTurnTokenUsage, ProviderDriverKind } from "@t3tools/contracts";
import { derivePromptCacheStatus } from "@t3tools/shared/promptCache";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useNowAfter } from "~/hooks/useDeadline";
import { cn } from "~/lib/utils";

export function PromptCacheIndicator(props: {
  driver: ProviderDriverKind | undefined;
  usage?:
    | Pick<OrchestrationV2ProviderTurnTokenUsage, "promptCacheExpiresAt" | "promptCacheTtlMs">
    | null
    | undefined;
  hasContext: boolean;
}) {
  const minute = useNowMinute();
  const expiry = Date.parse(props.usage?.promptCacheExpiresAt ?? "");
  const afterDeadline = useNowAfter(Number.isFinite(expiry) ? expiry : null);
  const nowMs = Math.max(Date.parse(`${minute}:00.000Z`), afterDeadline);
  const status = derivePromptCacheStatus({ ...props, nowMs });
  if (status.state === "unsupported" || status.state === "fresh") return null;
  const cold = status.state === "expired" || status.state === "unknown";
  const label = cold
    ? status.state === "unknown"
      ? "Cache unknown"
      : "Cache expired"
    : `Cache ~${Math.ceil((status.remainingMs ?? 0) / 60_000)}m`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn(
          "shrink-0 text-2xs tabular-nums",
          cold
            ? "text-destructive"
            : status.state === "expiring"
              ? "text-warning"
              : "text-muted-foreground",
        )}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>
        Estimated prompt-cache lifetime. Changes to the prompt or model can invalidate cached
        context earlier.
        {Number.isFinite(expiry) ? ` Estimated expiry: ${new Date(expiry).toLocaleString()}.` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
