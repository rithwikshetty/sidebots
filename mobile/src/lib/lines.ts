import { useEffect, useState } from "react";

const LINES = [
  "Consulting the augurs",
  "Crossing the Rubicon",
  "Sending a rider to Gaul",
  "Asking the Senate nicely",
  "Sharpening the stylus",
  "Counting the legions",
  "Paving a road there first",
  "Reading the omens",
];
const CHANGE_MS = 2800;

/** One of the playful lines, for where it can't change, as in a Live Activity. */
export function workingLine(): string {
  return LINES[Math.floor(Math.random() * LINES.length)];
}

/** A playful line to show while an agent works. It changes every few seconds. */
export function useWorkingLine(): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * LINES.length));
  useEffect(() => {
    const timer = setInterval(() => setIndex((current) => (current + 1) % LINES.length), CHANGE_MS);
    return () => clearInterval(timer);
  }, []);
  return LINES[index];
}
