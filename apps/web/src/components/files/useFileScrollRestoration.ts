import { useLayoutEffect, useState } from "react";

import { fileScrollVisit, installFileScrollRestoration } from "./fileScrollRestoration";

export function useFileScrollRestoration(
  identity: string,
  revealToken: string,
  revealLine: number | null,
) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [visit, setVisit] = useState(() => fileScrollVisit(identity, revealToken, revealLine));
  if (
    visit.identity !== identity ||
    visit.revealToken !== revealToken ||
    visit.requestedLine !== revealLine
  ) {
    setVisit(fileScrollVisit(identity, revealToken, revealLine));
  }
  useLayoutEffect(
    () => (root ? installFileScrollRestoration(root, visit) : undefined),
    [root, visit],
  );
  return { setRoot, restoredRevealLine: visit.revealLine };
}
