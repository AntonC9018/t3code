import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarQuickActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="icon"
        aria-label="Usage"
        title="Usage"
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
