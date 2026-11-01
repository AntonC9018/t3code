import { useEffect, useRef } from "react";

/** A ref holding the latest render's value, for listeners that outlive the render. */
export function useLatestRef<T>(value: T) {
  const latest = useRef(value);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the ref that window and DOM listeners read in step with the latest render
  useEffect(() => {
    latest.current = value;
  });
  return latest;
}
