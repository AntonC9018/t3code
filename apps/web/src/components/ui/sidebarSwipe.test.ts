import { describe, expect, it } from "vite-plus/test";

import { isSidebarSwipeOpenIntent, isSidebarSwipeStart } from "./sidebarSwipe";

describe("sidebar swipe activation", () => {
  it("accepts starts from the first half of the screen", () => {
    expect(isSidebarSwipeStart(0, 400, "left")).toBe(true);
    expect(isSidebarSwipeStart(199, 400, "left")).toBe(true);
    expect(isSidebarSwipeStart(201, 400, "left")).toBe(false);
    expect(isSidebarSwipeStart(399, 400, "right")).toBe(true);
    expect(isSidebarSwipeStart(199, 400, "right")).toBe(false);
  });

  it("opens only for a decisive horizontal drag toward the sidebar", () => {
    expect(isSidebarSwipeOpenIntent(80, 20, 140, 25, "left")).toBe(true);
    expect(isSidebarSwipeOpenIntent(80, 20, 120, 25, "left")).toBe(false);
    expect(isSidebarSwipeOpenIntent(80, 20, 140, 80, "left")).toBe(false);
    expect(isSidebarSwipeOpenIntent(300, 20, 240, 25, "right")).toBe(true);
    expect(isSidebarSwipeOpenIntent(300, 20, 240, 25, "left")).toBe(false);
  });
});
