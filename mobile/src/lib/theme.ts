import { createContext, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

const light = {
  dark: false,
  bg: "#FFFFFF",
  ink: "#000000",
  ink2: "#6D6D72",
  line: "#E5E5EA",
  field: "#F2F2F7",
  card: "#FFFFFF",
  // What sits raised on a field, as the selected tab, set apart from the field in either mode.
  raised: "#FFFFFF",
  faint: "rgba(0, 0, 0, 0.42)",
  bubble: "#E9E9EB",
  tint: "#1F5FD6",
  tintInk: "#1F5FD6",
  onTint: "#FFFFFF",
  // Something that went wrong, or that can't be undone.
  danger: "#D0342C",
  // Something that is working, as a computer within reach.
  ok: "#2E9E4F",
  // The camera and the photo viewer: a picture on black with white controls, in either mode.
  viewer: "#000000",
  viewerInk: "#FFFFFF",
  viewerControl: "rgba(255, 255, 255, 0.14)",
  // A shade over a photo, under the viewer's white marks.
  scrim: "rgba(0, 0, 0, 0.45)",
};

const dark: typeof light = {
  dark: true,
  bg: "#000000",
  ink: "#FFFFFF",
  ink2: "#98989F",
  line: "#2C2C2E",
  field: "#1C1C1E",
  card: "#1C1C1E",
  raised: "#3A3A3C",
  faint: "rgba(255, 255, 255, 0.38)",
  bubble: "#262629",
  tint: "#2A62D4",
  tintInk: "#7EAAFF",
  onTint: "#FFFFFF",
  danger: "#FF5A4F",
  ok: "#34C759",
  viewer: "#000000",
  viewerInk: "#FFFFFF",
  viewerControl: "rgba(255, 255, 255, 0.14)",
  scrim: "rgba(0, 0, 0, 0.5)",
};

export type Theme = typeof light;

/**
 * The colours an agent's chat can have, beside its avatar's own. Each takes
 * white text at 4.5:1 or more, in light and dark.
 */
export const CHAT_COLORS = [
  { color: "#1F5FD6", name: "Blue" },
  { color: "#0B7A6A", name: "Teal" },
  { color: "#2E7D32", name: "Green" },
  { color: "#B85409", name: "Amber" },
  { color: "#C62828", name: "Red" },
  { color: "#C2185B", name: "Pink" },
  { color: "#6A4BC4", name: "Violet" },
  { color: "#7B5233", name: "Brown" },
  { color: "#3A3A3C", name: "Graphite" },
];

const ChatTint = createContext<string | null>(null);

/**
 * Gives what is inside it one agent's chat colour, as its `tint`: the
 * person's messages, the send button and dictation. Back, links and the rest
 * stay the app's blue.
 */
export const ChatColor = ChatTint.Provider;

export function useTheme(): Theme {
  const theme = useColorScheme() === "dark" ? dark : light;
  const chat = useContext(ChatTint);
  return useMemo(() => (chat ? { ...theme, tint: chat } : theme), [theme, chat]);
}
