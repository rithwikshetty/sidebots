import type { ComponentType, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpRight, Cable, ChartNoAxesColumn, ChevronRight, ShieldCheck, Unplug } from "lucide-react-native";
import { Computer } from "@/components/Computer";
import { Rule, Section } from "@/components/Section";
import { confirmDisconnect } from "@/lib/alerts";
import { useMachine } from "@/lib/api";
import { openLink } from "@/lib/links";
import { useTheme } from "@/lib/theme";

const PRIVACY = "https://sidebots.app/privacy";

/**
 * Settings, a sheet the computer at the foot of the agents opens. It leads
 * with the computer this phone has paired with and whether the phone reaches
 * it. Under that are Usage, which opens what the agents on that computer
 * used, and Connections, which opens the apps those agents can use as the
 * person. Then the privacy policy and Disconnect, with the app's version
 * below. Disconnect asks first, has the computer forget the phone, and
 * leaves the phone on the welcome screen.
 */
export default function Settings() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const machine = useMachine();
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
          Settings
        </Text>
        <Section>
          <View style={styles.row}>
            <Computer />
          </View>
        </Section>
        <Section>
          <Row icon={ChartNoAxesColumn} label="Usage" color={theme.ink} onPress={() => router.push("/usage")}>
            <ChevronRight size={18} strokeWidth={2} color={theme.ink2} />
          </Row>
          <Rule />
          <Row icon={Cable} label="Connections" color={theme.ink} onPress={() => router.push("/connections")}>
            <ChevronRight size={18} strokeWidth={2} color={theme.ink2} />
          </Row>
        </Section>
        <Section note={`${Application.applicationName} ${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`}>
          <Row icon={ShieldCheck} label="Privacy" color={theme.ink} onPress={() => void openLink(PRIVACY, theme)}>
            <ArrowUpRight size={18} strokeWidth={2} color={theme.ink2} />
          </Row>
          <Rule />
          <Row icon={Unplug} label="Disconnect" color={theme.danger} onPress={() => confirmDisconnect(machine ?? "your computer")} />
        </Section>
      </ScrollView>
    </View>
  );
}

/** Something Settings does, as a row: its icon, its name, and anything that follows the name. */
function Row({
  icon: Icon,
  label,
  color,
  onPress,
  children,
}: {
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  label: string;
  color: string;
  onPress(): void;
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.line : "transparent" }]}>
      <Icon size={22} strokeWidth={2} color={color} />
      <Text style={[styles.label, { color }]}>{label}</Text>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  page: { paddingHorizontal: 20 },
  // Done stays at the sheet's top while the page scrolls under it.
  done: { alignSelf: "flex-end", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: 0.2 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10 },
  label: { flex: 1, fontSize: 17, lineHeight: 22 },
});
