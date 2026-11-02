import {
  derivePromptCacheStatus,
  promptCacheNeedsAcknowledgement,
} from "@t3tools/shared/promptCache";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  describeCompactionProgress,
  describeCustomCompactionFailure,
} from "@t3tools/client-runtime/handoff";
import {
  CommandId,
  MessageId,
  isProviderTextGenerationCapable,
  type EnvironmentId,
  type ModelSelection,
  type ServerConfig,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { View } from "react-native";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";

/** Reads the clock at choice time; kept outside the component so render stays pure. */
function shellCacheNeedsAcknowledgement(promptCache: EnvironmentThreadShell["promptCache"]) {
  return promptCacheNeedsAcknowledgement(
    derivePromptCacheStatus({
      driver: undefined,
      hasContext: false,
      ...promptCache,
      nowMs: Date.now(),
    }),
  );
}

export function ThreadCompactionMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  readonly config: ServerConfig;
  readonly disabled: boolean;
  readonly cacheReadRequiresAcknowledgement: boolean;
}) {
  const permitted = useAtomValue(
    orchestrationEnvironment.compactContext.permissionAtom(props.environmentId),
  );
  const canSaveSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const compact = useAtomCommand(orchestrationEnvironment.compactContext, { reportFailure: false });
  const cancelCompaction = useAtomCommand(orchestrationEnvironment.cancelCompaction, {
    reportFailure: false,
  });
  const running =
    useEnvironmentQuery(
      orchestrationEnvironment.compaction({
        environmentId: props.environmentId,
        input: { threadId: props.thread.id },
      }),
    ).data ?? null;
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [compacting, setCompacting] = useState<string | null>(null);
  const pending = useRef(false);
  // After a lost connection, retrying rejoins the compaction still running on the server.
  const retryCommandId = useRef<CommandId | null>(null);
  const remembered = props.config.settings.customCompactionModelSelection;
  const providers = props.config.providers.filter(isProviderTextGenerationCapable);
  const options = buildModelOptions(
    props.config,
    remembered ?? props.thread.modelSelection,
    undefined,
    props.thread.projectId,
  ).filter(
    (option) =>
      !option.isUnavailable &&
      !option.isHidden &&
      providers.some((provider) => provider.instanceId === option.selection.instanceId),
  );
  const rememberedOption = remembered
    ? options.find((option) => modelSelectionsEqual(option.selection, remembered))
    : undefined;
  const nativeAvailable =
    props.config.providers
      .find((provider) => provider.instanceId === props.thread.modelSelection.instanceId)
      ?.slashCommands.some((command) => command.name === "compact") === true;
  const disabled = props.disabled || compacting !== null || running !== null || !permitted;

  const reportError = (
    selection: ModelSelection | null,
    failure: { cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
  ) => {
    const error = squashAtomCommandFailure(failure);
    if (selection !== null && describeCustomCompactionFailure(error).cancelled) return;
    Dialog.alert(
      "Could not compact context",
      selection !== null
        ? describeCustomCompactionFailure(error).message
        : error instanceof Error
          ? error.message
          : "Try again after the current work finishes.",
    );
  };
  const compactWithModel = async (selection: ModelSelection) => {
    const commandId = retryCommandId.current ?? CommandId.make(uuidv4());
    const result = await compact({
      environmentId: props.environmentId,
      input: { threadId: props.thread.id, commandId, modelSelection: selection },
    });
    retryCommandId.current =
      result._tag === "Failure" &&
      describeCustomCompactionFailure(squashAtomCommandFailure(result)).connectionLost
        ? commandId
        : null;
    return result;
  };
  const dispatch = async (selection: ModelSelection | null, allowUncachedRead: boolean) => {
    const result =
      selection === null
        ? await startTurn({
            environmentId: props.environmentId,
            input: {
              threadId: props.thread.id,
              message: {
                messageId: MessageId.make(uuidv4()),
                role: "user",
                text: "/compact",
                attachments: [],
                allowUncachedRead,
              },
              runtimeMode: props.thread.runtimeMode,
              interactionMode: props.thread.interactionMode,
            },
          })
        : await compactWithModel(selection);
    if (result._tag === "Failure") {
      reportError(selection, result);
    } else if (selection !== null && canSaveSettings) {
      const saved = await saveSettings({
        environmentId: props.environmentId,
        input: { patch: { customCompactionModelSelection: selection } },
      });
      if (saved._tag === "Failure")
        Dialog.alert("Context compacted", "The compaction model preference could not be saved.");
    }
  };
  const run = async (selection: ModelSelection | null, allowUncachedRead = false) => {
    if (pending.current || disabled) return;
    pending.current = true;
    const label =
      selection === null
        ? "Native compaction"
        : (options.find((option) => modelSelectionsEqual(option.selection, selection))?.label ??
          selection.model);
    setCompacting(label);
    await dispatch(selection, allowUncachedRead).catch((cause: unknown) =>
      reportError(selection, { cause: Cause.die(cause) }),
    );
    pending.current = false;
    setCompacting(null);
  };
  const cancel = async () => {
    if (running === null) return;
    const result = await cancelCompaction({
      environmentId: props.environmentId,
      input: { threadId: props.thread.id, commandId: running.commandId },
    });
    if (result._tag === "Failure")
      Dialog.alert(
        "Could not cancel compaction",
        describeCustomCompactionFailure(squashAtomCommandFailure(result)).message,
      );
  };
  const choose = (id: string) => {
    if (id === "cancel") {
      void cancel();
      return;
    }
    if (id === "native") {
      if (
        props.cacheReadRequiresAcknowledgement ||
        shellCacheNeedsAcknowledgement(props.thread.promptCache)
      ) {
        Dialog.confirm({
          title: "Compact with an uncached read?",
          message:
            "Claude's cache is expired or unknown. Native compaction may reread the full context. Choose another model below to avoid resuming Claude.",
          confirmText: "Compact anyway once",
          onConfirm: () => void run(null, true),
        });
      } else {
        void run(null);
      }
      return;
    }
    const selection = options.find((option) => option.key === id)?.selection;
    if (selection) void run(selection);
  };

  return (
    <View>
      <Menu
        accessibilityLabel="Compact context"
        title="Compact context"
        actions={[
          ...(running !== null && permitted
            ? [{ id: "cancel", title: "Cancel compaction", attributes: { destructive: true } }]
            : []),
          {
            id: "native-section",
            title: "Native compaction",
            displayInline: true,
            subactions: [
              {
                id: "native",
                title: "Compact with current model",
                attributes: { disabled: disabled || !nativeAvailable },
              },
            ],
          },
          {
            id: "custom-section",
            title: "Compact with another model",
            displayInline: true,
            subactions: [
              ...(rememberedOption
                ? [
                    {
                      id: rememberedOption.key,
                      title: `Use ${rememberedOption.label}`,
                      attributes: { disabled },
                    },
                  ]
                : []),
              ...providers
                .map((provider) => ({
                  id: `provider:${provider.instanceId}`,
                  title: provider.displayName ?? provider.instanceId,
                  attributes: { disabled },
                  subactions: options
                    .filter((option) => option.selection.instanceId === provider.instanceId)
                    .map((option) => ({
                      id: option.key,
                      title: option.label,
                      state:
                        remembered && modelSelectionsEqual(option.selection, remembered)
                          ? ("on" as const)
                          : ("off" as const),
                      attributes: { disabled },
                    })),
                }))
                .filter((provider) => provider.subactions.length > 0),
            ],
          },
        ]}
        onPressAction={({ nativeEvent }) => choose(nativeEvent.event)}
      >
        <ComposerInlineControl
          icon="arrow.down.right.and.arrow.up.left"
          label={compacting || running ? "Compacting…" : "Compact context"}
          iconOnly
          disabled={props.disabled || !permitted}
        />
      </Menu>
      {running || compacting ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
          {running ? describeCompactionProgress(running) : `${compacting}…`}
        </Text>
      ) : null}
    </View>
  );
}
