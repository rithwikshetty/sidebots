import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAbout } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * Something an agent wrote for itself, to read in full: the instructions it
 * follows, or with `memory` one of the things it remembers.
 */
export default function Note() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { agent, memory } = useLocalSearchParams<{ agent: string; memory?: string }>();
  const about = useAbout(agent);
  const remembered = memory ? about?.memories.find((each) => each.name === memory) : undefined;
  const title = memory ? remembered?.description || memory : "Instructions";
  const body = memory ? remembered?.body : about?.instructions.trim();
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]}>
        <Text style={[styles.title, { color: theme.ink }]}>{title}</Text>
        <Text selectable style={[styles.body, { color: theme.ink }]}>
          {body}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  page: { paddingHorizontal: 20, gap: 12 },
  // Done stays at the sheet's top while the note scrolls under it.
  done: { alignSelf: "flex-end", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  title: { fontSize: 22, fontWeight: "700", lineHeight: 28 },
  body: { fontSize: 16, lineHeight: 23 },
});
