import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";

/**
 * A fade from the page colour at the top of a screen, so content scrolling up
 * passes softly under the status bar and anything floating there. It is solid
 * down to `solid` points, then clears by `height`.
 */
export function TopFade({ height, solid }: { height: number; solid: number }) {
  const theme = useTheme();
  return <View pointerEvents="none" style={[styles.fade, { height, backgroundImage: `linear-gradient(to bottom, ${theme.bg} ${solid}px, ${theme.bg}00)` }]} />;
}

const styles = StyleSheet.create({
  fade: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 1 },
});
