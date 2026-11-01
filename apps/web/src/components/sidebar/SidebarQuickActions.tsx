import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { useState } from "react";

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

// This fork's Coder dashboard is reachable from phones on the same tailnet.
const CODER_URL = "https://laptop.tail380146.ts.net:8443";

function WindscribeControls({ environmentId }: { environmentId: EnvironmentId }) {
  const statusAtom = serverEnvironment.windscribeStatus({ environmentId, input: {} });
  const status = useAtomValue(statusAtom);
  const refresh = useAtomRefresh(statusAtom);
  const canChange = useAtomValue(
    serverEnvironment.setWindscribeEnabled.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setWindscribeEnabled, {
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  const value = AsyncResult.isSuccess(status) ? status.value : null;
  const connected = value?.state === "connected";
  const canToggle =
    !status.waiting && (value?.state === "connected" || value?.state === "disconnected");

  const toggle = async () => {
    if (pending || !canChange || !canToggle) return;
    setPending(true);
    await setEnabled({ environmentId, input: { enabled: !connected } })
      .then(() => refresh())
      .finally(() => setPending(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <PopoverTitle>Windscribe VPN</PopoverTitle>
        <p className="text-muted-foreground">Controls the primary T3 server’s VPN.</p>
      </div>
      <p role="status">
        {pending
          ? "Updating Windscribe…"
          : (value?.message ??
            (AsyncResult.isFailure(status)
              ? "Could not read VPN status."
              : "Checking VPN status…"))}
      </p>
      {!canChange ? (
        <p className="text-muted-foreground">
          Server maintenance permission is required to change the VPN.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={!canChange || !canToggle || pending} onClick={() => void toggle()}>
          {connected ? "Disconnect" : "Connect"}
        </Button>
        <Button variant="outline" disabled={pending} onClick={refresh}>
          Refresh status
        </Button>
      </div>
    </div>
  );
}

export function SidebarQuickActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const [vpnOpen, setVpnOpen] = useState(false);

  return (
    <>
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
      <SidebarMenuItem>
        <SidebarMenuButton
          size="icon"
          aria-label="Coder"
          title="Coder"
          render={<a href={CODER_URL} target="_blank" rel="noopener noreferrer" />}
        >
          <img src="/coder.svg" alt="" aria-hidden="true" className="size-4" />
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <Popover open={vpnOpen} onOpenChange={setVpnOpen}>
          <PopoverTrigger
            render={
              <SidebarMenuButton
                size="icon"
                aria-label="Windscribe VPN"
                title="Windscribe VPN"
                disabled={!environmentId}
              />
            }
          >
            <img src="/windscribe.ico" alt="" aria-hidden="true" className="size-4" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" width="md" touchBackdrop>
            {vpnOpen && environmentId ? (
              <WindscribeControls key={environmentId} environmentId={environmentId} />
            ) : null}
          </PopoverPopup>
        </Popover>
      </SidebarMenuItem>
    </>
  );
}
