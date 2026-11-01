import { useEffect, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";

const microphoneListingSupported = () => Boolean(navigator.mediaDevices?.enumerateDevices);

/** Lists audio inputs on mount and again on refresh or device change, while mounted. */
export function useAudioInputDevices(onError?: (error: unknown) => void) {
  const reportError = useStableCallback((error: unknown) => onError?.(error));
  const [loading, setLoading] = useState(microphoneListingSupported);
  const [listing, setListing] = useState<{
    readonly devices: MediaDeviceInfo[];
    readonly failed: boolean;
  }>({ devices: [], failed: false });
  const load = useStableCallback(() => {
    if (!microphoneListingSupported()) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setListing({
          devices: devices.filter((device) => device.kind === "audioinput"),
          failed: false,
        });
      })
      .catch((error: unknown) => {
        setListing((previous) => ({ ...previous, failed: true }));
        reportError(error);
      })
      .finally(() => setLoading(false));
  });
  const refresh = useStableCallback(() => {
    if (!microphoneListingSupported()) return;
    setLoading(true);
    load();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the audio inputs and re-lists them on devicechange, a browser event that fires while mounted
  useEffect(() => {
    load();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    mediaDevices.addEventListener("devicechange", refresh);
    return () => mediaDevices.removeEventListener("devicechange", refresh);
  }, [load, refresh]);
  return { ...listing, loading, refresh };
}
