import { Pressable, StyleSheet } from "react-native";
import { FadingText } from "@/components/FadingText";
import { useTheme } from "@/lib/theme";

/** A word at the sheet's top, as Edit or Done. `strong` is the one that finishes. */
export function BarButton({ label, strong = false, disabled = false, onPress }: { label: string; strong?: boolean; disabled?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} hitSlop={10} style={({ pressed }) => ({ opacity: disabled ? 0.35 : pressed ? 0.6 : 1 })}>
      <FadingText style={[styles.barText, strong && styles.barStrong, { color: theme.tintInk }]}>{label}</FadingText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  barText: { fontSize: 17 },
  barStrong: { fontWeight: "600" },
});
