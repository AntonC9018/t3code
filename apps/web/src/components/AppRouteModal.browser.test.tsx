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
});
