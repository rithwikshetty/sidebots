import { useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "@/lib/theme";

/**
 * The surface of something that floats over the content: a bar button the
 * app draws itself, or a pill. It is Liquid Glass tinted with the card colour,
 * and `interactive` glass answers a touch as the system's does. An iOS without
 * Liquid Glass gets the card itself with a hairline edge, and an `interactive`
 * card dims while a finger is on it.
 */
export function Glass({ interactive = false, style, children }: { interactive?: boolean; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const theme = useTheme();
  const [touched, setTouched] = useState(false);
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} tintColor={theme.card} style={style}>
        {children}
      </GlassView>
    );
  }
  const release = () => setTouched(false);
  return (
    <View
      onTouchStart={interactive ? () => setTouched(true) : undefined}
      onTouchEnd={interactive ? release : undefined}
      onTouchCancel={interactive ? release : undefined}
      style={[styles.card, { backgroundColor: theme.card, borderColor: theme.line }, style, touched && styles.touched]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth },
  touched: { opacity: 0.7 },
});
