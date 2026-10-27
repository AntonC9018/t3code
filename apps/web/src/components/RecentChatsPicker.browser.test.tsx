import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { RecentChatsPicker } from "./RecentChatsPicker";

const pressCtrlE = () => userEvent.keyboard("{Control>}e{/Control}");

describe("RecentChatsPicker shortcut", () => {
  it("opens the picker when Ctrl+E is pressed", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(<RecentChatsPicker />);

    await expect.element(page.getByTestId("recent-chats-picker")).not.toBeInTheDocument();

    await pressCtrlE();

    await expect.element(page.getByTestId("recent-chats-picker")).toBeVisible();
  });

  it("closes the picker when Ctrl+E is pressed again", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(<RecentChatsPicker />);

    await pressCtrlE();
    await expect.element(page.getByTestId("recent-chats-picker")).toBeVisible();

    await pressCtrlE();
    await expect.element(page.getByTestId("recent-chats-picker")).not.toBeInTheDocument();
  });

  it("claims Ctrl+E ahead of the command palette", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using _screen = await render(
      <>
        <CommandPalette>{null}</CommandPalette>
        <RecentChatsPicker />
      </>,
    );

    await pressCtrlE();

    await expect.element(page.getByTestId("recent-chats-picker")).toBeVisible();
    await expect.element(page.getByTestId("command-palette")).not.toBeInTheDocument();
  });
});
