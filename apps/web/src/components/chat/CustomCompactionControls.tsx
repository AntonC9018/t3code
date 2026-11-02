import { useContext, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describeCustomCompactionFailure } from "@t3tools/client-runtime/handoff";
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
import { toastManager } from "../ui/toast";
import { Separator } from "../ui/separator";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";

interface CompactionRequestState {
  readonly pending: boolean;
  readonly error: string | null;
}

/**
 * Kept outside the popover, which unmounts when it closes: the request keeps running on the
 * server, so reopening the menu must still show it and its result.
 */
const compactionRequestAtom = Atom.family((threadKey: string) =>
  Atom.make<CompactionRequestState>({ pending: false, error: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`custom-compaction:${threadKey}`),
  ),
);

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
  const registry = useContext(RegistryContext);
  const requestAtom = compactionRequestAtom(
    scopedThreadKey({ environmentId: props.environmentId, threadId: props.threadId }),
  );
  const { pending, error } = useAtomValue(requestAtom);
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
    if (disabled || registry.get(requestAtom).pending) return;
    registry.set(requestAtom, { pending: true, error: null });
    let failure: string | null = null;
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
        failure = describeCustomCompactionFailure(squashAtomCommandFailure(result));
      }
    } catch (cause) {
      failure = describeCustomCompactionFailure(cause);
    }
    registry.set(requestAtom, { pending: false, error: failure });
    toastManager.add(
      failure === null
        ? { type: "success", title: "Context compacted" }
        : { type: "error", title: "Could not compact context", description: failure },
    );
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
