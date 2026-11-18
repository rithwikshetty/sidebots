import type { ComponentProps, ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { FadingText } from "@/components/FadingText";
import { HIDE, MOVE, SHOW } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

/**
 * A group of rows on a card, under its title, with a line of help below. A
 * group with no rows shows only its title and help. The card and the help
 * fade in and out as rows come and go, and the group slides as it changes size.
 */
export function Section({ title, note, children }: { title?: string; note?: string; children?: ReactNode }) {
  const theme = useTheme();
  const rows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <Animated.View layout={MOVE} style={styles.section}>
      {title ? <SectionTitle>{title}</SectionTitle> : null}
      {rows ? (
        <Animated.View entering={SHOW} exiting={HIDE} layout={MOVE} style={[styles.card, { backgroundColor: theme.field }]}>
          {children}
        </Animated.View>
      ) : null}
      {note ? <FadingText style={[styles.note, { color: theme.ink2 }]}>{note}</FadingText> : null}
    </Animated.View>
  );
}

/** The small title over a group, or over anything set out as one. */
export function SectionTitle({ style, ...props }: ComponentProps<typeof Text>) {
  const theme = useTheme();
  return <Text {...props} style={[styles.title, { color: theme.ink2 }, style]} />;
}

/** The hairline between two rows of a card. */
export function Rule() {
  const theme = useTheme();
  return <View style={[styles.rule, { backgroundColor: theme.line }]} />;
}

const styles = StyleSheet.create({
  section: { marginTop: 24, gap: 8 },
  title: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  card: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
