/** The playful lines an app shows while an agent works. */
export const LINES = [
  "Consulting the augurs",
  "Crossing the Rubicon",
  "Sending a rider to Gaul",
  "Asking the Senate nicely",
  "Sharpening the stylus",
  "Counting the legions",
  "Paving a road there first",
  "Reading the omens",
];
/** How long a line shows before the next, where it changes. */
export const CHANGE_MS = 2800;

/** One of the playful lines, for where it can't change, as in a Live Activity. */
export function workingLine(): string {
  return LINES[Math.floor(Math.random() * LINES.length)];
}
