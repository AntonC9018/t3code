import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { derivePromptCacheStatus } from "@t3tools/shared/promptCache";
import { useGT } from "gt-react-native";
import { useNowAfter, useNowMinuteMs } from "../../lib/clock";
import { AppText as Text } from "../../components/ui/AppText";

export function PromptCacheIndicator(props: { cache: OrchestrationV2ThreadShell["promptCache"] }) {
  const gt = useGT();
  const minute = useNowMinuteMs();
  const expiry = Date.parse(props.cache?.usage?.promptCacheExpiresAt ?? "");
  const now = useNowAfter(Number.isFinite(expiry) ? expiry : null);
  const status = derivePromptCacheStatus({
    driver: undefined,
    hasContext: false,
    ...props.cache,
    nowMs: Math.max(now, minute),
  });
  if (status.state === "unsupported" || status.state === "fresh") return null;
  const cold = status.state === "expired" || status.state === "unknown";
  return (
    <Text className={cold ? "text-xs text-error" : "text-xs text-foreground-muted"}>
      {cold
        ? status.state === "expired"
          ? gt("Cache expired")
          : gt("Cache unknown")
        : gt("Cache ~{minutes}m", { minutes: Math.ceil((status.remainingMs ?? 0) / 60_000) })}
    </Text>
  );
}
