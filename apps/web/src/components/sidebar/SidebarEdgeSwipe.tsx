import { useRef, type PointerEvent } from "react";

import { useSidebar } from "../ui/sidebar";

export function SidebarEdgeSwipe() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const gesture = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  if (!isMobile || openMobile) return null;

  const start = (event: PointerEvent<HTMLDivElement>) => {
    gesture.current =
      event.pointerType === "touch" && event.isPrimary
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = gesture.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    const dy = Math.abs(event.clientY - origin.y);
    if (dx < -12 || (dy > 12 && dy > Math.abs(dx))) {
      gesture.current = null;
      return;
    }
    if (dx >= 24 && dx > dy * 2) {
      gesture.current = null;
      setOpenMobile(true);
    }
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const origin = gesture.current;
    gesture.current = null;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    const dy = Math.abs(event.clientY - origin.y);
    if (dx >= 24 && dx > dy * 2) setOpenMobile(true);
  };
  const cancel = () => {
    gesture.current = null;
  };

  return (
    <div
      aria-hidden="true"
      className="fixed inset-y-0 left-0 z-30 w-5 touch-pan-y"
      data-sidebar-edge-swipe=""
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    />
  );
}
