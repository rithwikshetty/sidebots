import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/lib/theme";

// The page keeps to a large phone's width, centred in a wider window.
const COLUMN = 480;

/**
 * A step of setting the phone up, as the welcome screen and the steps after
 * pairing are: a picture, a title and a few words in the middle of the
 * screen, what the step shows under them, and its buttons at the foot.
 */
export function SetupPage({ art, title, lead, children, actions }: { art: ReactNode; title: string; lead: string; children?: ReactNode; actions: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.column}>
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.art}>{art}</View>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>{title}</Text>
          <Text style={[styles.lead, { color: theme.ink2 }]}>{lead}</Text>
          {children}
        </ScrollView>
        <View style={styles.actions}>{actions}</View>
      </View>
    </View>
  );
}

/** A step's button: the one thing to do, filled with the app's colour, or a `quiet` one under it in words alone. */
export function SetupButton({ children, quiet = false, onPress }: { children: string; quiet?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, quiet ? null : { backgroundColor: theme.tint }, { opacity: pressed ? 0.75 : 1 }]}>
      <Text style={[styles.buttonText, { color: quiet ? theme.tintInk : theme.onTint }]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center" },
  column: { flex: 1, width: "100%", maxWidth: COLUMN },
  page: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 24 },
  art: { alignItems: "center" },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginTop: 20 },
  lead: { fontSize: 17, lineHeight: 23, textAlign: "center", marginTop: 8 },
  actions: { gap: 4, marginHorizontal: 24 },
  button: { minHeight: 50, borderRadius: 14, borderCurve: "continuous", alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
