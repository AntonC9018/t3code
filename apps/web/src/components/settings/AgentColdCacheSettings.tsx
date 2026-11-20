import { AgentColdCachePolicy, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const POLICIES = {
  block: msg("Block the send"),
  allow: msg("Allow the uncached read"),
  compact: msg("Compact with another model first"),
} satisfies Record<AgentColdCachePolicy, string>;

export function AgentColdCacheRow() {
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["agentColdCachePolicy"]);
  const compactionModel = settings.customCompactionModelSelection;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentColdCachePolicy"]}
      {...searchableSetting("agent-cold-cache-policy")}
      description={gt(
        "What agent and scheduled-task messages do when a Claude thread's prompt cache is expired or unknown, since nobody is there to confirm an uncached read.",
      )}
      status={
        !mixed && settings.agentColdCachePolicy === "compact"
          ? compactionModel === null
            ? gt(
                "No compaction model chosen yet. Compact a thread with another model once to choose it; until then these sends are blocked.",
              )
            : gt("Compacts with {model}, the model last chosen in the compaction menu.", {
                model: compactionModel.model,
              })
          : undefined
      }
      resetAction={
        mixed || settings.agentColdCachePolicy !== DEFAULT_SERVER_SETTINGS.agentColdCachePolicy ? (
          <SettingResetButton
            ariaLabel={gt("Reset agent cold cache policy")}
            onClick={() =>
              updateSettings({ agentColdCachePolicy: DEFAULT_SERVER_SETTINGS.agentColdCachePolicy })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.agentColdCachePolicy}
          onValueChange={(value) => {
            if (AgentColdCachePolicy.literals.includes(value as AgentColdCachePolicy))
              updateSettings({ agentColdCachePolicy: value as AgentColdCachePolicy });
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Agent sends to a cold Claude cache")}>
            <SelectValue>
              {(value: AgentColdCachePolicy | null) =>
                value === null ? gt("Mixed") : m(POLICIES[value])
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AgentColdCachePolicy.literals.map((policy) => (
              <SelectItem key={policy} value={policy}>
                {m(POLICIES[policy])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
