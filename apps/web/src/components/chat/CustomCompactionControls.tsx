import { useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { orchestrationEnvironment } from "~/state/orchestration";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";

export function CustomCompactionControls(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
  disabled: boolean;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const candidates = providers.filter((provider) => provider.supportsTextGeneration !== false);
  const entries = providerInstanceEntriesFor(candidates, settings, props.projectId);
  const [selected, setSelected] = useState<ModelSelection | null>(null);
  const selection =
    selected ??
    settings.customCompactionModelSelection ??
    resolveAppModelSelectionState(settings, candidates);
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    candidates,
    selection.instanceId,
    selection.model,
  );
  const canCompact = useAtomValue(
    orchestrationEnvironment.compactContext.permissionAtom(props.environmentId),
  );
  const compact = useOrchestrationCommand(orchestrationEnvironment.compactContext);
  const requestInFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled =
    props.disabled ||
    pending ||
    !canCompact ||
    !entry?.enabled ||
    !entry.isAvailable ||
    !entry.installed;
  const saveSelection = (next: ModelSelection) => {
    setSelected(next);
    updateSettings({ customCompactionModelSelection: next });
  };
  const run = async () => {
    if (disabled || requestInFlight.current) return;
    requestInFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await compact({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          commandId: CommandId.make(randomUUID()),
          modelSelection: selection,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not compact context.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not compact context.");
    }
    requestInFlight.current = false;
    setPending(false);
  };
  return (
    <>
      <Separator />
      <div className="text-xs font-medium text-muted-foreground">Compact with another model</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          triggerAriaLabel="Compaction model"
          disabled={pending}
          onInstanceModelChange={(instanceId, model) =>
            saveSelection(createModelSelection(instanceId, model))
          }
        />
        {entry ? (
          <TraitsPicker
            provider={entry.driverKind}
            models={entry.models}
            model={selection.model}
            modelOptions={selection.options}
            allowPromptInjectedEffort={false}
            planModeEnabled={false}
            onModelOptionsChange={(options) =>
              saveSelection(createModelSelection(selection.instanceId, selection.model, options))
            }
          />
        ) : null}
      </div>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => void run()}>
        {pending ? "Compacting…" : "Compact with selected model"}
      </Button>
      {error ? (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </>
  );
}
