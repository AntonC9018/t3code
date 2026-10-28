import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Sidebar, SidebarProvider } from "../ui/sidebar";
import { SidebarEdgeSwipe } from "./SidebarEdgeSwipe";

const mobile = vi.hoisted(() => ({ value: true }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => mobile.value }));

function TestSidebar() {
  return (
    <SidebarProvider>
      <SidebarEdgeSwipe />
      <Sidebar>
        <p>Project navigation</p>
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
  it("opens the actual sidebar after a rightward touch swipe", async () => {
    mobile.value = true;
    await using screen = await render(<TestSidebar />);
    const target = edge(screen.container);
    pointer(target, "pointerdown", 8, 300);
    pointer(target, "pointermove", 90, 310);
    pointer(target, "pointerup", 100, 312);
    await expect.element(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
    await expect.element(page.getByText("Project navigation")).toBeVisible();
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
