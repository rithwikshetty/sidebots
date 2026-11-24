import { useState } from "react";
import { CHANGE_MS, LINES } from "@client/lines";
import { useBeat } from "./motion";

/** A playful line to show while an agent works. It changes every few seconds while it is `shown`. */
export function useWorkingLine(shown = true): string {
  const [first] = useState(() => Math.floor(Math.random() * LINES.length));
  return LINES[(first + useBeat(CHANGE_MS, shown)) % LINES.length];
}
