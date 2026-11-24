import { StyleSheet, Text, View } from "react-native";
import { PROVIDERS, selectionWords, type Message, type Selection, type Switched } from "@server/contract";
import { BrandLogo } from "@/components/BrandLogo";
import { FlowDot } from "@/components/FlowDot";
import { useTheme } from "@/lib/theme";

/**
 * The notice that the agent answers with something else from here on, as a
 * line across the chat: what it answered with before, faded, a row of dots,
 * and what it answers with now. Each side is the parts that changed. An
 * agent that moved to another provider shows all of both, each after its
 * provider's logo, and while it hands over to the new one the dots light in
 * turn.
 */
export function SwitchNotice({ message, switched: { from, to } }: { message: Message; switched: Switched }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={message.body} style={styles.row}>
      <View style={[styles.line, { backgroundColor: theme.line }]} />
      <Side selection={from} other={to} color={theme.faint} />
      <View style={styles.dots}>
        {[0, 1, 2].map((dot) => (
          <FlowDot key={dot} index={dot} running={message.status === "running"} size={3} color={theme.faint} />
        ))}
      </View>
      <Side selection={to} other={from} color={theme.ink2} strong />
      <View style={[styles.line, { backgroundColor: theme.line }]} />
    </View>
  );
}

/** One side of the change: the parts of `selection` that differ from `other`, after its provider's logo when the two are on different providers. */
function Side({ selection, other, color, strong = false }: { selection: Selection; other: Selection; color: string; strong?: boolean }) {
  return (
    <View style={styles.side}>
      {selection.provider === other.provider ? null : <BrandLogo logo={PROVIDERS[selection.provider].logo} size={14} />}
      <Text numberOfLines={1} style={[styles.words, { color }, strong && styles.strong]}>
        {selectionWords(selection, other).join(" · ")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 6 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  side: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  words: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  strong: { fontWeight: "600" },
  dots: { flexDirection: "row", gap: 4 },
});
