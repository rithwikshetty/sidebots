import { createContext, useContext, useRef, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Application from "expo-application";
import { useRouter } from "expo-router";
import { useDrawerProgress } from "react-native-drawer-layout";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUpRight, ChartNoAxesColumn, ChevronRight, Laptop, ShieldCheck, Unplug } from "lucide-react-native";
import { FadingText } from "@/components/FadingText";
import { confirmDisconnect } from "@/lib/alerts";
import { UPDATE, useMachine } from "@/lib/api";
import { openLink } from "@/lib/links";
import { useBehind, useOnline } from "@/lib/state";
import { useTheme } from "@/lib/theme";

const PRIVACY = "https://sidebots.app/privacy";
const ICON = 22;

/**
 * Opens the side menu from the screens that slide off it. `holdSwipe` keeps
 * the home screen's swipe right from opening it while something there, such
 * as a row with its actions showing, needs that swipe for itself.
 */
export const SideMenuContext = createContext<{ open(): void; holdSwipe(held: boolean): void }>({
  open() {},
  holdSwipe() {},
});

export function useSideMenu() {
  return useContext(SideMenuContext);
}

/**
 * The side menu the home screen slides aside to uncover: the computer this
 * phone has paired with and whether the phone reaches it, with Usage under
 * it, which opens what the agents on that computer used. At its foot are
 * the privacy policy, Disconnect and the app's version. Disconnect asks
 * first, has the computer forget the phone, and leaves the phone on the
 * welcome screen. The menu fades up from faint as the screens slide off it.
 */
export function SideMenu() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const progress = useDrawerProgress();
  const fade = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0, 1], [0.3, 1], "clamp") }));
  const online = useOnline();
  const behind = useBehind();
  // The name stays while the menu slides shut over a phone that just disconnected.
  const name = useMachine();
  const kept = useRef(name);
  if (name) kept.current = name;
  const machine = kept.current;
  const reached = online && !behind;

  return (
    <Animated.View style={[styles.menu, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) }, fade]}>
      <Text accessibilityRole="header" style={[styles.wordmark, { color: theme.ink }]}>
        Sidebots
      </Text>
      <View style={styles.computer}>
        <Laptop size={ICON} strokeWidth={2} color={theme.ink} />
        <View style={styles.computerText}>
          <Text style={[styles.label, { color: theme.ink }]} numberOfLines={2}>
            {machine ?? "Your computer"}
          </Text>
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: reached ? theme.ok : theme.ink2 }]} />
            <FadingText style={[styles.statusText, { color: theme.ink2 }]}>{behind ? UPDATE[behind] : online ? "Connected" : "Out of reach"}</FadingText>
          </View>
        </View>
      </View>
      <Row icon={ChartNoAxesColumn} label="Usage" color={theme.ink} onPress={() => router.push("/usage")}>
        <ChevronRight size={18} strokeWidth={2} color={theme.ink2} />
      </Row>
      <View style={styles.flex} />
      <Row icon={ShieldCheck} label="Privacy" color={theme.ink} onPress={() => void openLink(PRIVACY, theme)}>
        <ArrowUpRight size={18} strokeWidth={2} color={theme.ink2} />
      </Row>
      <Row icon={Unplug} label="Disconnect" color={theme.danger} onPress={() => confirmDisconnect(machine ?? "your computer")} />
      <Text style={[styles.version, { color: theme.ink2 }]}>
        {Application.applicationName} {Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
      </Text>
    </Animated.View>
  );
}

/** Something the menu does, as a row: its icon, its name, and anything that follows the name. */
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
      <Icon size={ICON} strokeWidth={2} color={color} />
      <Text style={[styles.label, styles.flex, { color }]}>{label}</Text>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  menu: { flex: 1, paddingHorizontal: 12 },
  wordmark: { fontSize: 22, lineHeight: 28, fontWeight: "600", paddingHorizontal: 12, paddingBottom: 18 },
  computer: { flexDirection: "row", gap: 14, paddingHorizontal: 12, paddingVertical: 10 },
  computerText: { flex: 1, gap: 3 },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 14, lineHeight: 18 },
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, borderCurve: "continuous" },
  label: { fontSize: 17, lineHeight: 22 },
  version: { fontSize: 13, paddingHorizontal: 12, paddingTop: 14 },
});
