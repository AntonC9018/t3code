import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  turns: [] as unknown[],
  coldCache: true,
  toastSendAnyway: null as (() => void) | null,
}));

vi.mock("./promptCacheSend", () => ({
  sendNeedsPromptCacheAcknowledgement: () => state.coldCache,
  showColdPromptCacheToast: (sendAnyway: () => void) => {
    state.toastSendAnyway = sendAnyway;
  },
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => async (value: { readonly input: unknown }) => {
    state.turns.push(value.input);
    return AsyncResult.success(undefined);
  }) as never,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useClientSettingsHydrated: () => true,
}));

import { render } from "../../../test/render";
import { disarmFreshSession, readFreshSessionArm } from "./freshSessionArms";
import { useComposerSend } from "./useComposerSend";

const environmentId = EnvironmentId.make("environment:cold-send");
const threadId = ThreadId.make("thread:cold-send");
const routeThreadKey = "environment:cold-send:thread:cold-send";
const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };

function setup() {
  state.turns = [];
  state.coldCache = true;
  state.toastSendAnyway = null;
  disarmFreshSession(routeThreadKey);
  return { promptRef: { current: "" } };
}

function SendButton(props: {
  readonly promptRef: { current: string };
  readonly planFollowUp?: boolean;
}) {
  const { onSend } = useComposerSend({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef: { current: routeThreadKey },
    draftId: null,
    draftThread: null,
    activeThread: {
      id: threadId,
      environmentId,
      title: "Cold thread",
      worktreePath: null,
      createdAt: "2026-11-07T00:00:00.000Z",
      activeProviderThreadId: null,
    },
    activeThreadKey: routeThreadKey,
    activeThreadBranch: null,
    activeProject: {
      id: ProjectId.make("project:cold-send"),
      environmentId,
      workspaceRoot: "/repo",
    },
    activeProposedPlan: props.planFollowUp ? { id: "plan:cold", planMarkdown: "# Plan" } : null,
    activeProjectDefaultModelSelection: null,
    activeMessageCount: 2,
    isServerThread: true,
    isLocalDraftThread: false,
    isGitRepo: false,
    phase: "ready",
    runtimeMode: "full-access",
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [],
    providerInstanceEntries: [],
    composerRef: {
      current: {
        getSendContext: () => ({
          images: [],
          files: [],
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          threadContexts: [],
          environmentContexts: [],
          multipleModelSelections: null,
          shownPendingApprovalIds: [],
          providerAvailable: true,
          selectedProvider: "claudeAgent",
          selectedModel: modelSelection.model,
          selectedProviderModels: [],
          selectedPromptEffort: null,
          selectedModelSelection: modelSelection,
          interactionMode: "default",
          interactionModeEnabled: props.planFollowUp === true,
        }),
        validateProviderInput: () => true,
        hasPendingAttachments: () => false,
        resetCursorState: () => undefined,
      },
    },
    composerDraftTarget: { environmentId, threadId },
    promptRef: props.promptRef,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    queuedRunEdit: { isEditing: false },
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: false,
    freshSessionAvailable: true,
    resumeCompactionTokens: null,
    showPlanFollowUpPrompt: props.planFollowUp === true,
    usageLimitsKey: null,
    usageLimitsOffered: false,
    openUsageLimits: () => false,
    clearUsageLimitsFor: () => undefined,
    needsLoadBalancing: false,
    loadBalancing: { pending: [] },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: null,
    onAdvanceActivePendingUserInput: () => undefined,
    onRespondToApproval: async () => undefined,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    beginWorktreeSetup: () => undefined,
    captureDraftHeroComposerRect: () => undefined,
    setDockedDraftHeroThreadKey: () => undefined,
    setSetupQueueSendThreadKey: () => undefined,
    setOptimisticUserMessages: () => undefined,
    optimisticBlobPreviews: { track: () => undefined, release: () => undefined },
    setFeedbackSubmissionsByThreadKey: () => undefined,
    setThreadError: () => undefined,
    setKeepFullHistory: () => undefined,
    anchorNewTurn: () => undefined,
    acknowledgeActiveThreadWoke: () => undefined,
    handleInteractionModeChange: () => undefined,
    sideChatDisabledReason: null,
    handleNewThreadInActiveProject: () => undefined,
    persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
  } as never);
  return (
    <button type="button" onClick={() => void onSend()}>
      Send
    </button>
  );
}

it("arms /clear on a cold cache and sends the next message fresh without asking", async () => {
  const { promptRef } = setup();
  await using screen = await render(<SendButton promptRef={promptRef} />);
  const send = screen.getByRole("button", { name: "Send" });

  promptRef.current = "/clear";
  await send.click();
  await vi.waitFor(() => expect(readFreshSessionArm(routeThreadKey)).toBeDefined());
  expect(promptRef.current).toBe("");
  expect(state.toastSendAnyway).toBeNull();
  expect(state.turns).toEqual([]);

  promptRef.current = "Start over";
  await send.click();
  await vi.waitFor(() => expect(state.turns).toHaveLength(1));
  expect(state.turns[0]).toMatchObject({ threadId, freshContext: true });
  expect(state.toastSendAnyway).toBeNull();
});

it("holds a cold send until it is acknowledged, then sends it once", async () => {
  const { promptRef } = setup();
  await using screen = await render(<SendButton promptRef={promptRef} />);

  promptRef.current = "Keep going";
  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(state.toastSendAnyway).not.toBeNull());
  expect(state.turns).toEqual([]);
  expect(promptRef.current).toBe("Keep going");

  state.toastSendAnyway!();
  await vi.waitFor(() => expect(state.turns).toHaveLength(1));
  expect(state.turns[0]).toMatchObject({
    threadId,
    message: { allowUncachedRead: true, text: "Keep going" },
  });
  expect(state.turns[0]).not.toHaveProperty("freshContext");
});

it("carries the acknowledgement through a cold plan follow-up", async () => {
  const { promptRef } = setup();
  await using screen = await render(<SendButton promptRef={promptRef} planFollowUp />);

  promptRef.current = "Refine the plan";
  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(state.toastSendAnyway).not.toBeNull());
  expect(state.turns).toEqual([]);

  state.toastSendAnyway!();
  await vi.waitFor(() => expect(state.turns).toHaveLength(1));
  expect(state.turns[0]).toMatchObject({
    threadId,
    message: { allowUncachedRead: true },
  });
});
