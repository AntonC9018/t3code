const SIDEBAR_SWIPE_START_WIDTH_RATIO = 0.5;
const SIDEBAR_SWIPE_DISTANCE = 56;
const SIDEBAR_SWIPE_AXIS_RATIO = 1.25;

export function isSidebarSwipeStart(
  x: number,
  viewportWidth: number,
  side: "left" | "right",
): boolean {
  const activationWidth = viewportWidth * SIDEBAR_SWIPE_START_WIDTH_RATIO;
  return side === "left" ? x <= activationWidth : x >= viewportWidth - activationWidth;
}

export function isSidebarSwipeOpenIntent(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  side: "left" | "right",
  minimumDistance = SIDEBAR_SWIPE_DISTANCE,
): boolean {
  const deltaX = currentX - startX;
  const deltaY = Math.abs(currentY - startY);
  const towardSidebar = side === "left" ? deltaX > 0 : deltaX < 0;
  return (
    towardSidebar &&
    Math.abs(deltaX) >= minimumDistance &&
    Math.abs(deltaX) >= deltaY * SIDEBAR_SWIPE_AXIS_RATIO
  );
}

const SIDEBAR_SWIPE_EXCLUDED_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-sidebar-swipe-ignore]",
].join(",");

export function canStartSidebarSwipe(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(SIDEBAR_SWIPE_EXCLUDED_TARGETS)) return false;

  for (let element: Element | null = target; element; element = element.parentElement) {
    const overflowX = window.getComputedStyle(element).overflowX;
    if (
      (overflowX === "auto" || overflowX === "scroll") &&
      element.scrollWidth > element.clientWidth
    ) {
      return false;
    }
  }

  return true;
}
