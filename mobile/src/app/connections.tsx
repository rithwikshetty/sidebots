import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import type { Connected } from "@server/contract";
import { ConnectionLogo } from "@/components/ConnectionLogo";
import { FadingText } from "@/components/FadingText";
import { Rule, Section } from "@/components/Section";
import { confirmRemoveConnection, problem } from "@/lib/alerts";
import { ApiError, UPDATE } from "@/lib/api";
import { haptics } from "@/lib/haptics";
import { SHOW } from "@/lib/motion";
import { connect, loadConnections, useConnections } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * The apps the person's agents can use as them, opened from the side menu:
 * each with its logo and what connecting it lets the agents do, or the account it is
 * connected as, and a button that connects it through the app's own sign-in
 * or removes it. It opens on what the phone last had, and what the computer
 * then says fades in.
 */
export default function ConnectionsPage() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const connections = useConnections();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    loadConnections().catch((reason) => {
      // A Sidebots on the computer that has no connections answers that it has no such thing.
      if (reason instanceof ApiError && reason.status === 404) return setFailure(`${UPDATE.computer} to connect your apps.`);
      setFailure(reason instanceof Error ? reason.message : "Something went wrong.");
    });
  }, []);
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
      <LayoutAnimationConfig skipEntering>
        <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
            Connections
          </Text>
          {connections ? (
            <Animated.View entering={SHOW}>
              <Section note="An app you connect is there for all your agents. You sign in on the app's own page, and what it gives Sidebots stays on your computer.">
                {connections.map((connected, index) => (
                  <View key={connected.connection}>
                    {index > 0 ? <Rule /> : null}
                    <ConnectionRow connected={connected} />
                  </View>
                ))}
              </Section>
            </Animated.View>
          ) : failure ? (
            <FadingText style={[styles.failure, { color: theme.ink2 }]}>{failure}</FadingText>
          ) : null}
        </ScrollView>
      </LayoutAnimationConfig>
    </View>
  );
}

/** One app: its logo, its name, what connecting it allows or the account it is connected as, and Connect or Remove. */
function ConnectionRow({ connected }: { connected: Connected }) {
  const theme = useTheme();
  const [connecting, setConnecting] = useState(false);
  const onPress = () => {
    haptics.select();
    if (connected.account) return confirmRemoveConnection(connected);
    setConnecting(true);
    connect(connected.connection)
      .catch((reason) => problem("Couldn't connect", reason))
      .finally(() => setConnecting(false));
  };
  return (
    <View style={styles.row}>
      <ConnectionLogo logo={connected.logo} size={LOGO} />
      <View style={styles.about}>
        <Text style={[styles.name, { color: theme.ink }]}>{connected.name}</Text>
        <FadingText style={[styles.note, { color: theme.ink2 }]}>{connected.account ? `Connected as ${connected.account}` : connected.allows}</FadingText>
      </View>
      <Pressable onPress={onPress} disabled={connecting} accessibilityRole="button" hitSlop={10} style={({ pressed }) => ({ opacity: pressed || connecting ? 0.6 : 1 })}>
        <FadingText style={[styles.action, { color: connected.account ? theme.danger : theme.tintInk }]}>{connected.account ? "Remove" : "Connect"}</FadingText>
      </Pressable>
    </View>
  );
}

const LOGO = 28;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  page: { paddingHorizontal: 20 },
  // Done stays at the sheet's top while the page scrolls under it.
  done: { alignSelf: "flex-end", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: 0.2 },
  failure: { fontSize: 15, lineHeight: 20, marginTop: 24, paddingHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  about: { flex: 1, gap: 3 },
  name: { fontSize: 16, lineHeight: 21 },
  note: { fontSize: 14, lineHeight: 19 },
  action: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
});
