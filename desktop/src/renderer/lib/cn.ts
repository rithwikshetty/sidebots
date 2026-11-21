import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The window's own shadows, text sizes and corners, so a class that sets one replaces another, and none is taken for a colour.
const merge = extendTailwindMerge({ extend: { theme: { shadow: ["menu", "dialog", "sheet", "control"], text: ["message"], radius: ["bubble"] } } });

/** Tailwind classes joined, where a later class wins over an earlier one that sets the same thing. */
export function cn(...classes: ClassValue[]): string {
  return merge(clsx(classes));
}
