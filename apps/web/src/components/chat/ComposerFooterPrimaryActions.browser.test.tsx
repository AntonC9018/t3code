import "~/index.css";

import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";
import { ComposerSurface } from "./ComposerSurface";
import { PromptCacheIndicator } from "./PromptCacheIndicator";

const TOKENS = 254_000;
const EXPIRED_CACHE = {
  promptCacheExpiresAt: "2026-01-01T00:00:00.000Z",
  promptCacheTtlMs: 3_600_000,
};

function Footer(props: {
  width: number;
  canResume?: boolean;
  compactBeforeSendTokens?: number | null;
}) {
  const noop = () => undefined;
  return (
    <div style={{ width: props.width }}>
      <ComposerSurface.Shell>
        {/* Mirrors the footer row in ChatComposer, which holds these controls. */}
        <div
          data-testid="footer"
          className="flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2"
        >
          <div className="me-2">
            <Control label="Attach" />
          </div>
          <div className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2">
            <div className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5" />
            <ComposerFooterPrimaryActions
              compact
              canOperateThread
              activeContextWindow={{
                usedTokens: TOKENS,
                maxTokens: 1_000_000,
                remainingTokens: 746_000,
                usedPercentage: 25,
                remainingPercentage: 75,
                updatedAt: "2026-01-01T00:00:00.000Z",
              }}
              cacheIndicator={
                <PromptCacheIndicator
                  driver={ProviderDriverKind.make("claudeAgent")}
                  usage={EXPIRED_CACHE}
                  hasContext
                />
              }
              reserveContextWindowMeter={false}
              activeThreadModelDisplayName={null}
              isPreparingWorktree={false}
              pendingAction={null}
              isRunning={false}
              canInterrupt={false}
              followUpBehavior="queue"
              canSteer
              alternateShortcutLabel={null}
              showPlanFollowUpPrompt={false}
              promptHasText={false}
              isSendBusy={false}
              sendDisabledReason={null}
              isEnvironmentUnavailable={false}
              hasSendableContent={false}
              canResume={props.canResume ?? false}
              isEditingQueuedMessage={false}
              onSubmitMessage={noop}
              onResume={noop}
              onPreviousPendingQuestion={noop}
              onInterrupt={noop}
              onImplementPlanInNewThread={noop}
              compactDisabled={false}
              compactDisabledReason={null}
              compactBeforeSendTokens={
                props.compactBeforeSendTokens === undefined ? TOKENS : props.compactBeforeSendTokens
              }
              keepFullHistory={false}
              onToggleKeepFullHistory={noop}
            >
              <Control label="Dictate" />
            </ComposerFooterPrimaryActions>
          </div>
        </div>
      </ComposerSurface.Shell>
    </div>
  );
}

function Control(props: { label: string }) {
  return <button type="button" className="size-7 shrink-0" aria-label={props.label} />;
}

function expectControlsToFit(footer: HTMLElement) {
  const bounds = footer.getBoundingClientRect();
  const controls = [...footer.querySelectorAll<HTMLElement>('button, [tabindex="0"]')]
    .filter((control) => control.getClientRects().length > 0)
    .map((control) => ({
      name: control.getAttribute("aria-label") ?? control.textContent,
      rect: control.getBoundingClientRect(),
    }))
    .toSorted((a, b) => a.rect.left - b.rect.left);
  controls.forEach(({ name, rect }, index) => {
    expect(rect.left, `${name} starts inside the footer`).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right, `${name} ends inside the footer`).toBeLessThanOrEqual(bounds.right);
    const next = controls[index + 1];
    if (next) expect(rect.right, `${name} clears ${next.name}`).toBeLessThanOrEqual(next.rect.left);
  });
}

describe("ComposerFooterPrimaryActions", () => {
  it.each([280, 300, 320, 344, 360, 361, 412, 480, 481, 600])(
    "keeps a cold thread's controls apart at %ipx",
    async (width) => {
      await using screen = await render(<Footer width={width} />);
      await expect
        .element(screen.getByRole("button", { name: /^Compact .* before sending$/ }))
        .toBeVisible();
      expectControlsToFit(screen.getByTestId("footer").element() as HTMLElement);
    },
  );

  it("lets the compact chip stand in for the cold cache label only on narrow composers", async () => {
    await using screen = await render(<Footer width={320} />);
    await expect.element(screen.getByText("Cache expired")).not.toBeVisible();
    await screen.rerender(<Footer width={412} />);
    await expect.element(screen.getByText("Cache expired")).toBeVisible();
  });

  it.each([
    { label: "no compact chip is offered", props: { compactBeforeSendTokens: null } },
    { label: "Resume replaces the compact chip", props: { canResume: true } },
  ])("keeps the cold cache label on narrow composers when $label", async ({ props }) => {
    await using screen = await render(<Footer width={320} {...props} />);
    await expect.element(screen.getByText("Cache expired")).toBeVisible();
    expectControlsToFit(screen.getByTestId("footer").element() as HTMLElement);
  });
});
