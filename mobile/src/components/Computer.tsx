import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Laptop } from "lucide-react-native";
import { FadingText } from "@/components/FadingText";
import { UPDATE, useMachine } from "@/lib/api";
import { useBehind, useOnline } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * The computer this device has paired with, by its name, and whether the
 * device reaches it: connected, out of reach, or which of the two to update
 * when the computer and the app speak different versions. It is the start of
 * a row, which whatever holds it sets out.
 */
export function Computer() {
  const theme = useTheme();
  const online = useOnline();
  const behind = useBehind();
  // The name stays while the screens change over a device that just disconnected.
  const name = useMachine();
  const kept = useRef(name);
  if (name) kept.current = name;
  const reached = online && !behind;
  return (
    <>
      <Laptop size={22} strokeWidth={2} color={theme.ink} />
      <View style={styles.text}>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={2}>
          {kept.current ?? "Your computer"}
        </Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: reached ? theme.ok : theme.ink2 }]} />
          <FadingText style={[styles.statusText, { color: theme.ink2 }]}>{behind ? UPDATE[behind] : online ? "Connected" : "Out of reach"}</FadingText>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  text: { flex: 1, gap: 3 },
  name: { fontSize: 17, lineHeight: 22 },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 14, lineHeight: 18 },
});
