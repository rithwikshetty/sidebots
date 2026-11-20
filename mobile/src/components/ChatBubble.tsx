import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";

/**
 * The bubble a message is said in. What is `mine` is in the chat's colour,
 * with its tail at the right, as the person's messages are in a chat with an
 * agent. Anything else is grey, with its tail at the left.
 */
export function ChatBubble({ mine, children }: { mine: boolean; children: ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.bubble, mine ? [styles.mine, { backgroundColor: theme.tint }] : [styles.theirs, { backgroundColor: theme.bubble }]]}>{children}</View>;
}

const styles = StyleSheet.create({
  bubble: { maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  mine: { borderBottomRightRadius: 6 },
  theirs: { borderBottomLeftRadius: 6 },
});
