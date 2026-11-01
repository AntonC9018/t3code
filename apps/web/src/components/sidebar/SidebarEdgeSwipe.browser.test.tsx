import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebarVisibility } from "../ui/sidebar";
import { SidebarEdgeSwipe } from "./SidebarEdgeSwipe";
import { runSidebarRevealWhenReady } from "./routeReveal";
import { useStableCallback } from "../../hooks/useStableCallback";

const mobile = vi.hoisted(() => ({ value: true }));
vi.mock(import("../../hooks/useMediaQuery"), () => ({ useMediaQuery: () => mobile.value }));

function TestSidebar() {
  return (
    <SidebarProvider>
      <SidebarTrigger />
      <SidebarEdgeSwipe />
      <Sidebar>
        <p>Project navigation</p>
        <input aria-label="Navigation filter" />
      </Sidebar>
    </SidebarProvider>
  );
}

function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  extra: PointerEventInit = {},
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      ...extra,
    }),
  );
}

const edge = (container: HTMLElement) => {
  const element = container.querySelector("[data-sidebar-edge-swipe]");
  if (!element) throw new Error("Mobile edge target missing");
  return element;
};

describe("mobile sidebar edge swipe", () => {
  it("opens during the drag without waiting for finger-up", async () => {
    mobile.value = true;
    await using screen = await render(<TestSidebar />);
    const target = edge(screen.container);
    pointer(target, "pointerdown", 8, 300);
    pointer(target, "pointermove", 90, 310);
    await expect.element(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
    await expect.element(page.getByText("Project navigation")).toBeVisible();
  });

  it("retains navigation when closed so reopening does not mount it again", async () => {
    mobile.value = true;
    await using screen = await render(<TestSidebar />);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Navigation filter"]');
    expect(input).not.toBeNull();
    await screen.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("textbox", { name: "Navigation filter" }).fill("retained filter");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.elementLocator(input!)).not.toBeVisible();
    await screen.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Navigation filter" }))
      .toHaveValue("retained filter");
    expect(document.querySelector('input[aria-label="Navigation filter"]')).toBe(input);
  });

  it.each(["vertical", "short", "leftward", "cancelled", "mouse", "multitouch"])(
    "ignores a %s gesture",
    async (kind) => {
      mobile.value = true;
      await using screen = await render(<TestSidebar />);
      const target = edge(screen.container);
      await act(() => {
        pointer(target, "pointerdown", 8, 300, kind === "mouse" ? { pointerType: "mouse" } : {});
        if (kind === "vertical") pointer(target, "pointermove", 10, 350);
        if (kind === "leftward") pointer(target, "pointermove", -20, 300);
        if (kind === "cancelled") pointer(target, "pointercancel", 8, 300);
        if (kind === "multitouch")
          pointer(target, "pointerdown", 12, 300, { isPrimary: false, pointerId: 2 });
        pointer(target, "pointerup", kind === "short" ? 25 : 100, 305);
      });
      await expect
        .element(page.getByRole("dialog", { name: "Sidebar", exact: true }))
        .not.toBeInTheDocument();
    },
  );

  it("leaves desktop interaction unchanged", async () => {
    mobile.value = false;
    await using screen = await render(<TestSidebar />);
    expect(screen.container.querySelector("[data-sidebar-edge-swipe]")).toBeNull();
    await expect.element(page.getByText("Project navigation")).toBeVisible();
  });
});

function RevealTarget() {
  const visible = useSidebarVisibility();
  const target = useRef<HTMLDivElement>(null);
  const reveal = useStableCallback(() => {
    if (!target.current || target.current.getClientRects().length === 0) return false;
    target.current.scrollIntoView({ block: "nearest" });
    return true;
  });
  useEffect(() => {
    if (visible) return runSidebarRevealWhenReady(reveal);
  }, [visible, reveal]);
  return (
    <div style={{ height: 100, overflow: "auto" }} data-testid="reveal-scroll">
      <div data-sidebar="content">
        <div style={{ height: 1000 }} />
        <div ref={target}>Active thread</div>
      </div>
    </div>
  );
}

it("reveals a retained row after the sheet becomes physically visible", async () => {
  mobile.value = true;
  await using screen = await render(
    <SidebarProvider>
      <SidebarTrigger />
      <Sidebar>
        <RevealTarget />
      </Sidebar>
    </SidebarProvider>,
  );
  await screen.getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect.element(page.getByText("Active thread")).toBeVisible();
  await vi.waitFor(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="reveal-scroll"]');
    expect(viewport?.scrollTop).toBeGreaterThan(0);
  });
});
