import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { EASE } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

const PAD = 4;
const GAP = 4;
// A choice's word fits its fixed height and its share of the row up to this text size.
const MAX_SCALE = 1.3;

/**
 * A row of choices where one is in effect, as for an agent's model or
 * effort. The mark behind the choice in effect slides to a new one as it is
 * picked, as the system's segmented control does. The mark is the app's
 * colour; a `plain` row, as for tabs, has a raised light mark instead, so it
 * reads as a place to go rather than a setting.
 */
export function Choices<Id extends string>({
  options,
  value,
  onChange,
  plain = false,
}: {
  options: Partial<Record<Id, string>>;
  value: Id;
  onChange: (value: Id) => void;
  plain?: boolean;
}) {
  const theme = useTheme();
  const ids = Object.keys(options) as Id[];
  const [width, setWidth] = useState(0);
  const cell = (width - PAD * 2 - GAP * (ids.length - 1)) / ids.length;
  const at = Math.max(ids.indexOf(value), 0);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: withTiming(at * (cell + GAP), EASE) }] }));
  return (
    <View style={styles.choices} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {/* Drawn once the row's width is known, so the mark starts on the choice in effect. */}
      {width ? <Animated.View style={[styles.mark, plain ? [styles.raised, { backgroundColor: theme.raised }] : { backgroundColor: theme.tint }, { width: cell }, slide]} /> : null}
      {ids.map((id) => (
        <Pressable key={id} onPress={() => onChange(id)} accessibilityRole="button" accessibilityState={{ selected: id === value }} style={styles.choice}>
          <Text maxFontSizeMultiplier={MAX_SCALE} style={[styles.choiceText, { color: id === value && !plain ? theme.onTint : theme.ink }]}>{options[id]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: "row", padding: PAD, gap: GAP },
  mark: { position: "absolute", top: PAD, left: PAD, height: 38, borderRadius: 12, borderCurve: "continuous" },
  raised: { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  choice: { flex: 1, height: 38, alignItems: "center", justifyContent: "center" },
  choiceText: { fontSize: 15, fontWeight: "600" },
});
