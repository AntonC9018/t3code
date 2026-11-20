import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChartNoAxesColumnIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarQuickActions() {
  const gt = useGT();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const usageLabel = gt("Usage");

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="icon"
        aria-label={usageLabel}
        title={usageLabel}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: "/usage" });
        }}
      >
        <ChartNoAxesColumnIcon />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
