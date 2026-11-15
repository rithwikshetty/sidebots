import { useColorScheme } from "react-native";

const light = {
  dark: false,
  bg: "#FFFFFF",
  ink: "#000000",
  ink2: "#6D6D72",
  line: "#E5E5EA",
  field: "#F2F2F7",
  card: "#FFFFFF",
  faint: "rgba(0, 0, 0, 0.42)",
  bubble: "#E9E9EB",
  tint: "#66023C",
  tintInk: "#66023C",
  onTint: "#FFFFFF",
};

const dark: typeof light = {
  dark: true,
  bg: "#000000",
  ink: "#FFFFFF",
  ink2: "#98989F",
  line: "#2C2C2E",
  field: "#1C1C1E",
  card: "#1C1C1E",
  faint: "rgba(255, 255, 255, 0.38)",
  bubble: "#262629",
  tint: "#8A1F56",
  tintInk: "#E596BF",
  onTint: "#FFFFFF",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
