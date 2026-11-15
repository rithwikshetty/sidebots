import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";

/**
 * A fade from the page colour at the top or bottom edge of a screen, so
 * content scrolling past passes softly under the status bar, the home
 * indicator and anything floating there. It is solid for `solid` points from
 * the edge, then clears by `height`. The top fade sits above the content it
 * covers; the bottom one draws where it is placed, under what follows it.
 */
export function EdgeFade({ edge, height, solid }: { edge: "top" | "bottom"; height: number; solid: number }) {
  const theme = useTheme();
  const direction = edge === "top" ? "to bottom" : "to top";
  return (
    <View
      pointerEvents="none"
      style={[styles.fade, styles[edge], { height, backgroundImage: `linear-gradient(${direction}, ${theme.bg} ${solid}px, ${theme.bg}00)` }]}
    />
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0 },
  top: { top: 0, zIndex: 1 },
  bottom: { bottom: 0 },
});
