import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { EASE } from "@/lib/motion";
import { CHAT_COLORS, useTheme } from "@/lib/theme";

/**
 * The colours an agent's chat can have, as round swatches, with the chosen one
 * ringed. The first is the avatar's own colour, which `value` null means and
 * which follows the avatar when it changes. The ring fades from one swatch to
 * the next, as the avatar tiles' outline does.
 */
export function ColorPicker({ value, avatarColor, onChange }: { value: string | null; avatarColor: string | null; onChange: (color: string | null) => void }) {
  const others = CHAT_COLORS.filter(({ color }) => color !== avatarColor);
  return (
    <View style={styles.swatches}>
      {avatarColor ? <Swatch color={avatarColor} label="The avatar's colour" chosen={value === null || value === avatarColor} onPress={() => onChange(null)} /> : null}
      {others.map(({ color, name }) => (
        <Swatch key={color} color={color} label={name} chosen={value === color} onPress={() => onChange(color)} />
      ))}
    </View>
  );
}

function Swatch({ color, label, chosen, onPress }: { color: string; label: string; chosen: boolean; onPress: () => void }) {
  const theme = useTheme();
  const ring = useAnimatedStyle(() => ({ opacity: withTiming(chosen ? 1 : 0, EASE) }));
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: chosen }} style={styles.swatch}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.ring, { borderColor: theme.ink }, ring]} />
      <View style={[styles.fill, { backgroundColor: color }]} />
    </Pressable>
  );
}

const SWATCH = 44;

const styles = StyleSheet.create({
  swatches: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  swatch: { width: SWATCH, height: SWATCH, alignItems: "center", justifyContent: "center" },
  ring: { borderRadius: SWATCH / 2, borderWidth: 2 },
  fill: { width: SWATCH - 10, height: SWATCH - 10, borderRadius: (SWATCH - 10) / 2 },
});
