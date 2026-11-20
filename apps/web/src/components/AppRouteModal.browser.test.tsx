import { useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { startMainAppLocationTracking } from "./sidebar/mainAppLocation";
import { AppRouteModal, AppRouteModalClose } from "./AppRouteModal";

function ModalRoute() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname === "/usage" ? (
    <AppRouteModal label="Usage">
      <AppRouteModalClose />
    </AppRouteModal>
  ) : (
    <div>Chat</div>
  );
}

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("returns to the chat without waiting for a closing animation", async () => {
    await using screen = await render(<ModalRoute />, { router: "/thread" });
    using tracking = new DisposableStack();
    tracking.defer(startMainAppLocationTracking(screen.router!));
    await act(() => screen.router!.navigate({ href: "/usage" }));
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toBeVisible();

    const animation = document.body.animate({ opacity: [1, 1] }, { duration: 60_000 });
    tracking.defer(() => animation.cancel());
    animation.pause();
    using _animations = vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([animation]);

    await userEvent.keyboard("{Escape}");

    expect(screen.router!.state.location.pathname).toBe("/thread");
    await expect.element(screen.getByText("Chat", { exact: true })).toBeVisible();
  });

  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("returns focus to the opener when Esc closes it", async () => {
    const opener = <button type="button">Open usage</button>;
    await using screen = await render(opener, { router: "/" });
    const openerButton = screen.getByRole("button", { name: "Open usage" });
    (openerButton.element() as HTMLElement).focus();

    await screen.rerender(
      <>
        {opener}
        <AppRouteModal label="Usage">
          <p>Usage</p>
        </AppRouteModal>
      </>,
    );
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    await expect.element(openerButton).toHaveFocus();
  });

  it("stays open when Esc belongs to a modal outside Base UI", async () => {
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={() => undefined} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    // Base UI takes initial focus a frame after opening; let it land before Clerk's modal takes focus.
    await expect.element(settings).toHaveFocus();
    // Clerk renders its account modal in its own root and dismisses on a document Esc listener.
    const foreignModal = document.body.appendChild(document.createElement("input"));
    using _foreignModal = { [Symbol.dispose]: () => foreignModal.remove() };

    foreignModal.focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(settings).toHaveAttribute("data-open");
  });
});
