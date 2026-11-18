import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { EASE } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

/**
 * A part of a whole, from 0 to 1, as the filled length of a track: how much
 * of a limit is left, or an agent's share of what every agent used. `label`
 * says what it measures. The fill eases to its new length as the part changes.
 */
export function Bar({ part, label }: { part: number; label: string }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const within = Math.min(Math.max(part, 0), 1);
  const filled = within * width;
  const fill = useAnimatedStyle(() => ({ width: withTiming(filled, EASE) }));
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(within * 100) }}
      style={[styles.track, { backgroundColor: theme.line }]}>
      {/* Drawn once the track's width is known, so the fill starts at its length. */}
      {width ? <Animated.View style={[styles.fill, { backgroundColor: theme.tint }, fill]} /> : null}
    </View>
  );
}

const HEIGHT = 6;

const styles = StyleSheet.create({
  track: { height: HEIGHT, borderRadius: HEIGHT / 2, overflow: "hidden" },
  fill: { height: HEIGHT, borderRadius: HEIGHT / 2 },
});
