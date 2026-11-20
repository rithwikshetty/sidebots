import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { FadingText } from "@/components/FadingText";
import { FlowDot } from "@/components/FlowDot";
import { HIDE, SHOW } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

/**
 * Dots beside a line that says what a chat waits on, fading in as the wait
 * starts and out as it ends. While it is `running` the dots light in turn,
 * and otherwise they rest.
 */
export function WorkingLine({ children, running = true }: { children: string; running?: boolean }) {
  const theme = useTheme();
  return (
    <Animated.View entering={SHOW} exiting={HIDE} style={styles.row}>
      <View style={styles.flow}>
        {[0, 1, 2].map((dot) => (
          <FlowDot key={dot} index={dot} running={running} size={4} color={theme.ink2} />
        ))}
      </View>
      <FadingText style={[styles.text, { color: theme.ink2 }]}>{children}</FadingText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, paddingLeft: 4 },
  text: { fontSize: 15, fontStyle: "italic", flexShrink: 1 },
  flow: { flexDirection: "row", gap: 4 },
});
