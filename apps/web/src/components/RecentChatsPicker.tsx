import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { LegendListRef } from "@legendapp/list/react";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { onOpenRecentChats } from "../recentChatsBus";
import { recordRecentChatVisit, useRecentChatsStore } from "../recentChatsStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useEnvironmentLookups } from "./CommandPaletteLookups";
import {
  buildRecentChatEntries,
  filterRecentChatEntries,
  resolveInitialRecentChatKey,
  resolveRecentChatActiveKey,
  stepRecentChatKey,
} from "./RecentChatsPicker.logic";
import {
  buildCommandPaletteRows,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { toastManager } from "./ui/toast";

function useRecentChatEntries() {
  const threads = useThreadShells();
  const visits = useRecentChatsStore((state) => state.visits);
  const projects = useProjects();
  const { environmentLabelById } = useEnvironmentLookups();

  const projectTitleByKey = new Map(
    projects.map(
      (project) =>
        [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project.title,
        ] as const,
    ),
  );
  const entries = buildRecentChatEntries({
    threads,
    visits,
    projectTitleByKey,
    environmentLabelById,
  });

  return { entries, showEnvironmentLabels: environmentLabelById.size > 1 };
}

function useRecentChatVisitTracking() {
  const routeTarget = useThreadRouteTarget();
  const environmentId = routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null;
  const threadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    recordRecentChatVisit(scopeThreadRef(environmentId, threadId));
  }, [environmentId, threadId]);
}

export function RecentChatsPicker() {
  const [open, setOpen] = useState(false);
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const currentThreadKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  useRecentChatVisitTracking();

  useEffect(() => onOpenRecentChats(() => setOpen(true)), []);

  const toggleOpen = useEffectEvent(() => setOpen((current) => !current));

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        isCommandPaletteOpen() ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "recentChats.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      // Holding the shortcut must not toggle the dialog repeatedly.
      if (event.repeat) return;
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, previewOpen, terminalOpen]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {open ? (
        <RecentChatsDialog
          currentThreadKey={currentThreadKey}
          keybindings={keybindings}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </CommandDialog>
  );
}

function RecentChatsDialog(props: {
  readonly currentThreadKey: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const { entries, showEnvironmentLabels } = useRecentChatEntries();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listRef = useRef<LegendListRef | null>(null);

  const visibleEntries = filterRecentChatEntries(entries, query);
  const items: CommandPaletteActionItem[] = visibleEntries.map((entry) => {
    const descriptionParts: string[] = [];
    if (entry.projectTitle !== null) descriptionParts.push(entry.projectTitle);
    if (entry.key === props.currentThreadKey) {
      descriptionParts.push("Current chat");
    } else if (showEnvironmentLabels && entry.environmentLabel !== null) {
      descriptionParts.push(entry.environmentLabel);
    }

    return {
      kind: "action",
      value: entry.key,
      searchTerms: [entry.title, entry.projectTitle ?? "", entry.environmentLabel ?? ""],
      title: entry.title,
      description: descriptionParts.join(" · "),
      timestamp: formatRelativeTimeLabel(new Date(entry.visitedAt).toISOString()),
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        props.onClose();
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(entry.threadRef),
        });
      },
    };
  });
  const groups: CommandPaletteGroup[] =
    items.length === 0 ? [] : [{ value: "recent-chats", label: "Recent chats", items }];
  const resultRows = buildCommandPaletteRows(groups);
  const visibleKeys = visibleEntries.map((entry) => entry.key);
  const initialKey =
    query.trim().length > 0
      ? (visibleKeys[0] ?? null)
      : resolveInitialRecentChatKey(visibleEntries, props.currentThreadKey);
  const activeKey =
    selectedKey === null ? initialKey : resolveRecentChatActiveKey(visibleKeys, selectedKey);

  const executeItem = (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
    if (item.kind !== "action" || item.disabled) return;
    void item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not open chat",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      const nextKey = stepRecentChatKey(
        visibleKeys,
        activeKey,
        event.key === "ArrowDown" ? "next" : "previous",
      );
      if (nextKey === null) return;
      setSelectedKey(nextKey);
      const itemIndex = resultRows.itemValues.indexOf(nextKey);
      if (itemIndex !== -1) {
        scrollCommandPaletteRowIntoView(
          listRef.current,
          resultRows.rowIndexByItemIndex[itemIndex] ?? 0,
        );
      }
      return;
    }

    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const item = items.find((candidate) => candidate.value === activeKey);
      if (!item) return;
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      event.stopPropagation();
      executeItem(item);
    }
  };

  return (
    <CommandDialogPopup
      aria-label="Recent chats"
      className="overflow-hidden"
      data-recent-chats-picker="true"
      data-testid="recent-chats-picker"
      onBackdropPointerDown={props.onClose}
    >
      <CommandPaletteContent
        aria-label="Recent chats"
        autoHighlight={false}
        escapeLabel="Close"
        footerActionLabel={items.length > 0 ? "Open" : undefined}
        inputProps={{
          placeholder: "Search recent chats...",
          onKeyDown: handleKeyDown,
        }}
        mode="none"
        items={resultRows.itemValues}
        virtualized
        onItemHighlighted={(value, eventDetails) => {
          if (eventDetails.reason === "pointer" && typeof value === "string") {
            setSelectedKey(value);
          }
        }}
        onValueChange={(nextQuery) => {
          setQuery(nextQuery);
          setSelectedKey(null);
        }}
        value={query}
      >
        <CommandPaletteVirtualizedResults
          rows={resultRows.rows}
          listRef={listRef}
          highlightedItemValue={activeKey}
          isActionsOnly={false}
          keybindings={props.keybindings}
          onExecuteItem={executeItem}
          emptyStateMessage={
            query.trim().length > 0 ? "No matching recent chats." : "No recently visited chats yet."
          }
        />
      </CommandPaletteContent>
    </CommandDialogPopup>
  );
}
