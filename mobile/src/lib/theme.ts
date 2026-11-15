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
  tint: "#66023C",
  tintInk: "#66023C",
  onTint: "#FFFFFF",
  // Something that went wrong, or that can't be undone.
  danger: "#D0342C",
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
  tint: "#8A1F56",
  tintInk: "#E596BF",
  onTint: "#FFFFFF",
  danger: "#FF5A4F",
  viewer: "#000000",
  viewerInk: "#FFFFFF",
  viewerControl: "rgba(255, 255, 255, 0.14)",
  scrim: "rgba(0, 0, 0, 0.5)",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
