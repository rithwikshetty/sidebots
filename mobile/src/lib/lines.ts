import { useEffect, useState } from "react";
import { CHANGE_MS, LINES } from "@client/lines";

/** A playful line to show while an agent works. It changes every few seconds. */
export function useWorkingLine(): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * LINES.length));
  useEffect(() => {
    const timer = setInterval(() => setIndex((current) => (current + 1) % LINES.length), CHANGE_MS);
    return () => clearInterval(timer);
  }, []);
  return LINES[index];
}
